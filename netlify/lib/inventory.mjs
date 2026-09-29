// Lagret är den enda sanningen. Alla ändringar går via funktionerna här.
import { store, KEYS } from "./store.mjs";
import { newId, today } from "./http.mjs";
import { perishDays, cleanStyles, ROLES, REMAINING, LEFTOVER_DAYS } from "./rules.mjs";

export async function loadInventory() {
  const inv = (await store.get(KEYS.inventory)) ?? { items: [], updatedAt: null };
  return migrate(inv);
}

// Engångsflyttar när datamodellen ändras. Körs vid läsning och sparas med nästa ändring.
function migrate(inv) {
  if (!inv.migrations?.includes("kryddor")) {
    for (const item of inv.items) {
      if (item.category === "krydda" && item.zone === "skafferi") item.zone = "kryddor";
    }
    inv.migrations = [...(inv.migrations ?? []), "kryddor"];
  }
  return inv;
}

export async function saveInventory(inv) {
  inv.updatedAt = new Date().toISOString();
  await store.put(KEYS.inventory, inv);
  return inv;
}

export function makeItem(fields) {
  const item = {
    id: newId(),
    name: fields.name,
    category: fields.category ?? "övrigt",
    zone: fields.zone ?? "skafferi",
    qty: Number(fields.qty ?? 1),
    unit: fields.unit ?? "st",
    confidence: fields.confidence ?? "confirmed",
    source: fields.source ?? "manual",
    articleNo: fields.articleNo ?? null,
    addedAt: fields.addedAt ?? today(),
    bestBefore: fields.bestBefore ?? null,
    status: "active",
    styles: cleanStyles(fields.styles),
    role: ROLES.includes(fields.role) ? fields.role : null,
    kind: fields.kind || null,
    opened: false,
    remaining: null,
    packageSize: fields.packageSize ?? null,
  };
  if (item.source === "leftover") item.zone = fields.zone ?? "kyl";
  item.perishDays = fields.perishDays ?? itemPerishDays(item);
  return item;
}

// Rester håller några dagar i kylen; infrysta rester åldras inte.
const itemPerishDays = (item) =>
  item.source === "leftover" ? (item.zone === "frys" ? null : LEFTOVER_DAYS) : perishDays(item);

const sameThing = (a, b) =>
  a.status !== "out" &&
  a.zone === b.zone &&
  a.unit === b.unit &&
  ((a.articleNo && a.articleNo === b.articleNo) || a.name.toLowerCase() === b.name.toLowerCase());

// Lägg till eller slå ihop med en befintlig post av samma vara i samma zon.
export function addOrMerge(inv, fields) {
  const incoming = makeItem(fields);
  const existing = inv.items.find((i) => sameThing(i, incoming));
  if (!existing) {
    inv.items.push(incoming);
    return incoming;
  }
  existing.qty = existing.status === "active" ? existing.qty + incoming.qty : incoming.qty;
  existing.status = "active";
  existing.addedAt = incoming.addedAt;
  existing.bestBefore = incoming.bestBefore ?? existing.bestBefore;
  existing.confidence = incoming.confidence;
  existing.source = incoming.source;
  // Taggar från en ny tolkning fyller i det som saknas, men skriver inte över rättningar.
  if (!existing.styles?.length) existing.styles = incoming.styles;
  existing.role ??= incoming.role;
  existing.kind ??= incoming.kind;
  existing.packageSize ??= incoming.packageSize;
  return existing;
}

export function findItem(inv, id) {
  return inv.items.find((i) => i.id === id);
}

const EDITABLE = ["name", "category", "zone", "qty", "unit", "bestBefore", "status", "confidence", "addedAt", "kind", "packageSize"];

export function updateItem(item, fields) {
  for (const k of EDITABLE) if (k in fields) item[k] = k === "qty" ? Number(fields[k]) : fields[k];
  if ("kind" in fields) item.kind = fields.kind || null;
  if ("styles" in fields) item.styles = cleanStyles(fields.styles);
  if ("role" in fields) item.role = ROLES.includes(fields.role) ? fields.role : null;
  if ("zone" in fields || "category" in fields || "name" in fields) item.perishDays = itemPerishDays(item);
  return item;
}

// Öppnad förpackning: remaining = hur mycket av den öppnade förpackningen som är kvar.
// null = oöppnad. Gäller en förpackning; resten av qty räknas som hela.
export function setOpened(item, remaining) {
  if (remaining == null) {
    item.opened = false;
    item.remaining = null;
    return item;
  }
  const r = Number(remaining);
  if (!REMAINING.includes(r)) throw new Error(`Ogiltig mängd kvar: ${remaining}`);
  item.opened = true;
  item.remaining = r;
  return item;
}

// Nattlig åldring: addedAt + perishDays passerat → probably_out.
export function ageInventory(inv, now = new Date()) {
  const changed = [];
  for (const item of inv.items) {
    if (item.status !== "active" || item.perishDays == null) continue;
    const expires = new Date(item.addedAt);
    expires.setDate(expires.getDate() + item.perishDays);
    if (expires < now) {
      item.status = "probably_out";
      changed.push(item.id);
    }
  }
  return changed;
}
