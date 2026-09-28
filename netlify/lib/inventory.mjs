// Lagret är den enda sanningen. Alla ändringar går via funktionerna här.
import { store, KEYS } from "./store.mjs";
import { newId, today } from "./http.mjs";
import { perishDays } from "./rules.mjs";

export async function loadInventory() {
  return (await store.get(KEYS.inventory)) ?? { items: [], updatedAt: null };
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
  };
  item.perishDays = fields.perishDays ?? perishDays(item);
  return item;
}

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
  return existing;
}

export function findItem(inv, id) {
  return inv.items.find((i) => i.id === id);
}

const EDITABLE = ["name", "category", "zone", "qty", "unit", "bestBefore", "status", "confidence", "addedAt"];

export function updateItem(item, fields) {
  for (const k of EDITABLE) if (k in fields) item[k] = k === "qty" ? Number(fields[k]) : fields[k];
  if ("zone" in fields || "category" in fields || "name" in fields) item.perishDays = perishDays(item);
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
