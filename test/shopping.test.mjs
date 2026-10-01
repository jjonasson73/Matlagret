// Inköpslistan (SPEC-matplan.md, del B). Kör mot lokal fillagring, utan Claude.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATLAGRET_LOCAL_STORE = await mkdtemp(path.join(tmpdir(), "matlagret-shop-"));
process.env.INGEST_KEY = "hemlig";

const S = await import("../netlify/lib/shopping.mjs");
const { makeItem, saveInventory } = await import("../netlify/lib/inventory.mjs");
const { default: shopping } = await import("../netlify/functions/shopping.mjs");
const { default: ingest } = await import("../netlify/functions/ingest.mjs");
const { default: pending } = await import("../netlify/functions/pending.mjs");
const { updateProposal } = await import("../netlify/lib/pending.mjs");

before(() => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
});

const H = { "x-api-key": "hemlig", "content-type": "application/json" };
const post = (url, body) => new Request("http://localhost" + url, { method: "POST", headers: H, body: JSON.stringify(body) });
const shop = async (body) => (await shopping(post("/api/shopping", body))).json();

const pastas = ["Spirali", "Spaghetti", "Risoni", "Penne", "Farfalle"].map((name) =>
  makeItem({ name, category: "torrvara", zone: "skafferi", kind: "pasta", role: "kolhydrat" }),
);

test("tolkning av inmatning", () => {
  assert.deepEqual(S.parseEntry("2 crème fraiche"), { name: "Crème fraiche", qty: 2, unit: "st" });
  assert.deepEqual(S.parseEntry("500 g nötfärs"), { name: "Nötfärs", qty: 500, unit: "g" });
  assert.deepEqual(S.parseEntry("nötfärs 1,5kg"), { name: "Nötfärs", qty: 1.5, unit: "kg" });
  assert.deepEqual(S.parseEntry("mjölk"), { name: "Mjölk", qty: 1, unit: "st" });
});

test("matchning: ordslut, inte delsträngar", () => {
  const mjolk = makeItem({ name: "Mellanmjölk", category: "mejeri" });
  const mjol = makeItem({ name: "Vetemjöl", category: "torrvara" });
  assert.ok(S.matches("mjölk", mjolk));
  assert.ok(!S.matches("mjöl", mjolk), "mjöl är inte mjölk");
  assert.ok(S.matches("mjöl", mjol));
  assert.ok(S.matches("crème fraiche", makeItem({ name: "Crème fraiche lätt" })));
  assert.ok(S.matches("pasta", pastas[0]), "matchar på varutyp");
});

test("överlager: fem sorters pasta ger varning i stället för en rad", () => {
  const res = S.checkAgainstInventory("pasta", { items: pastas });
  assert.equal(res.verdict, "overstock");
  assert.equal(res.count, 5);
  const one = S.checkAgainstInventory("spaghetti", { items: pastas });
  assert.equal(one.verdict, "overstock", "en sort räknar hela varutypen");
});

test("finns redan: en förpackning hemma blockerar, nästan slut gör det inte", () => {
  const cf = makeItem({ name: "Crème fraiche lätt", zone: "kyl", kind: "crème fraiche" });
  assert.equal(S.checkAgainstInventory("crème fraiche", { items: [cf] }).verdict, "exists");
  cf.opened = true;
  cf.remaining = 0.25;
  const res = S.checkAgainstInventory("crème fraiche", { items: [cf] });
  assert.equal(res.verdict, "ok");
  assert.match(res.note, /Nästan slut/);
  cf.status = "probably_out";
  assert.equal(S.checkAgainstInventory("crème fraiche", { items: [cf] }).verdict, "ok");
});

test("sammanslagning och förpackningar: 200 g + 3 dl crème fraiche blir 2 × 3 dl", () => {
  const list = S.emptyList();
  S.addEntry(list, { name: "Crème fraiche", qty: 2, unit: "dl", kind: "crème fraiche", sources: ["meal"] });
  S.addEntry(list, { name: "Crème fraiche", qty: 300, unit: "g", kind: "crème fraiche", sources: ["meal"] });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].qty, 5);
  assert.equal(S.displayLine(list.items[0]), "Crème fraiche 2 × 3 dl");
  assert.equal(S.displayLine({ name: "Mjölk", qty: 1, unit: "st" }), "Mjölk");
  assert.equal(S.displayLine({ name: "Nötfärs", qty: 2, unit: "st" }), "Nötfärs 2 st");
});

test("avdelningar", () => {
  assert.equal(S.sectionFor("Crème fraiche"), "Mejeri");
  assert.equal(S.sectionFor("Nötfärs"), "Kött & fisk");
  assert.equal(S.sectionFor("Frysta hallon"), "Frys");
  assert.equal(S.sectionFor("Rödlök"), "Frukt & grönt");
  assert.equal(S.sectionFor("Pasta"), "Skafferi");
  assert.equal(S.sectionFor("Paté"), "Övrigt", "te i paté är inte dryck");
});

test("API: varning, lägg till ändå, bocka av, export", async () => {
  await saveInventory({ items: pastas });
  let res = await shop({ action: "add", text: "pasta" });
  assert.equal(res.added, false);
  assert.equal(res.verdict, "overstock");
  assert.equal(res.list.items.length, 0);

  res = await shop({ action: "add", text: "pasta", force: true });
  assert.equal(res.added, true);
  res = await shop({ action: "add", text: "2 rödlök" });
  res = await shop({ action: "add", text: "crème fraiche 3 dl" });
  assert.equal(res.text, "Rödlök 2 st\nCrème fraiche 1 × 3 dl\nPasta");

  const lok = res.list.items.find((e) => e.name === "Rödlök");
  res = await shop({ action: "check", id: lok.id, checked: true });
  assert.ok(!res.text.includes("Rödlök"), "avbockat exporteras inte");
  res = await shop({ action: "clearChecked" });
  assert.equal(res.list.items.length, 2);
});

test("kvittot bockar av det som köptes", async () => {
  await saveInventory({ items: [] });
  await shop({ action: "add", text: "gräddfil" });
  const form = new FormData();
  form.append("text", "kvitto");
  const { id } = await (await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: { "x-api-key": "hemlig" }, body: form }))).json();
  const line = { lineId: "0", action: "add", name: "Gräddfil 12%", kind: "gräddfil", category: "mejeri", zone: "kyl", qty: 1, unit: "st", confidence: "sure", decision: null };
  await updateProposal(id, (p) => Object.assign(p, { status: "ready", source: "receipt", meta: {}, lines: [line] }));
  await pending(post("/api/pending", { id, acceptAll: true }));
  const res = await (await shopping(new Request("http://localhost/api/shopping", { headers: H }))).json();
  assert.equal(res.list.items.find((e) => e.name === "Gräddfil").checked, true);
});
