import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { logMeal } from "../../src/agents/nutrition-log.js";
import { listTodaysFood, todaysTotals } from "../../src/memory/food.js";
import { addPreset } from "../../src/memory/presets.js";
import { startOfLocalDayIso } from "../../src/memory/emails.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { NutritionProvider, FoodQuery } from "../../src/nutrition/provider.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

/** Fake LLM that parses to the given items (parseFoodItems reads `{ items }`). */
const parseTo = (items: FoodQuery[]): LLMProvider => ({
  async extract<T>(): Promise<T> {
    return { items } as T;
  },
});

describe("logMeal pipeline (USDA)", () => {
  let db: DB;
  beforeEach(() => {
    db = memDb();
  });

  it("parses to items, sends them to the provider, and stores the original text", async () => {
    let seen: FoodQuery[] = [];
    const nutrition: NutritionProvider = {
      async lookupItems(items) {
        seen = items;
        return {
          items: [{ original: items[0].original, name: "egg", qty: 100, kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10, matched: true }],
          totals: { kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 },
        };
      },
    };

    const r = await logMeal("2 jajka", "text", {
      llm: parseTo([{ original: "jajko", name: "egg", grams: 100 }]),
      nutrition,
      db,
    });

    expect(r.success).toBe(true);
    expect(seen).toEqual([{ original: "jajko", name: "egg", grams: 100 }]); // parsed items reached the provider
    const rows = listTodaysFood(db, startOfLocalDayIso());
    expect(rows[0].raw_input).toBe("2 jajka"); // whole original message kept
    expect(rows[0].original).toBe("jajko"); // per-item Polish name stored
    expect(rows[0].query_en).toBe("100g egg");
    expect(todaysTotals(db, startOfLocalDayIso()).kcal).toBe(150);
    expect(r.data?.goals.kcal).toBeGreaterThan(0);
  });

  it("a message where every food matches a Preset never calls the nutrition lookup", async () => {
    addPreset(db, { name: "jajko", aliases: ["egg"], kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 });
    let lookupCalled = false;
    const nutrition: NutritionProvider = {
      async lookupItems() {
        lookupCalled = true;
        return { items: [], totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } };
      },
    };

    const r = await logMeal("jajko", "text", {
      llm: parseTo([{ original: "jajko", name: "egg", grams: 100 }]),
      nutrition,
      db,
    });

    expect(r.success).toBe(true);
    expect(lookupCalled).toBe(false);
    const rows = listTodaysFood(db, startOfLocalDayIso());
    expect(rows[0].kcal).toBe(150);
    expect(rows[0].provenance).toBe("preset");
  });

  it("a mixed message logs one Meal with each Item resolved from its actual source", async () => {
    addPreset(db, { name: "jajko", aliases: ["egg"], kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 });
    let lookupSeen: FoodQuery[] = [];
    const nutrition: NutritionProvider = {
      async lookupItems(items) {
        lookupSeen = items;
        return {
          items: [
            { original: items[0].original, name: "bread", qty: items[0].grams, kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1, matched: true },
          ],
          totals: { kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1 },
        };
      },
    };

    const r = await logMeal("jajko i chleb", "text", {
      llm: parseTo([
        { original: "jajko", name: "egg", grams: 100 },
        { original: "chleb", name: "bread", grams: 50 },
      ]),
      nutrition,
      db,
    });

    expect(r.success).toBe(true);
    expect(lookupSeen).toEqual([{ original: "chleb", name: "bread", grams: 50 }]); // only the unmatched item hit the lookup
    const rows = listTodaysFood(db, startOfLocalDayIso());
    expect(rows).toHaveLength(2);
    const presetRow = rows.find((row) => row.original === "jajko");
    const lookupRow = rows.find((row) => row.original === "chleb");
    expect(presetRow?.provenance).toBe("preset");
    expect(presetRow?.kcal).toBe(150);
    expect(lookupRow?.provenance).toBe("lookup");
    expect(lookupRow?.kcal).toBe(80);
  });

  it("fails (nothing stored) when the parser finds no food", async () => {
    let called = false;
    const nutrition: NutritionProvider = {
      async lookupItems() {
        called = true;
        return { items: [], totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } };
      },
    };
    const r = await logMeal("blablabla", "text", { llm: parseTo([]), nutrition, db });
    expect(r.success).toBe(false);
    expect(called).toBe(false); // short-circuits before the DB lookup
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(0);
  });

  it("fails (nothing stored) when every food is unmatched", async () => {
    const nutrition: NutritionProvider = {
      async lookupItems(items) {
        return {
          items: items.map((i) => ({
            original: i.original,
            name: i.name,
            qty: i.grams,
            kcal: 0,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            matched: false,
          })),
          totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
        };
      },
    };
    const r = await logMeal("xyzzy", "text", {
      llm: parseTo([{ original: "xyzzy", name: "xyzzy", grams: 100 }]),
      nutrition,
      db,
    });
    expect(r.success).toBe(false);
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(0);
  });
});
