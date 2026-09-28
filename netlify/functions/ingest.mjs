// POST /api/ingest – inkorgen. Tar emot PDF, bild eller text (multipart, fält "file"
// eller "text", valfritt "zone"), sparar råfilen och lägger ett förslag i kön.
// Själva tolkningen sker i process-background så att svaret kommer direkt.
import { uploads } from "../lib/store.mjs";
import { json, error, checkKey, newId } from "../lib/http.mjs";
import { loadPending, savePending } from "../lib/pending.mjs";
import { processJob, startBackground } from "../lib/process.mjs";
import { ZONES } from "../lib/rules.mjs";

const MAX_BYTES = 20 * 1024 * 1024;

// Känn igen filen på innehållet först – genvägen skickar inte alltid rätt typ.
export function sniff(data) {
  const head = data.subarray(0, 12);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return "image/heic";
  return null;
}

// Genvägen kan råka skicka filens namn i stället för filen (variabelegenskapen "Namn").
const looksLikeFilename = (text) => text.length < 200 && !text.includes("\n") && /\.(pdf|jpe?g|png|heic|webp)$/i.test(text.trim());

function detectKind(type, name = "") {
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (type?.startsWith("image/") || /\.(jpe?g|png|heic|webp)$/i.test(name)) return "image";
  if (type?.startsWith("text/") || /\.txt$/i.test(name)) return "text";
  return null;
}

async function readUpload(req) {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.startsWith("multipart/form-data") || ct.startsWith("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const zone = form.get("zone") || null;
    const file = form.get("file");
    if (file && typeof file === "object") {
      const data = Buffer.from(await file.arrayBuffer());
      return { data, mediaType: file.type || "application/octet-stream", filename: file.name || "fil", zone };
    }
    const text = form.get("text") ?? (typeof file === "string" ? file : null);
    if (text) return { data: Buffer.from(text), mediaType: "text/plain", filename: "kvitto.txt", zone };
    return null;
  }
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length) return null;
  return { data, mediaType: ct.split(";")[0] || "text/plain", filename: "fil", zone: null };
}

export default async (req, context) => {
  if (req.method !== "POST") return error("Använd POST", 405);
  const denied = checkKey(req);
  if (denied) return denied;

  const upload = await readUpload(req);
  if (!upload) return error("Ingen fil eller text i anropet (fältnamn: file)");
  upload.mediaType = sniff(upload.data) ?? upload.mediaType;
  if (upload.mediaType === "text/plain" && looksLikeFilename(upload.data.toString("utf8"))) {
    return error(
      `Fick bara filnamnet "${upload.data.toString("utf8").trim()}", inte själva filen. ` +
        "I genvägen ska fältet file vara Upprepa objekt utan vald egenskap, eller skicka begäran som Fil.",
    );
  }
  if (upload.data.length > MAX_BYTES) return error("Filen är för stor", 413);
  const kind = detectKind(upload.mediaType, upload.filename);
  if (!kind) return error(`Okänd filtyp: ${upload.mediaType}`, 415);
  if (upload.zone && !ZONES.includes(upload.zone)) return error(`Okänd zon: ${upload.zone}`);

  const id = newId();
  await uploads.putBinary(id, upload.data, {
    kind,
    mediaType: upload.mediaType,
    filename: upload.filename,
    zone: upload.zone,
  });

  const pending = await loadPending();
  pending.push({
    id,
    createdAt: new Date().toISOString(),
    kind,
    filename: upload.filename,
    status: "queued",
    lines: [],
  });
  await savePending(pending);

  // ?sync=1 tolkar direkt (för lokal testning). Annars startas bakgrundsfunktionen.
  if (new URL(req.url).searchParams.get("sync") === "1") {
    const proposal = await processJob(id);
    return json({ ok: true, id, proposal });
  }
  await startBackground(req, id);
  return json({ ok: true, id, kind, message: "Mottaget – förslaget dyker upp under Att bekräfta." });
};

export const config = { path: "/api/ingest" };
