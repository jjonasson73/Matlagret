// GET  /api/suggest – senaste matplanen (status: empty | planning | ready | error).
// POST /api/suggest { meals: [{ date, type, style, maxMinutes, people, creativity }] }
//      Sparar beställningen och startar planeringen i bakgrunden.
import { json, error, checkKey, safe } from "../lib/http.mjs";
import { normalizeOrder } from "../lib/plan.mjs";
import { loadPlan, savePlan } from "../lib/planner.mjs";
import { triggerBackground } from "../lib/process.mjs";

const STALE_MS = 16 * 60e3; // bakgrundsfunktioner avbryts efter 15 min

export default safe("suggest", async (req) => {
  const denied = checkKey(req);
  if (denied) return denied;

  if (req.method === "GET") return json(await loadPlan());
  if (req.method !== "POST") return error("Använd GET eller POST", 405);

  const body = await req.json().catch(() => null);
  let order;
  try {
    order = normalizeOrder(body?.meals);
  } catch (e) {
    return error(e.message);
  }

  const current = await loadPlan();
  if (current.status === "planning" && Date.now() - Date.parse(current.startedAt) < STALE_MS) {
    return error("En plan håller redan på att tas fram", 409);
  }

  const plan = await savePlan({ status: "planning", order, meals: [], startedAt: new Date().toISOString() });
  const problem = await triggerBackground(req, "plan-background", {});
  if (problem) {
    plan.status = "error";
    plan.error = `Planeringen startade inte (${problem})`;
    await savePlan(plan);
  }
  return json(plan);
});

export const config = { path: "/api/suggest" };
