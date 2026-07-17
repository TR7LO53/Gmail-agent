import type { LLMProvider } from "../llm/provider.js";
import type { DB } from "../memory/db.js";
import type { NutritionProvider, NutritionItem, NutritionTotals, FoodQuery } from "../nutrition/provider.js";
import { sumTotals } from "../nutrition/provider.js";
import { parseFoodItems } from "./parse-food.js";
import { logFoodItems, todaysTotals } from "../memory/food.js";
import { startOfLocalDayIso } from "../memory/emails.js";
import { nutritionGoals, type NutritionGoals } from "../config.js";
import { ok, fail, type ToolResponse } from "../tools/types.js";
import { listPresets } from "../memory/presets.js";
import { matchPreset, mapPresetToItem } from "../nutrition/preset-match.js";

/**
 * Resolves each parsed food against the Preset list first (deterministic alias match), falling
 * back to the external nutrition lookup only for foods with no Preset match. Never calls the
 * lookup at all when every food resolves from a Preset.
 */
async function resolveItems(
  items: FoodQuery[],
  deps: LogMealDeps,
): Promise<NutritionItem[]> {
  const presets = listPresets(deps.db);
  const resolved: (NutritionItem | undefined)[] = items.map((q) => {
    const preset = matchPreset(presets, q);
    return preset ? mapPresetToItem(preset, q) : undefined;
  });

  const unresolvedIndexes = resolved.reduce<number[]>((acc, item, i) => {
    if (!item) acc.push(i);
    return acc;
  }, []);

  if (unresolvedIndexes.length > 0) {
    const lookupResult = await deps.nutrition.lookupItems(unresolvedIndexes.map((i) => items[i]));
    unresolvedIndexes.forEach((origIndex, i) => {
      const item = lookupResult.items[i];
      if (item) resolved[origIndex] = { ...item, provenance: "lookup" };
    });
  }

  return resolved.filter((i): i is NutritionItem => i !== undefined);
}

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

  // Resolve each item against the Preset list first, falling back to the nutrition database
  // (USDA) only for foods with no Preset match, then scale by grams.
  let resolvedItems: NutritionItem[];
  try {
    resolvedItems = await resolveItems(items, deps);
  } catch (err) {
    return fail(`Nutrition lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resolvedItems.length === 0) {
    return fail("Couldn't recognise any food in that message.");
  }

  // Persist only the foods that actually matched (0-kcal misses aren't stored), but keep every
  // parsed food in the returned result so the reply can confirm each part.
  const stored = resolvedItems.filter((i) => i.matched !== false);
  if (stored.length === 0) {
    return fail("Couldn't find those foods in the database. Try naming them more simply.");
  }

  const queryEn = items.map((i) => `${i.grams}g ${i.name}`).join(", ");
  logFoodItems(deps.db, { source, raw_input: text, query_en: queryEn, items: stored });
  const dayTotals = todaysTotals(deps.db, startOfLocalDayIso());

  return ok(
    { items: resolvedItems, mealTotals: sumTotals(resolvedItems), dayTotals, goals: nutritionGoals(), queryEn },
    { diagnostics: { source, items: stored.length } },
  );
}
