// Schemalagd funktion: nattlig åldring av lagret (03:00 UTC).
import { loadInventory, saveInventory, ageInventory } from "../lib/inventory.mjs";

export default async () => {
  const inv = await loadInventory();
  const changed = ageInventory(inv);
  if (changed.length) await saveInventory(inv);
  console.log(`Åldring: ${changed.length} poster satta till probably_out`);
};

export const config = { schedule: "0 3 * * *" };
