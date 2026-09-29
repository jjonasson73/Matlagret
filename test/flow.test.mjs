// Kör endpoints mot en lokal fillagring. Claude anropas inte här.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATLAGRET_LOCAL_STORE = await mkdtemp(path.join(tmpdir(), "matlagret-"));
process.env.INGEST_KEY = "hemlig";

const { default: ingest } = await import("../netlify/functions/ingest.mjs");
const { default: pending } = await import("../netlify/functions/pending.mjs");
const { default: inventory } = await import("../netlify/functions/inventory.mjs");
const { receiptLines, photoLines } = await import("../netlify/lib/process.mjs");
const { updateProposal } = await import("../netlify/lib/pending.mjs");
const { ageInventory, makeItem } = await import("../netlify/lib/inventory.mjs");

const H = { "x-api-key": "hemlig" };
const post = (url, body) =>
  new Request("http://localhost" + url, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url) => new Request("http://localhost" + url, { headers: H });

// Inget nätverk i testerna: bakgrundsanropet ska misslyckas tyst.
before(() => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
});

const receipt = {
  store: "Maxi ICA Stormarknad Gävle",
  date: "2026-08-27",
  total: 2970.74,
  lines: [
    { raw: "Nötfärs 12%", articleNo: "123", name: "Nötfärs 12%", category: "protein", zone: "kyl", qty: 1.2, unit: "kg", price: 150, isFood: true, confidence: "sure", alternatives: [], note: null },
    { raw: "Creme fraich lätt", articleNo: "456", name: "Crème fraiche lätt", category: "mejeri", zone: "kyl", qty: 1, unit: "st", price: 22, isFood: true, confidence: "likely", alternatives: ["Gräddfil"], note: null },
    { raw: "Pant", articleNo: null, name: "Pant", category: "övrigt", zone: "skafferi", qty: 1, unit: "st", price: 2, isFood: false, confidence: "sure", alternatives: [], note: null },
  ],
};

test("ingest kräver giltig nyckel", async () => {
  const form = new FormData();
  form.append("file", new Blob(["x"], { type: "application/pdf" }), "kvitto.pdf");
  const res = await ingest(new Request("http://localhost/api/ingest", { method: "POST", body: form }));
  assert.equal(res.status, 401);
});

test("ingest tar emot multipart-fil från genvägen", async () => {
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "kvitto.pdf");
  const res = await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "pdf");
  const list = await (await pending(get("/api/pending"))).json();
  // Bakgrundsjobbet kan inte startas i testet (inget nät) → felet syns direkt.
  assert.equal(list.pending.at(-1).status, "error");
  assert.match(list.pending.at(-1).error, /startade inte/);
});

test("ingest känner igen PDF skickad som rå fil utan content-type", async () => {
  const res = await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: Buffer.from("%PDF-1.7 ...") }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).kind, "pdf");
});

test("ingest säger till när genvägen bara skickar filnamnet", async () => {
  const form = new FormData();
  form.append("file", "Kvitto_ICA_2026-08-27.pdf");
  const res = await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /filnamnet/);
});

test("kvittorader: användarregler, icke-mat och artikelkoppling", () => {
  const lines = receiptLines(receipt, { 456: { name: "Crème fraiche lätt", category: "mejeri", zone: "kyl", unit: "st" } });
  assert.equal(lines[0].zone, "frys", "köttfärs fryses direkt");
  assert.equal(lines[1].confidence, "sure", "känt artikelnummer");
  assert.equal(lines[2].action, "skip", "pant är inte mat");
});

test("godkänn rader från ett kvittoförslag", async () => {
  const form = new FormData();
  form.append("text", "kvittotext");
  const { id } = await (await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }))).json();
  await updateProposal(id, (p) => Object.assign(p, { status: "ready", source: "receipt", meta: { date: receipt.date }, lines: receiptLines(receipt, {}) }));

  let res = await pending(post("/api/pending", { id, lineId: "1", decision: "accept", edits: { name: "Gräddfil" } }));
  assert.equal(res.status, 200);
  let body = await res.json();
  const grf = body.inventory.items.find((i) => i.name === "Gräddfil");
  assert.equal(grf.confidence, "confirmed");
  assert.equal(grf.addedAt, "2026-08-27");

  body = await (await pending(post("/api/pending", { id, acceptAll: true }))).json();
  const fars = body.inventory.items.find((i) => i.name === "Nötfärs 12%");
  assert.equal(fars.zone, "frys");
  assert.equal(fars.confidence, "sure", "godkänn alla behåller Claudes säkerhet");
  assert.equal(fars.perishDays, null, "fryst åldras inte");
  assert.equal(body.proposal.status, "done");
});

test("inlärning: godkänn alla lär bara in säkra rader, rättning i lagret lär in", async () => {
  const { store, KEYS } = await import("../netlify/lib/store.mjs");
  await store.put(KEYS.articles, {});
  const form = new FormData();
  form.append("text", "kvittotext 2");
  const { id } = await (await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }))).json();
  const r = { ...receipt, lines: [
    { ...receipt.lines[1], articleNo: "777", name: "Aromatics Apple dryck", category: "dryck", confidence: "likely" },
    { ...receipt.lines[1], articleNo: "888", name: "Mjölk 3%", confidence: "sure" },
  ] };
  await updateProposal(id, (p) => Object.assign(p, { status: "ready", source: "receipt", meta: {}, lines: receiptLines(r, {}) }));
  const body = await (await pending(post("/api/pending", { id, acceptAll: true }))).json();

  let articles = await store.get(KEYS.articles);
  assert.ok(!articles["777"], "osäker gissning lärs inte in");
  assert.equal(articles["888"].name, "Mjölk 3%");

  const apple = body.inventory.items.find((i) => i.articleNo === "777");
  await inventory(post("/api/inventory", { action: "update", id: apple.id, fields: { name: "Äpple Aroma", category: "grönsak" } }));
  articles = await store.get(KEYS.articles);
  assert.equal(articles["777"].name, "Äpple Aroma");
});

test("fotoavstämning: del av zonen föreslår aldrig slut, hela zonen gör det", () => {
  const inv = { items: [makeItem({ name: "Mjölk", zone: "kyl", category: "mejeri" }), makeItem({ name: "Smör", zone: "kyl", category: "mejeri" })] };
  const [milk] = inv.items;
  const photo = { zone: "kyl", seen: [
    { inventoryId: milk.id, name: "Mjölk", category: "mejeri", qty: 1, unit: "st", confidence: "sure", bestBefore: "2026-10-01", alternatives: [] },
    { inventoryId: null, name: "Halloumi", category: "mejeri", qty: 1, unit: "st", confidence: "sure", bestBefore: null, alternatives: [] },
  ] };
  const part = photoLines(photo, inv);
  assert.deepEqual(part.map((l) => l.action), ["confirm", "add"], "ett foto av kyldörren tar inte bort resten");
  assert.equal(part[1].confidence, "likely", "nytt från foto blir aldrig sure");

  const full = photoLines(photo, inv, { scope: "full" });
  assert.deepEqual(full.map((l) => l.action), ["confirm", "add", "probably_out"]);
});

test("skanning: flera foton i ett anrop blir ett förslag", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const form = new FormData();
  for (let i = 0; i < 3; i++) form.append("file", new Blob([jpeg], { type: "image/jpeg" }), `foto${i}.jpg`);
  form.append("zone", "kyl");
  form.append("scope", "full");
  const res = await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }));
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const { uploads } = await import("../netlify/lib/store.mjs");
  const main = await uploads.getBinary(id);
  assert.equal(main.metadata.count, 3);
  assert.equal(main.metadata.scope, "full");
  assert.ok(await uploads.getBinary(`${id}.2`), "tredje fotot sparat");
});

test("skanning: PDF och foto kan inte blandas", async () => {
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "k.pdf");
  form.append("file", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "f.jpg");
  const res = await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }));
  assert.equal(res.status, 400);
});

test("avvisa alla troligen slut på en gång", async () => {
  const { makeItem: mk, saveInventory } = await import("../netlify/lib/inventory.mjs");
  const smor = mk({ name: "Smör", zone: "kyl", category: "mejeri" });
  await saveInventory({ items: [smor] });
  const form = new FormData();
  form.append("text", "x");
  const { id } = await (await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }))).json();
  await updateProposal(id, (p) => Object.assign(p, { status: "ready", source: "photo", meta: {}, lines: photoLines({ zone: "kyl", seen: [] }, { items: [smor] }, { scope: "full" }) }));
  const body = await (await pending(post("/api/pending", { id, rejectAction: "probably_out" }))).json();
  assert.equal(body.proposal.status, "done");
  assert.equal(body.inventory.items[0].status, "active", "smöret finns kvar");
});

test("manuell frysregistrering och snabbknappar", async () => {
  let body = await (await inventory(post("/api/inventory", { action: "add", item: { name: "Köttbullar hemgjorda", zone: "frys", category: "protein", qty: 1, unit: "påse" } }))).json();
  const id = body.item.id;
  assert.equal(body.item.confidence, "confirmed");
  body = await (await inventory(post("/api/inventory", { action: "out", id }))).json();
  assert.equal(body.inventory.items.find((i) => i.id === id).status, "out");
});

test("kryddor: torra kryddor får egen zon, befintliga flyttas en gång", async () => {
  const { applyZoneRules } = await import("../netlify/lib/rules.mjs");
  assert.equal(applyZoneRules({ name: "Paprikapulver", category: "krydda", zone: "skafferi" }).zone, "kryddor");
  assert.equal(applyZoneRules({ name: "Basilika", category: "krydda", zone: "kyl" }).zone, "kyl", "färska örter stannar i kylen");

  const { store, KEYS } = await import("../netlify/lib/store.mjs");
  const { loadInventory, saveInventory } = await import("../netlify/lib/inventory.mjs");
  const oregano = makeItem({ name: "Oregano", category: "krydda", zone: "skafferi" });
  await store.put(KEYS.inventory, { items: [oregano] });
  let inv = await loadInventory();
  assert.equal(inv.items[0].zone, "kryddor");
  assert.equal(inv.items[0].perishDays, null, "kryddor åldras inte");

  // Flyttar användaren tillbaka den ska den stanna där.
  inv.items[0].zone = "skafferi";
  await saveInventory(inv);
  inv = await loadInventory();
  assert.equal(inv.items[0].zone, "skafferi");
});

test("åldring sätter probably_out efter perishDays", () => {
  const inv = {
    items: [
      makeItem({ name: "Sallad", zone: "kyl", category: "grönsak", addedAt: "2026-09-01" }),
      makeItem({ name: "Pasta", zone: "skafferi", category: "torrvara", addedAt: "2020-01-01" }),
    ],
  };
  const changed = ageInventory(inv, new Date("2026-09-10"));
  assert.deepEqual(changed, [inv.items[0].id]);
});
