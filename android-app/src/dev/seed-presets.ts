import type { FoodRepository } from "../data/food-repository";
import type { Preset } from "../core/types";
const SEEDS: Array<Omit<Preset, "id" | "usage_count">> = [
  { name: "Jogurt naturalny", aliases: ["jogurt"], kcal: 61, protein_g: 4.3, carbs_g: 4.7, fat_g: 3.3, piece_weight_g: 150, slot_tags: ["breakfast"] },
  { name: "Chleb żytni", aliases: ["razowiec"], kcal: 259, protein_g: 8.5, carbs_g: 48, fat_g: 3.3, piece_weight_g: 35, slot_tags: ["breakfast", "lunch"] },
  { name: "Jabłko testowe", kcal: 52, protein_g: 0.3, carbs_g: 14, fat_g: 0.2, piece_weight_g: 170, slot_tags: ["lunch"] },
  { name: "Tofu fikcyjne", kcal: 144, protein_g: 17, carbs_g: 3, fat_g: 9, slot_tags: ["dinner"] },
  { name: "Olej testowy", kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100 },
];
export async function seedPresets(repository: FoodRepository): Promise<void> {
  const existing = new Set((await repository.listPresets()).map((preset) => preset.name));
  for (const seed of SEEDS) if (!existing.has(seed.name)) await repository.insertPreset(seed);
}
