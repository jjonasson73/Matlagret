// GET  /api/shopping – inköpslistan.
// POST /api/shopping – ändra listan:
//   { action: "add", text }                 "2 crème fraiche", "nötfärs 500 g"
//   { action: "add", name, qty, unit, source, force }
//       Kontrolleras mot lagret först. Finns varan redan (eller i överlager) läggs
//       den inte till, utan svaret är { added: false, verdict, found }. force: true
//       lägger till ändå.
//   { action: "check", id, checked }
//   { action: "remove", id }
//   { action: "clearChecked" }
import { store, KEYS } from "../lib/store.mjs";
import { json, error, checkKey } from "../lib/http.mjs";
import { loadInventory } from "../lib/inventory.mjs";
import { emptyList, parseEntry, checkAgainstInventory, addEntry, sectionFor, exportText, displayLine, SECTIONS } from "../lib/shopping.mjs";

const load = async () => (await store.get(KEYS.shopping)) ?? emptyList();

async function save(list) {
  list.updatedAt = new Date().toISOString();
  await store.put(KEYS.shopping, list);
  return list;
}

const reply = (list, extra = {}) =>
  json({
    ok: true,
    ...extra,
    list: { ...list, items: list.items.map((e) => ({ ...e, display: displayLine(e) })) },
    sections: SECTIONS,
    text: exportText(list),
  });

export default async (req) => {
  const denied = checkKey(req);
  if (denied) return denied;

  if (req.method === "GET") return reply(await load());
  if (req.method !== "POST") return error("Använd GET eller POST", 405);

  const body = await req.json().catch(() => null);
  if (!body?.action) return error("action saknas");
  const list = await load();

  if (body.action === "add") {
    const entry = body.text ? parseEntry(body.text) : { name: body.name, qty: Number(body.qty ?? 1), unit: body.unit ?? "st" };
    if (!entry.name) return error("Ange en vara");
    if (!(entry.qty > 0)) return error("Mängden måste vara större än noll");

    const inventory = await loadInventory();
    const check = checkAgainstInventory(entry.name, inventory);
    if (check.verdict !== "ok" && !body.force) {
      return reply(list, { added: false, entry, ...check });
    }
    const match = inventory.items.find((i) => i.id === check.found[0]?.id);
    const row = addEntry(list, {
      ...entry,
      kind: check.kind ?? match?.kind ?? null,
      section: sectionFor(entry.name, match),
      packageSize: match?.packageSize ?? null,
      note: check.verdict === "ok" ? check.note : "Lagd på listan trots att den finns hemma",
      sources: [body.source ?? "manual"],
    });
    return reply(await save(list), { added: true, row, ...check });
  }

  const row = list.items.find((e) => e.id === body.id);
  switch (body.action) {
    case "check":
      if (!row) return error("Raden finns inte", 404);
      row.checked = !!body.checked;
      break;
    case "remove":
      if (!row) return error("Raden finns inte", 404);
      list.items = list.items.filter((e) => e.id !== row.id);
      break;
    case "clearChecked":
      list.items = list.items.filter((e) => !e.checked);
      break;
    default:
      return error(`Okänd action: ${body.action}`);
  }
  return reply(await save(list));
};

export const config = { path: "/api/shopping" };
