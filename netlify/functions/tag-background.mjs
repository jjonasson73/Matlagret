// Bakgrundsfunktion: tagga lagerposter som saknar role (styles, role, kind).
// Körs en gång för det lager som fanns innan taggarna infördes; nya varor
// taggas redan vid kvitto- och fototolkningen.
import { checkKey } from "../lib/http.mjs";
import { loadInventory, saveInventory } from "../lib/inventory.mjs";
import { cleanStyles } from "../lib/rules.mjs";
import { tagItems } from "../lib/claude.mjs";

const CHUNK = 80;

export default async (req) => {
  if (checkKey(req)) return;
  const todo = (await loadInventory()).items.filter((i) => i.status !== "out" && !i.role);
  for (let i = 0; i < todo.length; i += CHUNK) {
    const { items: tags } = await tagItems(todo.slice(i, i + CHUNK));
    // Läs om lagret precis före sparning, så att ändringar gjorda under
    // Claude-anropet inte skrivs över. Bara taggfälten sätts.
    const inv = await loadInventory();
    for (const t of tags) {
      const item = inv.items.find((x) => x.id === t.id);
      if (!item || item.role) continue;
      item.styles = cleanStyles(t.styles);
      item.role = t.role;
      item.kind = t.kind || null;
    }
    await saveInventory(inv);
  }
  console.log(`Taggning klar: ${todo.length} poster`);
};
