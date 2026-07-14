import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { logMeal } from "../../src/agents/nutrition-log.js";
import { listTodaysFood, todaysTotals } from "../../src/memory/food.js";
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
