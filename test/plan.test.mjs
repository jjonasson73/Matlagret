// Matplanen: kandidatlista, regelkontroll och omförsök. Claude ersätts av en låtsasplanerare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATLAGRET_LOCAL_STORE = await mkdtemp(path.join(tmpdir(), "matlagret-plan-"));
process.env.INGEST_KEY = "hemlig";

const P = await import("../netlify/lib/plan.mjs");
const { makeItem, saveInventory } = await import("../netlify/lib/inventory.mjs");
const { runPlan, savePlan, shoppingPreview } = await import("../netlify/lib/planner.mjs");

const NOW = new Date("2026-10-01T12:00:00Z");
const item = (f) => makeItem({ addedAt: "2026-09-29", ...f });

const inventory = {
  items: [
    item({ name: "Chili rester", source: "leftover", zone: "kyl", role: "protein" }),
    item({ name: "Färsk lax", zone: "kyl", category: "protein", role: "protein", addedAt: "2026-09-30" }),
    item({ name: "Kycklingfilé", zone: "frys", category: "protein", role: "protein" }),
    item({ name: "Spenat", zone: "kyl", category: "grönsak", role: "grönsak", addedAt: "2026-09-27" }),
    item({ name: "Sushiris", zone: "skafferi", category: "torrvara", role: "kolhydrat", styles: ["asiatiskt"], kind: "ris" }),
    item({ name: "Spirali", zone: "skafferi", category: "torrvara", role: "kolhydrat", kind: "pasta" }),
    item({ name: "Sojasås", zone: "skafferi", category: "krydda", role: "smaksättning", styles: ["asiatiskt"] }),
    item({ name: "Vetemjöl", zone: "basvara", category: "torrvara" }),
    item({ name: "Oregano", zone: "kryddor", category: "krydda" }),
    item({ name: "Kokosmjölk", zone: "skafferi", category: "torrvara", role: "smaksättning" }),
  ],
};
inventory.items.find((i) => i.name === "Kokosmjölk").opened = true;
inventory.items.find((i) => i.name === "Kokosmjölk").remaining = 0.5;

const order = P.normalizeOrder(
  [
    { date: "2026-10-01", style: "asiatiskt", maxMinutes: 30 },
    { date: "2026-10-02", style: "asiatiskt", maxMinutes: 30 },
    { date: "2026-10-03", type: "dessert", style: "fritt" },
  ],
  NOW,
);

test("beställning: förval och kontroll", () => {
  assert.deepEqual(order.map((o) => [o.slot, o.type, o.people, o.creativity]), [[0, "middag", 4, "känd"], [1, "middag", 4, "känd"], [2, "dessert", 4, "känd"]]);
  assert.throws(() => P.normalizeOrder([{ style: "franskt" }]), /Okänd stil/);
  assert.throws(() => P.normalizeOrder([]), /minst en/);
  assert.equal(P.normalizeOrder([{ maxMinutes: "fritt" }], NOW)[0].maxMinutes, null);
});

test("kandidatlista: brådska först, basvaror utanför, öppnat och stil ger påslag", () => {
  const { candidates, basics } = P.buildCandidates(inventory, order, { now: NOW });
  const names = candidates.map((c) => c.name);
  assert.equal(names[0], "Chili rester", "rester först");
  assert.ok(names.indexOf("Färsk lax") < names.indexOf("Kycklingfilé"), "färskt kött före fryst");
  assert.ok(!names.includes("Vetemjöl") && !names.includes("Oregano"), "basvaror och kryddor skickas separat");
  assert.deepEqual(basics.sort(), ["Oregano", "Vetemjöl"]);
  const kokos = candidates.find((c) => c.name === "Kokosmjölk");
  assert.ok(kokos.opened && kokos.score > candidates.find((c) => c.name === "Spirali").score, "öppnat ger påslag");
  assert.ok(candidates.find((c) => c.name === "Sushiris").score - candidates.find((c) => c.name === "Spirali").score <= 8, "stil är bara en knuff");
  assert.ok(candidates.length <= P.CANDIDATE_LIMIT);
});

const meal = (slot, f = {}) => ({
  slot, date: order[slot].date, title: `Rätt ${slot}`, type: order[slot].type, style: order[slot].style,
  minutes: 25, people: 4, creativity: "känd", mainProtein: "ingen", uses: [], missing: [],
  substitutions: [], thawAhead: [], steps: ["Laga"], pairings: [], balance: null, ...f,
});

test("regler: protein i rad, tid, okända varor, öppnat, minst en utan inköp, historik", () => {
  const { candidates } = P.buildCandidates(inventory, order, { now: NOW });
  const kokos = candidates.find((c) => c.name === "Kokosmjölk");
  const meals = [
    meal(0, { mainProtein: "kyckling", missing: [{ name: "Lime", qty: 1, unit: "st" }] }),
    meal(1, { mainProtein: "Kyckling", minutes: 40, uses: [{ itemId: "påhittad", name: "Tofu", qty: 1, unit: "st" }], missing: [{ name: "Koriander", qty: 1, unit: "st" }] }),
    meal(2, { missing: [{ name: "Grädde", qty: 3, unit: "dl" }] }),
  ];
  const { bySlot } = P.validatePlan(meals, order, candidates, { now: NOW, history: [{ date: "2026-09-25", mainProtein: "kyckling", style: "asiatiskt" }] });
  assert.ok(bySlot[1].some((r) => r.includes("två dagar i rad")));
  assert.ok(bySlot[1].some((r) => r.includes("max 30")));
  assert.ok(bySlot[1].some((r) => r.includes("okända varor")));
  assert.ok(bySlot[0].some((r) => r.includes("lagades")), "samma protein och stil inom 14 dagar");
  const all = Object.values(bySlot).flat();
  assert.ok(all.some((r) => r.includes("öppnat")), "kokosmjölken används inte");
  assert.ok(all.some((r) => r.includes("alla måltider kräver inköp")));

  const ok = [meal(0, { mainProtein: "lax", uses: [{ itemId: kokos.id, name: "Kokosmjölk", qty: 2, unit: "dl" }] }), meal(1, { mainProtein: "kyckling" }), meal(2)];
  assert.deepEqual(P.validatePlan(ok, order, candidates, { now: NOW }).bySlot, {});
});

test("nya rätter får högst två inköp", () => {
  const o = P.normalizeOrder([{ date: "2026-10-01", creativity: "ny" }], NOW);
  const m = { ...meal(0), creativity: "ny", missing: ["a", "b", "c"].map((name) => ({ name, qty: 1, unit: "st" })) };
  const { bySlot } = P.validatePlan([m], o, [], { now: NOW });
  assert.ok(bySlot[0].some((r) => r.includes("ny rätt med 3 inköp")));
});

test("planering: regelbrott ger omförsök för bara den måltiden, och inköp kontrolleras mot lagret", async () => {
  await saveInventory(inventory);
  const kokos = inventory.items.find((i) => i.name === "Kokosmjölk");
  await savePlan({ status: "planning", order, meals: [] });
  const calls = [];
  const planner = async ({ order: o, hints }) => {
    calls.push({ slots: o.map((x) => x.slot), hints });
    if (calls.length === 1) {
      return { meals: [
        meal(0, { mainProtein: "lax", uses: [{ itemId: kokos.id, name: "Kokosmjölk", qty: 2, unit: "dl" }] }),
        meal(1, { mainProtein: "lax", missing: [{ name: "Pasta", qty: 500, unit: "g" }, { name: "Lime", qty: 2, unit: "st" }] }),
        meal(2, { title: "Pannkakor" }),
      ] };
    }
    return { meals: [meal(1, { mainProtein: "kyckling", missing: [{ name: "Pasta", qty: 500, unit: "g" }, { name: "Lime", qty: 2, unit: "st" }] })] };
  };
  const plan = await runPlan({ now: NOW, planner });
  assert.equal(plan.status, "ready");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slots, [1], "bara måltiden som bröt mot regeln görs om");
  assert.ok(calls[1].hints[1].some((h) => h.includes("annat huvudprotein")));
  assert.deepEqual(plan.warnings, {});
  assert.equal(plan.meals[1].mainProtein, "kyckling");
  assert.deepEqual(plan.shopping.toBuy.map((e) => e.name), ["Lime"]);
  assert.equal(plan.shopping.atHome[0].name, "Pasta", "pasta finns hemma och köps inte");
});

test("planering: kvarstående regelbrott efter två omförsök visas som varning", async () => {
  await savePlan({ status: "planning", order: order.slice(0, 1), meals: [] });
  let n = 0;
  const planner = async () => {
    n++;
    return { meals: [meal(0, { minutes: 60 })] };
  };
  const plan = await runPlan({ now: NOW, planner });
  assert.equal(n, 3, "första försöket plus två omförsök");
  assert.ok(plan.warnings[0].some((r) => r.includes("max 30")));
});

test("planering: fel från Claude sparas som fel", async () => {
  await savePlan({ status: "planning", order, meals: [] });
  const plan = await runPlan({ now: NOW, planner: async () => ({ meals: [] }) });
  assert.equal(plan.status, "error");
  assert.match(plan.error, /svarade inte/);
});

test("inköp från planen: samma vara slås ihop", () => {
  const preview = shoppingPreview(
    [meal(0, { missing: [{ name: "Crème fraiche", qty: 2, unit: "dl" }] }), meal(1, { missing: [{ name: "Crème fraiche", qty: 300, unit: "g" }] })],
    { items: [] },
  );
  assert.deepEqual(preview.toBuy.map((e) => e.display), ["Crème fraiche 2 × 3 dl"]);
});
