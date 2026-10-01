// Kör en planering: kandidatlista → Claude → regelkontroll → omförsök → spara.
import { store, KEYS } from "./store.mjs";
import { loadInventory } from "./inventory.mjs";
import { buildCandidates, validatePlan } from "./plan.mjs";
import { planMeals } from "./claude.mjs";
import { emptyList, addEntry, checkAgainstInventory, displayLine } from "./shopping.mjs";

export const MAX_RETRIES = 2;

export async function loadPlan() {
  return (await store.get(KEYS.plan)) ?? { status: "empty", order: [], meals: [] };
}

export async function savePlan(plan) {
  plan.updatedAt = new Date().toISOString();
  await store.put(KEYS.plan, plan);
  return plan;
}

// Lägg Claudes svar på rätt slot och fyll i det som beställningen bestämmer.
function alignMeals(order, meals) {
  const bySlot = new Map(meals.map((m) => [Number(m.slot), m]));
  return order.map((o) => {
    const m = bySlot.get(o.slot);
    if (!m) throw new Error(`Claude svarade inte för måltid ${o.slot + 1}`);
    return { ...m, slot: o.slot, date: o.date, type: o.type, style: o.style, people: o.people, creativity: o.creativity };
  });
}

// Slå ihop det som saknas i alla måltider och kontrollera mot lagret.
export function shoppingPreview(meals, inventory) {
  const merged = emptyList();
  for (const m of meals) for (const x of m.missing) addEntry(merged, { ...x, sources: ["meal"] });
  const toBuy = [];
  const atHome = [];
  for (const e of merged.items) {
    const check = checkAgainstInventory(e.name, inventory);
    const entry = { name: e.name, qty: e.qty, unit: e.unit, display: displayLine(e) };
    if (check.verdict === "ok") toBuy.push(entry);
    else atHome.push({ ...entry, verdict: check.verdict, found: check.found.map((f) => `${f.name} (${f.zone})`) });
  }
  return { toBuy, atHome };
}

export async function runPlan({ now = new Date(), planner = planMeals } = {}) {
  const plan = await loadPlan();
  try {
    const inventory = await loadInventory();
    const history = (await store.get(KEYS.history)) ?? [];
    const { candidates, basics } = buildCandidates(inventory, plan.order, { now });
    const recent = history.slice(-10);

    let meals = alignMeals(plan.order, (await planner({ order: plan.order, candidates, basics, history: recent })).meals);
    let check = validatePlan(meals, plan.order, candidates, { history, now });

    for (let round = 0; round < MAX_RETRIES && Object.keys(check.bySlot).length; round++) {
      const redo = plan.order.filter((o) => check.bySlot[o.slot]);
      const fixed = meals.filter((m) => !check.bySlot[m.slot]);
      console.log(`Omförsök ${round + 1}:`, JSON.stringify(check.bySlot));
      const fresh = (await planner({ order: redo, candidates, basics, history: recent, fixed, hints: check.hints })).meals;
      const bySlot = new Map(alignMeals(redo, fresh).map((m) => [m.slot, m]));
      meals = meals.map((m) => bySlot.get(m.slot) ?? m);
      check = validatePlan(meals, plan.order, candidates, { history, now });
    }

    Object.assign(plan, {
      status: "ready",
      meals,
      warnings: check.bySlot,
      shopping: shoppingPreview(meals, inventory),
      candidateCount: candidates.length,
      finishedAt: new Date().toISOString(),
      error: null,
    });
  } catch (e) {
    console.error("Planeringen misslyckades", e);
    Object.assign(plan, { status: "error", error: e.message });
  }
  return savePlan(plan);
}
