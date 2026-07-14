import { describe, it, expect } from "vitest";
import { mapUsdaFood, sumTotals, pickBest } from "../../src/nutrition/provider.js";
import { parseFoodItems } from "../../src/agents/parse-food.js";
import type { LLMProvider } from "../../src/llm/provider.js";

describe("mapUsdaFood (per-100g → grams scaling)", () => {
  const egg = {
    description: "Egg, whole, raw",
    foodNutrients: [
      { nutrientNumber: "208", value: 143 },
      { nutrientNumber: "203", value: 12.6 },
      { nutrientNumber: "204", value: 9.5 },
      { nutrientNumber: "205", value: 0.7 },
    ],
  };

  it("reads per-100g nutrients at 100 g", () => {
    const item = mapUsdaFood(egg, { original: "jajko", name: "egg", grams: 100 });
    expect(item.kcal).toBe(143);
    expect(item.protein_g).toBe(12.6);
    expect(item.fat_g).toBe(9.5);
    expect(item.carbs_g).toBe(0.7);
    expect(item.name).toBe("egg, whole, raw");
    expect(item.qty).toBe(100);
  });

  it("scales by grams", () => {
    const half = mapUsdaFood(egg, { original: "jajko", name: "egg", grams: 50 });
    expect(half.kcal).toBe(72); // round(71.5)
    expect(half.protein_g).toBe(6.3);
  });

  it("falls back to a named KCAL energy entry", () => {
    const food = {
      description: "x",
      foodNutrients: [
        { nutrientName: "Energy", unitName: "KCAL", value: 100 },
        { nutrientNumber: "203", value: 5 },
      ],
    };
    expect(mapUsdaFood(food, { original: "x", name: "x", grams: 100 }).kcal).toBe(100);
  });

  it("reads Atwater kcal (nutrientNumber 958) when 208 is absent", () => {
    const food = {
      description: "chicken breast",
      foodNutrients: [
        { nutrientNumber: "958", value: 165 },
        { nutrientNumber: "203", value: 31 },
      ],
    };
    expect(mapUsdaFood(food, { original: "kurczak", name: "chicken", grams: 100 }).kcal).toBe(165);
  });

  it("returns an unmatched (zeroed) item when no food is given", () => {
    const item = mapUsdaFood(undefined, { original: "boczek", name: "bacon", grams: 30 });
    expect(item.matched).toBe(false);
    expect(item.kcal).toBe(0);
    expect(item.original).toBe("boczek");
    expect(item.qty).toBe(30);
  });
});

describe("pickBest", () => {
  it("skips an energy-less top hit and takes the first with real macros", () => {
    const sparse = { description: "chicken breast, raw sample", foodNutrients: [{ nutrientNumber: "203", value: 23 }] }; // no energy
    const good = {
      description: "chicken breast, cooked",
      foodNutrients: [
        { nutrientNumber: "208", value: 165 },
        { nutrientNumber: "203", value: 31 },
      ],
    };
    expect(pickBest([sparse, good])).toBe(good);
  });

  it("prefers a plain generic food over a processed/breaded one", () => {
    const breaded = {
      description: "Chicken breast tenders, breaded, cooked, microwaved",
      dataType: "Survey (FNDDS)",
      foodNutrients: [
        { nutrientNumber: "208", value: 252 },
        { nutrientNumber: "203", value: 16 },
      ],
    };
    const plain = {
      description: "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
      dataType: "SR Legacy",
      foodNutrients: [
        { nutrientNumber: "208", value: 165 },
        { nutrientNumber: "203", value: 31 },
      ],
    };
    expect(pickBest([breaded, plain])).toBe(plain);
  });

  it("returns undefined for no results", () => {
    expect(pickBest([])).toBeUndefined();
  });
});

describe("sumTotals", () => {
  it("adds items", () => {
    expect(
      sumTotals([
        { name: "a", kcal: 100, protein_g: 10, carbs_g: 5, fat_g: 2 },
        { name: "b", kcal: 50, protein_g: 2, carbs_g: 8, fat_g: 1 },
      ]),
    ).toEqual({ kcal: 150, protein_g: 12, carbs_g: 13, fat_g: 3 });
  });
});

describe("parseFoodItems", () => {
  it("returns rounded FoodQuery[] and drops empty/zero items", async () => {
    const llm: LLMProvider = {
      async extract<T>(): Promise<T> {
        return {
          items: [
            { original: "jajko", name: "egg", grams: 100.4 },
            { name: "  ", grams: 50 },
            { name: "toast", grams: 0 },
            { original: "ryż", name: "rice", grams: 150.5 },
          ],
        } as T;
      },
    };
    const r = await parseFoodItems("2 jajka i ryż", { llm });
    expect(r).toEqual([
      { original: "jajko", name: "egg", grams: 100 },
      { original: "ryż", name: "rice", grams: 151 },
    ]);
  });
});
