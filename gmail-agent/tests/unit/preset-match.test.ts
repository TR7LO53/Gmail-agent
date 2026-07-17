import { describe, it, expect } from "vitest";
import { matchPreset } from "../../src/nutrition/preset-match.js";
import type { FoodPreset } from "../../src/memory/presets.js";
import type { FoodQuery } from "../../src/nutrition/provider.js";

function preset(over: Partial<FoodPreset> = {}): FoodPreset {
  return {
    id: 1,
    name: "jajko",
    aliases: [],
    kcal: 155,
    protein_g: 13,
    carbs_g: 1.1,
    fat_g: 11,
    ...over,
  };
}

function query(over: Partial<FoodQuery> = {}): FoodQuery {
  return { original: "jajko", name: "egg", grams: 100, ...over };
}

describe("matchPreset", () => {
  it("matches a preset by its canonical name (case/whitespace-insensitive)", () => {
    const p = preset({ name: "jajko" });
    expect(matchPreset([p], query({ original: "  Jajko  " }))).toBe(p);
  });

  it("matches a preset by one of its aliases", () => {
    const p = preset({ name: "pierś z kurczaka", aliases: ["kurczak", "chicken breast"] });
    expect(matchPreset([p], query({ original: "Kurczak" }))).toBe(p);
  });

  it("returns undefined when no preset's name or aliases match", () => {
    const p = preset({ name: "jajko", aliases: ["egg"] });
    expect(matchPreset([p], query({ original: "chleb" }))).toBeUndefined();
  });

  it("picks the exact candidate among presets with overlapping aliases, not a partial/substring one", () => {
    const chickenBreast = preset({
      id: 1,
      name: "pierś z kurczaka",
      aliases: ["kurczak", "chicken breast"],
    });
    const chickenThigh = preset({
      id: 2,
      name: "udko z kurczaka",
      aliases: ["udko kurczaka"],
    });
    expect(matchPreset([chickenBreast, chickenThigh], query({ original: "udko kurczaka" }))).toBe(
      chickenThigh,
    );
  });
});
