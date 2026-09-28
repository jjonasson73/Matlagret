// Tolkar en uppladdning från inkorgen och gör om den till ett förslag i kön.
import { store, uploads, KEYS } from "./store.mjs";
import { loadInventory } from "./inventory.mjs";
import { updateProposal } from "./pending.mjs";
import { applyZoneRules } from "./rules.mjs";
import { parseReceiptPdf, parseReceiptText, parsePhoto } from "./claude.mjs";

const MAX_IMAGE_PX = 1600;

async function shrinkImage(data, mediaType) {
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(data)
      .rotate()
      .resize(MAX_IMAGE_PX, MAX_IMAGE_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { data: out, mediaType: "image/jpeg" };
  } catch (e) {
    console.warn("Kunde inte krympa bilden, skickar originalet:", e.message);
    return { data, mediaType };
  }
}

export function receiptLines(receipt, articles) {
  return receipt.lines.map((l, i) => {
    const known = l.articleNo && articles[l.articleNo];
    let line = {
      lineId: String(i),
      action: l.isFood ? "add" : "skip",
      raw: l.raw,
      articleNo: l.articleNo,
      name: l.name,
      category: l.category,
      zone: l.zone,
      qty: l.qty,
      unit: l.unit,
      price: l.price,
      confidence: l.confidence,
      alternatives: l.alternatives,
      note: l.note,
      bestBefore: null,
      decision: null,
    };
    // Tidigare bekräftad koppling artikelnummer → vara vinner över tolkningen.
    if (known && l.isFood) line = { ...line, ...known, confidence: "sure", alternatives: [] };
    return l.isFood ? applyZoneRules(line) : line;
  });
}

export function photoLines(photo, inventory) {
  const zoneItems = inventory.items.filter((i) => i.zone === photo.zone && i.status === "active");
  const seenIds = new Set();
  const lines = photo.seen.map((s, i) => {
    const match = s.inventoryId && zoneItems.find((it) => it.id === s.inventoryId);
    if (match) seenIds.add(match.id);
    return {
      lineId: String(i),
      action: match ? "confirm" : "add",
      itemId: match ? match.id : null,
      name: match ? match.name : s.name,
      category: s.category,
      zone: photo.zone,
      qty: s.qty,
      unit: s.unit,
      confidence: match ? s.confidence : s.confidence === "sure" ? "likely" : s.confidence,
      alternatives: s.alternatives,
      bestBefore: s.bestBefore,
      decision: null,
    };
  });
  // Finns i lagret men syns inte → föreslå probably_out, ta aldrig bort.
  for (const item of zoneItems) {
    if (seenIds.has(item.id)) continue;
    lines.push({
      lineId: "out-" + item.id,
      action: "probably_out",
      itemId: item.id,
      name: item.name,
      category: item.category,
      zone: item.zone,
      qty: item.qty,
      unit: item.unit,
      confidence: "unsure",
      alternatives: [],
      decision: null,
    });
  }
  return lines;
}

export async function processJob(id) {
  await updateProposal(id, (p) => {
    p.status = "processing";
    p.error = null;
  });
  try {
    const upload = await uploads.getBinary(id);
    if (!upload) throw new Error("Uppladdningen saknas");
    const { kind, mediaType, zone } = upload.metadata;
    const articles = (await store.get(KEYS.articles)) ?? {};

    let meta, lines, source;
    if (kind === "pdf" || kind === "text") {
      const receipt =
        kind === "pdf"
          ? await parseReceiptPdf(upload.data, { articles })
          : await parseReceiptText(upload.data.toString("utf8"), { articles });
      source = "receipt";
      meta = { store: receipt.store, date: receipt.date, total: receipt.total };
      lines = receiptLines(receipt, articles);
    } else if (kind === "image") {
      const inventory = await loadInventory();
      const img = await shrinkImage(upload.data, mediaType);
      if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(img.mediaType)) {
        throw new Error("Bildformatet stöds inte (troligen HEIC). Lägg till \"Konvertera bild\" till JPEG i genvägen.");
      }
      const photo = await parsePhoto(img.data, img.mediaType, { zone, inventory: inventory.items });
      if (zone) photo.zone = zone;
      source = "photo";
      meta = { zone: photo.zone };
      lines = photoLines(photo, inventory);
    } else {
      throw new Error(`Okänd typ: ${kind}`);
    }

    return await updateProposal(id, (p) => {
      Object.assign(p, { status: "ready", source, meta, lines });
    });
  } catch (e) {
    console.error("Tolkning misslyckades", id, e);
    return await updateProposal(id, (p) => {
      p.status = "error";
      p.error = e.message;
    });
  }
}

// Starta process-background för ett jobb. Svarar 202 direkt.
export async function startBackground(req, id) {
  const origin = new URL(req.url).origin;
  try {
    await fetch(`${origin}/.netlify/functions/process-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.INGEST_KEY },
      body: JSON.stringify({ id }),
    });
  } catch (e) {
    console.error("Kunde inte starta bakgrundstolkning", e);
  }
}
