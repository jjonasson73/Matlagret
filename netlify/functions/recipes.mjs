// GET  /api/recipes – sparade recept, med var ingredienserna finns hemma.
// POST /api/recipes:
//   { action: "like", slot }      👍 på en rätt i matplanen – sparas som recept
//   { action: "dislike", slot }   👎 – liknande förslag undviks framöver
//   { action: "delete", id }
import { json, error, checkKey, safe } from "../lib/http.mjs";
import { loadInventory } from "../lib/inventory.mjs";
import { loadPlan, savePlan } from "../lib/planner.mjs";
import { loadRecipes, saveRecipes, recipeFromMeal, annotate, addFeedback } from "../lib/recipes.mjs";

async function list() {
  const [recipes, inventory] = await Promise.all([loadRecipes(), loadInventory()]);
  return [...recipes].reverse().map((r) => annotate(r, inventory));
}

export default safe("recipes", async (req) => {
  const denied = checkKey(req);
  if (denied) return denied;

  if (req.method === "GET") return json({ recipes: await list() });
  if (req.method !== "POST") return error("Använd GET eller POST", 405);

  const body = await req.json().catch(() => null);
  if (!body?.action) return error("action saknas");

  if (body.action === "delete") {
    const recipes = await loadRecipes();
    await saveRecipes(recipes.filter((r) => r.id !== body.id));
    return json({ ok: true, recipes: await list() });
  }

  if (body.action === "like" || body.action === "dislike") {
    const plan = await loadPlan();
    const meal = plan.meals?.find((m) => m.slot === Number(body.slot));
    if (!meal) return error("Rätten finns inte i planen", 404);
    const rating = body.action === "like" ? 1 : -1;
    if (meal.rating === rating) return json({ ok: true, plan, recipes: await list() });

    if (rating > 0) {
      const recipes = await loadRecipes();
      if (!recipes.some((r) => r.title.toLowerCase() === meal.title.toLowerCase())) {
        recipes.push(recipeFromMeal(meal));
        await saveRecipes(recipes);
      }
    }
    await addFeedback({ title: meal.title, mainProtein: meal.mainProtein, style: meal.style, pairings: meal.pairings ?? [], rating });
    meal.rating = rating;
    await savePlan(plan);
    return json({ ok: true, plan, recipes: await list() });
  }

  return error(`Okänd action: ${body.action}`);
});

export const config = { path: "/api/recipes" };
