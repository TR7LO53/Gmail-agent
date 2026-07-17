import type { FoodPreset } from "../memory/presets.js";
import type { FoodQuery, NutritionItem } from "./provider.js";

/**
 * Deterministic alias matching (see docs/adr/0001-deterministic-preset-food-library.md): a Preset
 * matches only when the query's original-language text is an exact, normalized equal of the
 * Preset's name or one of its aliases — never a substring or fuzzy match.
 */

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function matchPreset(presets: FoodPreset[], query: FoodQuery): FoodPreset | undefined {
  const needle = normalize(query.original);
  return presets.find(
    (p) => normalize(p.name) === needle || p.aliases.some((a) => normalize(a) === needle),
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Pure per-100 g → grams scaling, mirroring `mapUsdaFood` but sourced from a stored Preset. */
export function mapPresetToItem(preset: FoodPreset, query: FoodQuery): NutritionItem {
  const factor = query.grams / 100;
  return {
    original: query.original,
    name: preset.name,
    qty: query.grams,
    unit: "g",
    kcal: Math.round(preset.kcal * factor),
    protein_g: round1(preset.protein_g * factor),
    carbs_g: round1(preset.carbs_g * factor),
    fat_g: round1(preset.fat_g * factor),
    matched: true,
    provenance: "preset",
  };
}
