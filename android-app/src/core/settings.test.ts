import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, validateSettings } from "./settings";

describe("app settings", () => {
  it("provides independent defaults and validates goals and clock boundaries", () => {
    const one = validateSettings(DEFAULT_SETTINGS);
    one.goals.kcal = 2200;
    expect(validateSettings(DEFAULT_SETTINGS).goals.kcal).toBe(2000);
    expect(validateSettings({ goals: { kcal: 1, protein_g: 0.5, carbs_g: 0, fat_g: 0 }, boundaries: { lunchStart: 0, dinnerStart: 1439 } })).toEqual({ goals: { kcal: 1, protein_g: 0.5, carbs_g: 0, fat_g: 0 }, boundaries: { lunchStart: 0, dinnerStart: 1439 } });
  });

  it("rejects empty-like, negative, non-finite, zero kcal, and invalid boundary values", () => {
    const base = { goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 }, boundaries: { lunchStart: 660, dinnerStart: 1020 } };
    for (const patch of [
      { goals: { ...base.goals, kcal: 0 } }, { goals: { ...base.goals, kcal: Number.NaN } },
      { goals: { ...base.goals, protein_g: -1 } }, { goals: { ...base.goals, fat_g: Number.POSITIVE_INFINITY } },
      { boundaries: { lunchStart: 1020, dinnerStart: 1020 } }, { boundaries: { lunchStart: 1100, dinnerStart: 1000 } },
      { boundaries: { lunchStart: 1440, dinnerStart: 1439 } },
    ]) expect(() => validateSettings({ ...base, ...patch } as typeof base)).toThrow();
  });
});
