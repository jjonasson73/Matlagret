// GET  /api/inventory – hela lagret.
// POST /api/inventory – ändra lagret:
//   { action: "add", item: { name, category, zone, qty, unit, ... } }   manuell/frysregistrering
//   { action: "confirm", id }      användaren bekräftar posten
//   { action: "out", id }          slut
//   { action: "update", id, fields }
//   { action: "delete", id }
import { json, error, checkKey } from "../lib/http.mjs";
import { loadInventory, saveInventory, addOrMerge, findItem, updateItem } from "../lib/inventory.mjs";
import { CATEGORIES, ZONES } from "../lib/rules.mjs";

export default async (req) => {
  const denied = checkKey(req);
  if (denied) return denied;

  if (req.method === "GET") return json(await loadInventory());
  if (req.method !== "POST") return error("Använd GET eller POST", 405);

  const body = await req.json().catch(() => null);
  if (!body?.action) return error("action saknas");
  const inv = await loadInventory();

  if (body.action === "add") {
    const it = body.item ?? {};
    if (!it.name) return error("name saknas");
    if (it.zone && !ZONES.includes(it.zone)) return error("Okänd zon");
    if (it.category && !CATEGORIES.includes(it.category)) return error("Okänd kategori");
    // Hemmafryst registreras vid infrysning och är då bekräftad av användaren.
    const item = addOrMerge(inv, { ...it, source: it.source ?? "manual", confidence: "confirmed" });
    await saveInventory(inv);
    return json({ ok: true, item, inventory: inv });
  }

  const item = findItem(inv, body.id);
  if (!item) return error("Posten finns inte", 404);

  switch (body.action) {
    case "confirm":
      item.confidence = "confirmed";
      item.status = "active";
      break;
    case "out":
      item.status = "out";
      break;
    case "update":
      updateItem(item, body.fields ?? {});
      break;
    case "delete":
      inv.items = inv.items.filter((i) => i.id !== item.id);
      break;
    default:
      return error(`Okänd action: ${body.action}`);
  }
  await saveInventory(inv);
  return json({ ok: true, inventory: inv });
};

export const config = { path: "/api/inventory" };
