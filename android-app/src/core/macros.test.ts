import { describe, expect, it } from "vitest";
import { addOnePiece, createFoodLogSnapshot, macrosForGrams, rescaleFoodLogEntry } from "./macros";
import type { Preset } from "./types";

const preset: Preset = {
  id: "oats", name: "Owsianka", kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10,
  piece_weight_g: 50,
};

describe("macros", () => {
  it("scales per-100g macros and rounds kcal / macros consistently", () => {
    expect(macrosForGrams(preset, 100)).toEqual({ kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 });
    expect(macrosForGrams(preset, 50)).toEqual({ kcal: 75, protein_g: 6, carbs_g: 0.5, fat_g: 5 });
    expect(macrosForGrams(preset, 150)).toEqual({ kcal: 225, protein_g: 18, carbs_g: 1.5, fat_g: 15 });
    expect(macrosForGrams({ kcal: 3, protein_g: 1.26, carbs_g: 0.24, fat_g: 2.05 }, 50)).toEqual({
      kcal: 2, protein_g: 0.6, carbs_g: 0.1, fat_g: 1,
    });
    expect(macrosForGrams(preset, 0.5)).toEqual({ kcal: 1, protein_g: 0.1, carbs_g: 0, fat_g: 0.1 });
    expect(macrosForGrams(preset, 0)).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  });

  it("adds one piece to grams and recalculates at the final weight", () => {
    expect(addOnePiece(preset, 80)).toEqual({ qty: 130, macros: { kcal: 195, protein_g: 15.6, carbs_g: 1.3, fat_g: 13 } });
    expect(addOnePiece(preset, 0).qty).toBe(50);
    expect(addOnePiece(preset, 100).qty).toBe(150);
    for (const weight of [undefined, 0, -2, Infinity]) {
      expect(() => addOnePiece({ ...preset, piece_weight_g: weight }, 0)).toThrow(RangeError);
    }
  });

  it("creates independent snapshots and rescales only their stored macros", () => {
    const snapshot = createFoodLogSnapshot(preset, 100);
    const changedPreset = { ...preset, name: "Zmiana", kcal: 999 };
    expect(snapshot).toEqual({ qty: 100, unit: "g", kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 });
    expect(changedPreset.kcal).toBe(999);

    const entry = { id: 9, ts: "2026-10-14T08:00:00Z", name: "Owsianka", preset_id: "oats", ...snapshot };
    expect(rescaleFoodLogEntry(entry, 150)).toEqual({
      ...entry, qty: 150, kcal: 225, protein_g: 18, carbs_g: 1.5, fat_g: 15,
    });
    expect(rescaleFoodLogEntry(entry, 50)).toMatchObject({ qty: 50, kcal: 75, protein_g: 6 });
    expect(rescaleFoodLogEntry(entry, 100)).toEqual(entry);
    expect(entry.qty).toBe(100);
    expect(() => createFoodLogSnapshot(preset, 0)).toThrow(RangeError);
    expect(() => rescaleFoodLogEntry({ ...entry, qty: 0 }, 50)).toThrow(RangeError);
    expect(() => rescaleFoodLogEntry(entry, -1)).toThrow(RangeError);
  });
});
