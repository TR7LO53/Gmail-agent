import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { logFoodItems, listTodaysFood, todaysTotals, deleteLast } from "../../src/memory/food.js";
import { startOfLocalDayIso } from "../../src/memory/emails.js";
import type { DB } from "../../src/memory/db.js";
import type { NutritionItem } from "../../src/nutrition/provider.js";

function memDb(): DB {
  return openDb(":memory:");
}

const item = (over: Partial<NutritionItem> = {}): NutritionItem => ({
  name: "egg",
  kcal: 78,
  protein_g: 6,
  carbs_g: 0.6,
  fat_g: 5,
  ...over,
});

describe("food log", () => {
  let db: DB;
  beforeEach(() => {
    db = memDb();
  });

  it("logs items and sums today's totals", () => {
    logFoodItems(db, {
      source: "text",
      items: [item(), item({ name: "toast", kcal: 100, protein_g: 3, carbs_g: 20, fat_g: 1 })],
    });
    const t = todaysTotals(db, startOfLocalDayIso());
    expect(t.kcal).toBe(178);
    expect(t.protein_g).toBeCloseTo(9, 1);
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(2);
  });

  it("excludes items logged before today", () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    logFoodItems(db, { source: "text", items: [item()], ts: yesterday });
    logFoodItems(db, {
      source: "text",
      items: [item({ name: "apple", kcal: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 })],
    });
    const rows = listTodaysFood(db, startOfLocalDayIso());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("apple");
    expect(todaysTotals(db, startOfLocalDayIso()).kcal).toBe(95);
  });

  it("keeps raw_input, query_en and the per-item original name", () => {
    logFoodItems(db, {
      source: "voice",
      raw_input: "2 jajka",
      query_en: "2 eggs",
      items: [item({ original: "jajko" })],
    });
    const row = listTodaysFood(db, startOfLocalDayIso())[0];
    expect(row.source).toBe("voice");
    expect(row.raw_input).toBe("2 jajka");
    expect(row.query_en).toBe("2 eggs");
    expect(row.original).toBe("jajko");
  });

  it("deleteLast removes only the most recent meal", () => {
    logFoodItems(db, { source: "text", items: [item()], ts: "2026-07-01T08:00:00.000Z" });
    logFoodItems(db, {
      source: "text",
      items: [item({ name: "a" }), item({ name: "b" })],
      ts: "2026-07-01T12:00:00.000Z",
    });
    expect(deleteLast(db)).toBe(2);
    const remaining = db.prepare("SELECT * FROM food_log").all() as unknown[];
    expect(remaining).toHaveLength(1);
  });
});
