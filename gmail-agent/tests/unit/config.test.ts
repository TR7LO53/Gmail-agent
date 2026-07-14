import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { trackedCategory, nutritionGoals } from "../../src/config.js";

const ORIGINAL = process.env.GGENT_CATEGORY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GGENT_CATEGORY;
  else process.env.GGENT_CATEGORY = ORIGINAL;
});

describe("trackedCategory", () => {
  it("defaults to primary when unset", () => {
    delete process.env.GGENT_CATEGORY;
    expect(trackedCategory()).toBe("primary");
  });

  it("honours an override", () => {
    process.env.GGENT_CATEGORY = "updates";
    expect(trackedCategory()).toBe("updates");
  });

  it("returns undefined (no filter) for 'all' or empty", () => {
    process.env.GGENT_CATEGORY = "all";
    expect(trackedCategory()).toBeUndefined();
    process.env.GGENT_CATEGORY = "";
    expect(trackedCategory()).toBeUndefined();
  });
});

describe("nutritionGoals", () => {
  const KEYS = [
    "NUTRITION_GOAL_KCAL",
    "NUTRITION_GOAL_PROTEIN_G",
    "NUTRITION_GOAL_CARBS_G",
    "NUTRITION_GOAL_FAT_G",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults when unset", () => {
    expect(nutritionGoals()).toEqual({ kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 });
  });

  it("reads overrides from env", () => {
    process.env.NUTRITION_GOAL_KCAL = "1800";
    process.env.NUTRITION_GOAL_PROTEIN_G = "180";
    expect(nutritionGoals().kcal).toBe(1800);
    expect(nutritionGoals().protein_g).toBe(180);
  });
});
