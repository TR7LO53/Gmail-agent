import type { LLMProvider } from "../llm/provider.js";
import type { DB } from "../memory/db.js";
import type { NutritionProvider, NutritionItem, NutritionTotals } from "../nutrition/provider.js";
import { parseFoodItems } from "./parse-food.js";
import { logFoodItems, todaysTotals } from "../memory/food.js";
import { startOfLocalDayIso } from "../memory/emails.js";
import { nutritionGoals, type NutritionGoals } from "../config.js";
import { ok, fail, type ToolResponse } from "../tools/types.js";

/**
 * Shared meal-logging pipeline used by BOTH the CLI and the Discord bot:
 *   translate (PL->EN) -> nutrition.analyze (English) -> store -> return meal + day totals + goals.
 * The original (possibly Polish) text is kept as raw_input; the English query is kept as query_en.
 */
export interface LogMealDeps {
  llm: LLMProvider;
  nutrition: NutritionProvider;
  db: DB;
}

export interface LogMealResult {
  items: NutritionItem[];
  mealTotals: NutritionTotals;
  dayTotals: NutritionTotals;
  goals: NutritionGoals;
  queryEn: string;
}

export async function logMeal(
  rawText: string,
  source: "text" | "voice",
  deps: LogMealDeps,
): Promise<ToolResponse<LogMealResult>> {
  const text = rawText.trim();
  if (!text) return fail("Empty food message — nothing to log.");

  // Parse the meal into English food items + grams (also handles Polish → English).
  let items;
  try {
    items = await parseFoodItems(text, { llm: deps.llm });
  } catch (err) {
    return fail(`Couldn't understand the meal: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (items.length === 0) {
    return fail("Couldn't recognise any food in that message.");
  }

  // Look each item up in the nutrition database (USDA) and scale by grams.
  let result;
  try {
    result = await deps.nutrition.lookupItems(items);
  } catch (err) {
    return fail(`Nutrition lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.items.length === 0) {
    return fail("Couldn't recognise any food in that message.");
  }

  // Persist only the foods that actually matched the database (0-kcal misses aren't stored),
  // but keep every parsed food in the returned result so the reply can confirm each part.
  const stored = result.items.filter((i) => i.matched !== false);
  if (stored.length === 0) {
    return fail("Couldn't find those foods in the database. Try naming them more simply.");
  }

  const queryEn = items.map((i) => `${i.grams}g ${i.name}`).join(", ");
  logFoodItems(deps.db, { source, raw_input: text, query_en: queryEn, items: stored });
  const dayTotals = todaysTotals(deps.db, startOfLocalDayIso());

  return ok(
    { items: result.items, mealTotals: result.totals, dayTotals, goals: nutritionGoals(), queryEn },
    { diagnostics: { source, items: stored.length } },
  );
}
