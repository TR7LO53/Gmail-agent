/**
 * Which Gmail category tab Ggent's automated scans look at. Defaults to the "Primary" tab, so
 * Social/Promotions/Updates/Forums are ignored. Change with the env var, no code edits:
 *
 *   GGENT_CATEGORY=primary   (default)
 *   GGENT_CATEGORY=updates   (many carriers land here — track this instead)
 *   GGENT_CATEGORY=all       (or empty) — scan everything, no category filter
 *
 * Returns undefined when scanning should NOT be restricted to a category.
 */
export function trackedCategory(): string | undefined {
  const c = (process.env.GGENT_CATEGORY ?? "primary").trim().toLowerCase();
  return c === "" || c === "all" ? undefined : c;
}

/** Daily nutrition targets the dashboard and chat replies track intake against. Env-configurable. */
export interface NutritionGoals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

function envNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function nutritionGoals(): NutritionGoals {
  return {
    kcal: envNum(process.env.NUTRITION_GOAL_KCAL, 2000),
    protein_g: envNum(process.env.NUTRITION_GOAL_PROTEIN_G, 150),
    carbs_g: envNum(process.env.NUTRITION_GOAL_CARBS_G, 200),
    fat_g: envNum(process.env.NUTRITION_GOAL_FAT_G, 70),
  };
}
