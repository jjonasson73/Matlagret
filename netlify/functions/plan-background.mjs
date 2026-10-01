// Bakgrundsfunktion: planera måltiderna i den sparade beställningen (30–60 s).
import { checkKey } from "../lib/http.mjs";
import { runPlan } from "../lib/planner.mjs";

export default async (req) => {
  if (checkKey(req)) return;
  await runPlan();
};
