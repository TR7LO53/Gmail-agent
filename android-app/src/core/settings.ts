import type { Macros } from "./types";
import { DEFAULT_SLOT_BOUNDARIES, type SlotBoundaries } from "./slot";

export interface AppSettings {
  goals: Macros;
  boundaries: Required<SlotBoundaries>;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  goals: Object.freeze({ kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 }),
  boundaries: DEFAULT_SLOT_BOUNDARIES,
});

export function validateSettings(value: AppSettings): AppSettings {
  if (!value || typeof value !== "object" || !value.goals || !value.boundaries) throw new TypeError("Uzupełnij wszystkie ustawienia.");
  const goals = { kcal: value.goals.kcal, protein_g: value.goals.protein_g, carbs_g: value.goals.carbs_g, fat_g: value.goals.fat_g };
  if (!Number.isFinite(goals.kcal) || goals.kcal <= 0) throw new RangeError("Cel kcal musi być liczbą większą od zera.");
  for (const [name, goal] of Object.entries(goals).slice(1)) {
    if (!Number.isFinite(goal) || goal < 0) throw new RangeError(`Cel ${name} musi być liczbą nieujemną.`);
  }
  const { lunchStart, dinnerStart } = value.boundaries;
  for (const [name, minute] of Object.entries({ lunchStart, dinnerStart })) {
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) throw new RangeError(`${name} musi być minutą od 0 do 1439.`);
  }
  if (lunchStart >= dinnerStart) throw new RangeError("Początek obiadu musi być przed początkiem kolacji.");
  return { goals, boundaries: { lunchStart, dinnerStart } };
}

export function copySettings(value: AppSettings): AppSettings {
  return { goals: { ...value.goals }, boundaries: { ...value.boundaries } };
}
