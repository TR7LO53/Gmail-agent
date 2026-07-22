import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import {
  logFoodItems,
  listTodaysFood,
  todaysTotals,
  deleteLast,
  updateFoodLogWeight,
  deleteFoodLogRow,
  createManualFoodLogEntry,
  lastDayTotals,
  lastWeekAverage,
} from "../../src/memory/food.js";
import { addPreset, findPresetByName } from "../../src/memory/presets.js";
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

  it("updateFoodLogWeight recomputes macros from a matching preset", () => {
    addPreset(db, { name: "egg", kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 });
    logFoodItems(db, { source: "text", items: [{ name: "egg", qty: 100, unit: "g", kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 }] });
    const [row] = listTodaysFood(db, startOfLocalDayIso());

    const updated = updateFoodLogWeight(db, row.id, 50);

    expect(updated.qty).toBe(50);
    expect(updated.kcal).toBe(75);
    expect(updated.protein_g).toBe(6);
    expect(updated.carbs_g).toBe(0.5);
    expect(updated.fat_g).toBe(5);
  });

  it("updateFoodLogWeight scales proportionally when no preset matches", () => {
    logFoodItems(db, {
      source: "text",
      items: [{ name: "mystery casserole", qty: 200, unit: "g", kcal: 400, protein_g: 20, carbs_g: 30, fat_g: 10 }],
    });
    const [row] = listTodaysFood(db, startOfLocalDayIso());

    const updated = updateFoodLogWeight(db, row.id, 100);

    expect(updated.qty).toBe(100);
    expect(updated.kcal).toBe(200);
    expect(updated.protein_g).toBe(10);
    expect(updated.carbs_g).toBe(15);
    expect(updated.fat_g).toBe(5);
  });

  it("updateFoodLogWeight throws for an unknown row id", () => {
    expect(() => updateFoodLogWeight(db, 999, 100)).toThrow();
  });

  it("deleteFoodLogRow removes a single row and leaves the rest", () => {
    logFoodItems(db, { source: "text", items: [item({ name: "a" }), item({ name: "b" })] });
    const rows = listTodaysFood(db, startOfLocalDayIso());
    const [a, b] = rows;

    expect(deleteFoodLogRow(db, a.id)).toBe(true);

    const remaining = listTodaysFood(db, startOfLocalDayIso());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
  });

  it("deleteFoodLogRow returns false for an unknown row id", () => {
    expect(deleteFoodLogRow(db, 999)).toBe(false);
  });

  it("createManualFoodLogEntry uses a matching preset's macros, scaled to weight", () => {
    addPreset(db, { name: "egg", kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 });

    const row = createManualFoodLogEntry(db, { name: "egg", qty: 50 });

    expect(row.source).toBe("manual");
    expect(row.provenance).toBe("preset");
    expect(row.qty).toBe(50);
    expect(row.kcal).toBe(75);
    expect(row.protein_g).toBe(6);
    expect(row.carbs_g).toBe(0.5);
    expect(row.fat_g).toBe(5);
  });

  it("createManualFoodLogEntry with no matching preset uses typed macros and back-creates a preset", () => {
    const row = createManualFoodLogEntry(db, {
      name: "mystery casserole",
      qty: 200,
      kcal: 400,
      protein_g: 20,
      carbs_g: 30,
      fat_g: 10,
    });

    expect(row.source).toBe("manual");
    expect(row.provenance).toBe("preset");
    expect(row.kcal).toBe(400);
    expect(row.protein_g).toBe(20);

    const preset = findPresetByName(db, "mystery casserole");
    expect(preset?.kcal).toBe(200);
    expect(preset?.protein_g).toBe(10);
    expect(preset?.carbs_g).toBe(15);
    expect(preset?.fat_g).toBe(5);
  });

  it("createManualFoodLogEntry throws when no preset matches and macros are missing", () => {
    expect(() => createManualFoodLogEntry(db, { name: "unknown thing", qty: 100 })).toThrow();
  });

  it("lastDayTotals sums only rows within [sinceIso, untilIso)", () => {
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1 })],
      ts: "2026-07-20T10:00:00.000Z", // before the window — excluded
    });
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 200, protein_g: 10, carbs_g: 20, fat_g: 5 })],
      ts: "2026-07-21T08:00:00.000Z", // in the window
    });
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 50, protein_g: 2, carbs_g: 3, fat_g: 1 })],
      ts: "2026-07-21T20:00:00.000Z", // in the window
    });
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 999, protein_g: 99, carbs_g: 99, fat_g: 99 })],
      ts: "2026-07-22T05:00:00.000Z", // on/after the window end — excluded
    });

    const totals = lastDayTotals(db, "2026-07-21T00:00:00.000Z", "2026-07-22T00:00:00.000Z");

    // Worked by hand: only the two 2026-07-21 rows count -> 200+50, 10+2, 20+3, 5+1.
    expect(totals.kcal).toBe(250);
    expect(totals.protein_g).toBe(12);
    expect(totals.carbs_g).toBe(23);
    expect(totals.fat_g).toBe(6);
  });

  it("lastWeekAverage averages the 7-day window total by a fixed divisor of 7", () => {
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 1000, protein_g: 100, carbs_g: 100, fat_g: 100 })],
      ts: "2026-07-15T08:00:00.000Z", // one day before the window — excluded
    });
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 140, protein_g: 10, carbs_g: 10, fat_g: 5 })],
      ts: "2026-07-16T08:00:00.000Z",
    });
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 210, protein_g: 15, carbs_g: 15, fat_g: 7 })],
      ts: "2026-07-18T08:00:00.000Z",
    });
    logFoodItems(db, {
      source: "text",
      items: [item({ kcal: 350, protein_g: 25, carbs_g: 25, fat_g: 12 })],
      ts: "2026-07-22T08:00:00.000Z",
    });

    const avg = lastWeekAverage(db, "2026-07-16T00:00:00.000Z");

    // Worked by hand: window total is 140+210+350=700 kcal, 10+15+25=50 protein, etc. Divided by 7.
    expect(avg.kcal).toBe(100);
    expect(avg.protein_g).toBe(7.1);
    expect(avg.carbs_g).toBe(7.1);
    expect(avg.fat_g).toBe(3.4);
  });
});
