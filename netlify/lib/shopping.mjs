// Inköpslistan (SPEC-matplan.md, del B). Ren logik utan lagring och utan Claude,
// så att den går att testa direkt.
import { newId, today } from "./http.mjs";

export const OVERSTOCK_AT = 3;

export const SECTIONS = ["Frukt & grönt", "Bröd", "Mejeri", "Kött & fisk", "Skafferi", "Frys", "Dryck", "Övrigt"];

const COUNT_UNITS = ["st", "förp", "paket", "pkt", "burk", "påse", "flaska"];

// Vanliga förpackningsstorlekar när varken kvittot eller lagret vet bättre.
const DEFAULT_PACKAGE = {
  "crème fraiche": { qty: 3, unit: "dl" },
  gräddfil: { qty: 3, unit: "dl" },
  grädde: { qty: 3, unit: "dl" },
  matlagningsgrädde: { qty: 2.5, unit: "dl" },
  kokosmjölk: { qty: 4, unit: "dl" },
  mjölk: { qty: 1.5, unit: "l" },
  filmjölk: { qty: 1, unit: "l" },
  yoghurt: { qty: 1, unit: "l" },
  smör: { qty: 500, unit: "g" },
  "riven ost": { qty: 150, unit: "g" },
  nötfärs: { qty: 500, unit: "g" },
  köttfärs: { qty: 500, unit: "g" },
  blandfärs: { qty: 500, unit: "g" },
  kycklingfärs: { qty: 500, unit: "g" },
  kycklingfilé: { qty: 900, unit: "g" },
  bacon: { qty: 140, unit: "g" },
  pasta: { qty: 500, unit: "g" },
  ris: { qty: 1, unit: "kg" },
  mjöl: { qty: 2, unit: "kg" },
  socker: { qty: 1, unit: "kg" },
  "krossade tomater": { qty: 400, unit: "g" },
};

// ---- Text ----

export const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[éè]/g, "e")
    .replace(/[^a-zåäö0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s) => normalize(s).split(" ").filter(Boolean);

const UNIT_RE = "(g|kg|hg|dl|cl|ml|l|st|förp|paket|pkt|burk|påse|flaska)";

// "2 crème fraiche", "500 g nötfärs", "nötfärs 500g", "mjölk" → { name, qty, unit }
export function parseEntry(text) {
  const t = String(text).trim().replace(/\s+/g, " ");
  const num = (s) => Number(s.replace(",", "."));
  let m = t.match(new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}?\\.?\\s+(.+)$`, "i"));
  if (m) return { name: capitalize(m[3]), qty: num(m[1]), unit: (m[2] ?? "st").toLowerCase() };
  m = t.match(new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}?\\.?$`, "i"));
  if (m) return { name: capitalize(m[1]), qty: num(m[2]), unit: (m[3] ?? "st").toLowerCase() };
  return { name: capitalize(t), qty: 1, unit: "st" };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- Matchning mot lagret ----

// Svenska sammansättningar har huvudordet sist: "vetemjöl" är mjöl, "mellanmjölk"
// är mjölk – men "mjölk" är inte mjöl. Därför matchas ordslut, inte delsträngar.
export function matches(query, item) {
  const q = normalize(query);
  if (!q) return false;
  if (item.kind && normalize(item.kind) === q) return true;
  const name = normalize(item.name);
  if (name === q) return true;
  const qt = tokens(q);
  const nt = tokens(name);
  const head = qt[qt.length - 1];
  const rest = qt.slice(0, -1);
  return nt.some((t) => t.endsWith(head)) && rest.every((r) => nt.includes(r));
}

const countOf = (item) => (COUNT_UNITS.includes(item.unit) ? Number(item.qty) || 1 : 1);

// Nästan slut: en enda öppnad förpackning med högst en fjärdedel kvar.
const almostOut = (item) => item.opened && item.remaining <= 0.25 && Number(item.qty) <= 1;

// Kontrollera en vara mot lagret innan den hamnar på listan.
// → { verdict: "ok" | "exists" | "overstock", found: [...], kind, note }
export function checkAgainstInventory(name, inventory) {
  const active = inventory.items.filter((i) => i.status === "active");
  let found = active.filter((i) => matches(name, i));
  // Har träffen en varutyp räknas alla varor av samma typ – "pasta" hittar alla sorter.
  const kind = found.find((i) => i.kind)?.kind ?? null;
  if (kind) found = active.filter((i) => i.kind === kind || matches(name, i));

  const probablyOut = inventory.items.filter((i) => i.status === "probably_out" && matches(name, i));
  const describe = (list) => list.map((i) => ({ id: i.id, name: i.name, zone: i.zone, qty: i.qty, unit: i.unit, opened: !!i.opened, remaining: i.remaining ?? null }));

  if (!found.length) {
    return { verdict: "ok", found: [], kind, note: probablyOut.length ? `Troligen slut hemma: ${probablyOut.map((i) => i.name).join(", ")}` : null };
  }
  if (found.every(almostOut)) {
    return { verdict: "ok", found: describe(found), kind, note: `Nästan slut hemma: ${found.map((i) => i.name).join(", ")}` };
  }
  const total = found.reduce((n, i) => n + countOf(i), 0);
  return { verdict: total >= OVERSTOCK_AT ? "overstock" : "exists", found: describe(found), kind, count: total, note: null };
}

// ---- Avdelningar ----

const SECTION_WORDS = [
  ["Frys", /\b(fryst|frysta|frys|glass)|pommes/],
  ["Bröd", /(bröd|limpa|fralla|frallor|bagel|baguett|tortilla|knäcke|pitabröd|naan)/],
  ["Mejeri", /(mjölk|grädde|gräddfil|crème fraiche|creme fraiche|ost\b|ost$|smör|yoghurt|kvarg|keso|ägg|halloumi|fetaost|mozzarella|parmesan)/],
  ["Kött & fisk", /(färs|kyckling|fläsk|bacon|korv|lax|torsk|fisk|räkor|skinka|biff|entrecote|kotlett|lamm|sej|kolja|salami|chorizo)/],
  ["Frukt & grönt", /(äpple|äpplen|banan|päron|apelsin|citron|lime|tomat|gurka|paprika|lök|potatis|morot|morötter|sallad|spenat|broccoli|blomkål|svamp|champinjon|avokado|ingefära|dill|persilja|basilika|koriander|zucchini|aubergine|kål|purjo|sparris|bär|druv|melon|mango|rödbet|pumpa|selleri)/],
  ["Dryck", /(juice|läsk|kaffe|vatten|dryck|saft|(^| )(te|öl|vin)( |$))/],
];

export function sectionFor(name, item) {
  const n = normalize(name);
  if (item?.zone === "frys" || /\bfryst|\bfrysta/.test(n)) return "Frys";
  for (const [section, re] of SECTION_WORDS) if (re.test(n)) return section;
  if (item) {
    if (item.role === "grönsak" || item.category === "grönsak") return "Frukt & grönt";
    if (item.role === "mejeri" || item.category === "mejeri") return "Mejeri";
    if (item.category === "dryck") return "Dryck";
    if (item.role === "protein" && !/(bön|lins|tofu|kikärt)/.test(n)) return "Kött & fisk";
    if (["torrvara", "krydda", "snacks"].includes(item.category)) return "Skafferi";
  }
  return /(pasta|ris|mjöl|socker|konserv|burk|sås|buljong|krydda|olja|vinäger|nudlar|bönor|linser|müsli|flingor)/.test(n) ? "Skafferi" : "Övrigt";
}

// ---- Mängder och förpackningar ----

// Omräkning inom samma dimension. Mellan vikt och volym antas 1 dl ≈ 100 g,
// vilket räcker för mejeri och såser.
const TO_BASE = { g: ["g", 1], hg: ["g", 100], kg: ["g", 1000], ml: ["ml", 1], cl: ["ml", 10], dl: ["ml", 100], l: ["ml", 1000] };

function toBase(qty, unit) {
  const b = TO_BASE[unit];
  return b ? { qty: qty * b[1], dim: b[0] } : null;
}

export function sameAmount(a, b) {
  const x = toBase(a.qty, a.unit);
  const y = toBase(b.qty, b.unit);
  if (!x || !y) return null;
  // g och ml räknas som utbytbara (1 g ≈ 1 ml).
  return { x: x.qty, y: y.qty };
}

// Hur många förpackningar behövs? null om det inte går att räkna ut.
const DEFAULT_BY_KEY = Object.fromEntries(Object.entries(DEFAULT_PACKAGE).map(([k, v]) => [normalize(k), v]));

export function packs(entry, packageSize) {
  const size = packageSize ?? DEFAULT_BY_KEY[normalize(entry.kind ?? entry.name)] ?? null;
  if (!size) return null;
  const amount = sameAmount(entry, size);
  if (!amount || !amount.y) return null;
  return { count: Math.max(1, Math.ceil(amount.x / amount.y - 1e-9)), size };
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(".", ","));

// "Crème fraiche 2 × 3 dl", "Nötfärs 2 st", "Mjölk"
export function displayLine(entry) {
  const p = packs(entry, entry.packageSize);
  if (p) return `${entry.name} ${p.count} × ${fmt(p.size.qty)} ${p.size.unit}`;
  if (entry.unit === "st" && entry.qty === 1) return entry.name;
  return `${entry.name} ${fmt(entry.qty)} ${entry.unit}`;
}

// ---- Listan ----

export function emptyList() {
  return { items: [], updatedAt: null };
}

const mergeKey = (e) => normalize(e.kind ?? e.name);

// Lägg till en rad, eller slå ihop med en obockad rad av samma vara.
export function addEntry(list, entry) {
  const existing = list.items.find((e) => !e.checked && mergeKey(e) === mergeKey(entry));
  if (existing) {
    if (existing.unit === entry.unit) existing.qty += entry.qty;
    else {
      const a = toBase(existing.qty, existing.unit);
      const b = toBase(entry.qty, entry.unit);
      if (a && b) {
        existing.qty = (a.qty + b.qty) / TO_BASE[existing.unit][1];
      } else {
        existing.qty += entry.qty;
      }
    }
    existing.sources = [...new Set([...(existing.sources ?? []), ...(entry.sources ?? [])])];
    return existing;
  }
  const row = {
    id: newId(),
    name: entry.name,
    qty: entry.qty ?? 1,
    unit: entry.unit ?? "st",
    kind: entry.kind ?? null,
    section: entry.section ?? sectionFor(entry.name),
    packageSize: entry.packageSize ?? null,
    note: entry.note ?? null,
    sources: entry.sources ?? ["manual"],
    checked: false,
    addedAt: today(),
  };
  list.items.push(row);
  return row;
}

// Kvittot kom in: bocka av det som köptes.
export function strikeBought(list, boughtLines) {
  const struck = [];
  for (const e of list.items) {
    if (e.checked) continue;
    const hit = boughtLines.find((l) => (e.kind && l.kind && normalize(e.kind) === normalize(l.kind)) || matches(e.name, l));
    if (hit) {
      e.checked = true;
      e.boughtAt = today();
      struck.push(e.id);
    }
  }
  return struck;
}

// Text för urklipp och delning: en vara per rad, grupperat i butiksordning.
export function exportText(list) {
  return SECTIONS.flatMap((s) => list.items.filter((e) => !e.checked && e.section === s).map(displayLine)).join("\n");
}
