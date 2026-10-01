// Tolkar en uppladdning från inkorgen och gör om den till ett förslag i kön.
import { store, uploads, KEYS } from "./store.mjs";
import { loadInventory } from "./inventory.mjs";
import { updateProposal } from "./pending.mjs";
import { applyZoneRules } from "./rules.mjs";
import { parseReceiptPdf, parseReceiptText, parsePhoto, parseRecipe } from "./claude.mjs";
import { loadRecipes, saveRecipes, makeRecipe } from "./recipes.mjs";

const MAX_IMAGE_PX = 1600;

// Utbytbart i tester, så att Claude inte anropas.
export const deps = { parseRecipe };

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
      styles: l.styles ?? [],
      role: l.role ?? null,
      kind: l.kind ?? null,
      packageSize: l.packageSize ?? null,
      decision: null,
    };
    // Tidigare bekräftad koppling artikelnummer → vara vinner över tolkningen.
    // Äldre kopplingar saknar taggar; då behålls Claudes taggar.
    if (known && l.isFood) {
      line = {
        ...line,
        ...known,
        styles: known.styles?.length ? known.styles : line.styles,
        role: known.role ?? line.role,
        kind: known.kind ?? line.kind,
        packageSize: known.packageSize ?? line.packageSize,
        confidence: "sure",
        alternatives: [],
      };
    }
    return l.isFood ? applyZoneRules(line) : line;
  });
}

// scope "part": bara det som syns räknas. "full": hela zonen är fotad, så det som
// inte syns i någon bild föreslås som troligen slut.
export function photoLines(photo, inventory, { scope = "part" } = {}) {
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
      styles: s.styles ?? [],
      role: s.role ?? null,
      kind: s.kind ?? null,
      decision: null,
    };
  });
  if (scope !== "full") return lines;
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
    p.startedAt = new Date().toISOString();
    p.error = null;
  });
  try {
    const upload = await uploads.getBinary(id);
    if (!upload) throw new Error("Uppladdningen saknas");
    const { kind, mediaType, zone, scope = "part", count = 1, purpose = "auto" } = upload.metadata;
    const articles = (await store.get(KEYS.articles)) ?? {};

    const loadImages = async () => {
      const raw = [{ data: upload.data, mediaType }];
      for (let i = 1; i < count; i++) {
        const part = await uploads.getBinary(`${id}.${i}`);
        if (part) raw.push({ data: part.data, mediaType: part.metadata.mediaType });
      }
      const images = [];
      for (const r of raw) {
        const img = await shrinkImage(r.data, r.mediaType);
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(img.mediaType)) {
          throw new Error("Bildformatet stöds inte (troligen HEIC). Lägg till \"Konvertera bild\" till JPEG i genvägen.");
        }
        images.push(img);
      }
      return images;
    };

    let meta, lines, source;
    if (purpose === "recipe") {
      // Recept ändrar inte lagret – de sparas direkt i receptbanken.
      const inventory = await loadInventory();
      const pantry = [...new Set(inventory.items.filter((i) => i.status !== "out").map((i) => i.name))].slice(0, 200);
      const parsed = await deps.parseRecipe({
        images: kind === "image" ? await loadImages() : [],
        pdf: kind === "pdf" ? upload.data : null,
        text: kind === "text" ? upload.data.toString("utf8") : null,
        pantry,
      });
      if (!parsed.isRecipe || !parsed.ingredients.length) throw new Error("Hittade inget recept i det som skickades");
      const recipe = makeRecipe({ ...parsed, source: "import" });
      const recipes = await loadRecipes();
      recipes.push(recipe);
      await saveRecipes(recipes);
      source = "recipe";
      meta = { recipeId: recipe.id, title: recipe.title, servings: recipe.servings };
      lines = [];
    } else if (kind === "pdf" || kind === "text") {
      const receipt =
        kind === "pdf"
          ? await parseReceiptPdf(upload.data, { articles })
          : await parseReceiptText(upload.data.toString("utf8"), { articles });
      source = "receipt";
      meta = { store: receipt.store, date: receipt.date, total: receipt.total };
      lines = receiptLines(receipt, articles);
    } else if (kind === "image") {
      const inventory = await loadInventory();
      const images = await loadImages();
      const photo = await parsePhoto(images, { zone, inventory: inventory.items });
      if (zone) photo.zone = zone;
      source = "photo";
      meta = { zone: photo.zone, scope, photos: images.length };
      lines = photoLines(photo, inventory, { scope });
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

// Starta en bakgrundsfunktion. Svarar 202 direkt. Returnerar felet, eller null.
export async function triggerBackground(req, name, body) {
  const origin = new URL(req.url).origin;
  try {
    const res = await fetch(`${origin}/.netlify/functions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.INGEST_KEY },
      body: JSON.stringify(body),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    return e.message;
  }
}

// Starta process-background för ett jobb i inkorgen.
export async function startBackground(req, id) {
  const problem = await triggerBackground(req, "process-background", { id });
  if (problem) {
    console.error("Kunde inte starta bakgrundstolkning", id, problem);
    await updateProposal(id, (p) => {
      p.status = "error";
      p.error = `Bakgrundstolkningen startade inte (${problem})`;
    });
  }
}
