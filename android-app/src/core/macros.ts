import type { FoodLogEntry, FoodLogSnapshot, Macros, Preset } from "./types";

const MACRO_KEYS = ["kcal", "protein_g", "carbs_g", "fat_g"] as const;

function finiteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative.`);
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive.`);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function validateMacros(macros: Macros): void {
  for (const key of MACRO_KEYS) finiteNonNegative(macros[key], key);
}

/** Scale a Preset's per-100 g macros. Zero grams is allowed and returns zero macros. */
export function macrosForGrams(preset: Macros, grams: number): Macros {
  finiteNonNegative(grams, "grams");
  validateMacros(preset);
  const factor = grams / 100;
  return {
    kcal: Math.round(preset.kcal * factor),
    protein_g: round1(preset.protein_g * factor),
    carbs_g: round1(preset.carbs_g * factor),
    fat_g: round1(preset.fat_g * factor),
  };
}

/** Return the total macros for current grams plus one whole piece. */
export function addOnePiece(preset: Preset, currentGrams: number): { qty: number; macros: Macros } {
  finiteNonNegative(currentGrams, "currentGrams");
  const pieceWeight = preset.piece_weight_g;
  if (pieceWeight == null) throw new RangeError("Preset has no valid piece_weight_g.");
  positive(pieceWeight, "piece_weight_g");
  const qty = currentGrams + pieceWeight;
  if (!Number.isFinite(qty)) throw new RangeError("Resulting grams must be finite.");
  return { qty, macros: macrosForGrams(preset, qty) };
}

/** Build a snapshot with its own macro values, independent of later Preset changes. */
export function createFoodLogSnapshot(preset: Preset, grams: number): FoodLogSnapshot {
  positive(grams, "grams");
  return { qty: grams, unit: "g", ...macrosForGrams(preset, grams) };
}

/** Proportionally rescale the stored snapshot, preserving all entry metadata. */
export function rescaleFoodLogEntry<T extends FoodLogEntry>(entry: T, newGrams: number): T {
  positive(entry.qty, "existing grams");
  positive(newGrams, "new grams");
  validateMacros(entry);
  const factor = newGrams / entry.qty;
  return {
    ...entry,
    qty: newGrams,
    kcal: Math.round(entry.kcal * factor),
    protein_g: round1(entry.protein_g * factor),
    carbs_g: round1(entry.carbs_g * factor),
    fat_g: round1(entry.fat_g * factor),
  };
}
