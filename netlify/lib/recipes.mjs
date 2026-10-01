// Receptbanken (SPEC-matplan.md, del C): sparade rätter från planen och
// recept från skärmdumpar, foton och text.
import { store, KEYS } from "./store.mjs";
import { newId, today } from "./http.mjs";
import { checkAgainstInventory } from "./shopping.mjs";

export const loadRecipes = async () => (await store.get(KEYS.recipes)) ?? [];
export const saveRecipes = (list) => store.put(KEYS.recipes, list);

export function makeRecipe(fields) {
  return {
    id: newId(),
    title: fields.title,
    source: fields.source ?? "import", // plan | import
    sourceType: fields.sourceType ?? null,
    sourceUrl: fields.sourceUrl ?? null,
    servings: Number(fields.servings) || 4,
    minutes: fields.minutes ?? null,
    styles: fields.styles ?? [],
    ingredients: (fields.ingredients ?? []).map((i) => ({
      name: i.name,
      qty: i.qty ?? null,
      unit: i.unit ?? "",
      confidence: i.confidence ?? "sure",
    })),
    steps: fields.steps ?? [],
    substitutions: fields.substitutions ?? [],
    pairings: fields.pairings ?? [],
    savedAt: today(),
  };
}

// En rätt ur matplanen blir ett recept när den får tumme upp.
export function recipeFromMeal(meal) {
  return makeRecipe({
    title: meal.title,
    source: "plan",
    servings: meal.people,
    minutes: meal.minutes,
    styles: ["asiatiskt", "italienskt", "mexikanskt", "husman"].includes(meal.style) ? [meal.style] : [],
    ingredients: [...meal.uses, ...meal.missing].map(({ name, qty, unit }) => ({ name, qty, unit })),
    steps: meal.steps,
    substitutions: meal.substitutions,
    pairings: meal.pairings,
  });
}

// Lägg på var ingredienserna finns hemma. Mängderna skalas i appen, så att antal
// personer kan ändras utan nytt anrop.
export function annotate(recipe, inventory) {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((i) => {
      const check = checkAgainstInventory(i.name, inventory);
      const have = check.verdict !== "ok";
      return { ...i, have, where: have ? check.found.map((f) => `${f.name} (${f.zone})`) : [] };
    }),
  };
}

// Gillar inte: sparas så att planeringen kan undvika liknande förslag.
export async function addFeedback(entry) {
  const list = (await store.get(KEYS.feedback)) ?? [];
  list.push({ ...entry, date: today() });
  await store.put(KEYS.feedback, list.slice(-50));
}

export async function avoidList() {
  const list = (await store.get(KEYS.feedback)) ?? [];
  return list
    .filter((f) => f.rating < 0)
    .slice(-20)
    .map((f) => (f.pairings?.length ? f.pairings.map((p) => p.ingredients.join(" + ")).join("; ") : `${f.title} (${f.mainProtein}, ${f.style})`));
}
