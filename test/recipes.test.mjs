// Receptbanken: import från skärmdump/text, tumme upp/ned. Claude ersätts.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATLAGRET_LOCAL_STORE = await mkdtemp(path.join(tmpdir(), "matlagret-rec-"));
process.env.INGEST_KEY = "hemlig";

const { default: ingest } = await import("../netlify/functions/ingest.mjs");
const { default: pending } = await import("../netlify/functions/pending.mjs");
const { default: recipes } = await import("../netlify/functions/recipes.mjs");
const { processJob, deps } = await import("../netlify/lib/process.mjs");
const { makeItem, saveInventory } = await import("../netlify/lib/inventory.mjs");
const { savePlan } = await import("../netlify/lib/planner.mjs");
const { avoidList } = await import("../netlify/lib/recipes.mjs");

before(() => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
});

const H = { "x-api-key": "hemlig" };
const post = (url, body) => new Request("http://localhost" + url, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url) => new Request("http://localhost" + url, { headers: H });

const tiktok = {
  isRecipe: true, title: "Krämig gochujang-pasta", sourceType: "social", sourceUrl: null, servings: 2, minutes: 20, styles: ["asiatiskt"],
  ingredients: [
    { name: "Spaghetti", qty: 200, unit: "g", confidence: "sure" },
    { name: "Gochujang", qty: 2, unit: "msk", confidence: "sure" },
    { name: "Grädde", qty: 1, unit: "dl", confidence: "likely" },
    { name: "Sojasås", qty: 1, unit: "msk", confidence: "unsure" },
  ],
  steps: ["Koka pastan.", "Rör ihop såsen.", "Blanda."],
  substitutions: [{ instead: "Grädde", use: "Crème fraiche", note: "finns i kylen" }],
};

test("skärmdump med type=recipe blir ett sparat recept, med var ingredienserna finns", async () => {
  await saveInventory({ items: [makeItem({ name: "Spaghetti", zone: "skafferi", kind: "pasta" }), makeItem({ name: "Sojasås", zone: "skafferi" })] });
  let seen;
  deps.parseRecipe = async (args) => {
    seen = args;
    return tiktok;
  };
  const form = new FormData();
  form.append("file", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: "image/jpeg" }), "skarmdump.jpg");
  const res = await ingest(new Request("http://localhost/api/ingest?type=recipe", { method: "POST", headers: H, body: form }));
  const { id } = await res.json();
  const p = await processJob(id);
  assert.equal(p.status, "ready", p.error);
  assert.equal(p.source, "recipe");
  assert.equal(p.meta.title, "Krämig gochujang-pasta");
  assert.equal(seen.images.length, 1);
  assert.ok(seen.pantry.includes("Spaghetti"), "Claude får veta vad som finns hemma");

  const { recipes: list } = await (await recipes(get("/api/recipes"))).json();
  const r = list[0];
  assert.equal(r.servings, 2);
  assert.deepEqual(r.ingredients.map((i) => i.have), [true, false, false, true]);
  assert.match(r.ingredients[0].where[0], /Spaghetti/);

  // Förslagskortet kan stängas.
  await pending(post("/api/pending", { id, dismiss: true }));
  assert.equal((await (await pending(get("/api/pending"))).json()).pending.length, 0);
});

test("inklistrad text som recept, och fel när det inte är ett recept", async () => {
  deps.parseRecipe = async ({ text }) => (text.includes("pasta") ? tiktok : { ...tiktok, isRecipe: false, ingredients: [] });
  const send = async (text) => {
    const form = new FormData();
    form.append("text", text);
    form.append("type", "recipe");
    const { id } = await (await ingest(new Request("http://localhost/api/ingest", { method: "POST", headers: H, body: form }))).json();
    return processJob(id);
  };
  assert.equal((await send("Gochujang pasta för 2")).status, "ready");
  const bad = await send("Hej, ses vi ikväll?");
  assert.equal(bad.status, "error");
  assert.match(bad.error, /inget recept/);
});

test("tumme upp sparar rätten, tumme ned undviks i nästa planering", async () => {
  const meal = (slot, f) => ({ slot, date: "2026-10-02", title: `Rätt ${slot}`, type: "middag", style: "asiatiskt", minutes: 25, people: 4, creativity: "ny", mainProtein: "lax",
    uses: [{ itemId: "x", name: "Lax", qty: 500, unit: "g" }], missing: [{ name: "Lime", qty: 1, unit: "st" }], substitutions: [], thawAhead: [], steps: ["Laga"], pairings: [], balance: null, ...f });
  await savePlan({ status: "ready", order: [], meals: [meal(0), meal(1, { title: "Rödbetor med honung", pairings: [{ ingredients: ["rödbeta", "honung"], why: "…" }] })] });

  let body = await (await recipes(post("/api/recipes", { action: "like", slot: 0 }))).json();
  assert.equal(body.plan.meals[0].rating, 1);
  assert.ok(body.recipes.some((r) => r.title === "Rätt 0" && r.source === "plan" && r.servings === 4));
  body = await (await recipes(post("/api/recipes", { action: "like", slot: 0 }))).json();
  assert.equal(body.recipes.filter((r) => r.title === "Rätt 0").length, 1, "sparas bara en gång");

  body = await (await recipes(post("/api/recipes", { action: "dislike", slot: 1 }))).json();
  assert.equal(body.plan.meals[1].rating, -1);
  assert.ok(!body.recipes.some((r) => r.title === "Rödbetor med honung"));
  assert.deepEqual(await avoidList(), ["rödbeta + honung"]);

  const id = body.recipes.find((r) => r.title === "Rätt 0").id;
  body = await (await recipes(post("/api/recipes", { action: "delete", id }))).json();
  assert.ok(!body.recipes.some((r) => r.id === id));
});
