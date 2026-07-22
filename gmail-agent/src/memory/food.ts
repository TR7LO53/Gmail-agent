import type { DB } from "./db.js";
import type { NutritionItem, NutritionTotals } from "../nutrition/provider.js";
import { addPreset, listPresets } from "./presets.js";
import { matchPreset } from "../nutrition/preset-match.js";

/**
 * Food log — one row per food item, grouped by a shared `ts` (a "meal" = all rows logged together).
 * Totals are computed over the local day, reusing the same day-boundary approach as emails.
 */

export interface FoodRow {
  id: number;
  ts: string;
  source: string;
  raw_input?: string;
  query_en?: string;
  /** The user's original (e.g. Polish) name for this food. */
  original?: string;
  name: string;
  qty?: number;
  unit?: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** Whether this item's macros came from a stored Preset or an external Lookup. */
  provenance?: "preset" | "lookup";
}

function rowToFood(row: Record<string, unknown>): FoodRow {
  return {
    id: row.id as number,
    ts: row.ts as string,
    source: row.source as string,
    raw_input: (row.raw_input as string | null) ?? undefined,
    query_en: (row.query_en as string | null) ?? undefined,
    original: (row.original as string | null) ?? undefined,
    name: row.name as string,
    qty: (row.qty as number | null) ?? undefined,
    unit: (row.unit as string | null) ?? undefined,
    kcal: row.kcal as number,
    protein_g: row.protein_g as number,
    carbs_g: row.carbs_g as number,
    fat_g: row.fat_g as number,
    provenance: (row.provenance as "preset" | "lookup" | null) ?? undefined,
  };
}

export interface LogFoodInput {
  source: "text" | "voice";
  raw_input?: string;
  query_en?: string;
  items: NutritionItem[];
  ts?: string;
}

/** Insert one row per item, all sharing a single timestamp (one "meal"). Returns rows inserted. */
export function logFoodItems(db: DB, input: LogFoodInput): number {
  const ts = input.ts ?? new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO food_log (ts, source, raw_input, query_en, original, name, qty, unit, kcal, protein_g, carbs_g, fat_g, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const it of input.items) {
    stmt.run(
      ts,
      input.source,
      input.raw_input ?? null,
      input.query_en ?? null,
      it.original ?? null,
      it.name,
      it.qty ?? null,
      it.unit ?? null,
      it.kcal,
      it.protein_g,
      it.carbs_g,
      it.fat_g,
      it.provenance ?? null,
    );
  }
  return input.items.length;
}

export function listTodaysFood(db: DB, sinceIso: string): FoodRow[] {
  const rows = db
    .prepare("SELECT * FROM food_log WHERE ts >= ? ORDER BY ts DESC, id DESC")
    .all(sinceIso) as Record<string, unknown>[];
  return rows.map(rowToFood);
}

/** Sum of macros for rows with ts >= sinceIso, optionally excluding ts >= untilIso. */
function sumRange(db: DB, sinceIso: string, untilIso?: string): NutritionTotals {
  const row = (
    untilIso
      ? db
          .prepare(
            `SELECT
               COALESCE(SUM(kcal), 0)      AS kcal,
               COALESCE(SUM(protein_g), 0) AS protein_g,
               COALESCE(SUM(carbs_g), 0)   AS carbs_g,
               COALESCE(SUM(fat_g), 0)     AS fat_g
             FROM food_log WHERE ts >= ? AND ts < ?`,
          )
          .get(sinceIso, untilIso)
      : db
          .prepare(
            `SELECT
               COALESCE(SUM(kcal), 0)      AS kcal,
               COALESCE(SUM(protein_g), 0) AS protein_g,
               COALESCE(SUM(carbs_g), 0)   AS carbs_g,
               COALESCE(SUM(fat_g), 0)     AS fat_g
             FROM food_log WHERE ts >= ?`,
          )
          .get(sinceIso)
  ) as Record<string, number>;
  return {
    kcal: Math.round(row.kcal),
    protein_g: Math.round(row.protein_g * 10) / 10,
    carbs_g: Math.round(row.carbs_g * 10) / 10,
    fat_g: Math.round(row.fat_g * 10) / 10,
  };
}

export function todaysTotals(db: DB, sinceIso: string): NutritionTotals {
  return sumRange(db, sinceIso);
}

/** Total macros for a single day window [sinceIso, untilIso) — e.g. yesterday only. */
export function lastDayTotals(db: DB, sinceIso: string, untilIso: string): NutritionTotals {
  return sumRange(db, sinceIso, untilIso);
}

/** Average daily macros over the rolling window starting at sinceIso (fixed 7-day divisor). */
export function lastWeekAverage(db: DB, sinceIso: string): NutritionTotals {
  const total = sumRange(db, sinceIso);
  return {
    kcal: Math.round(total.kcal / 7),
    protein_g: round1(total.protein_g / 7),
    carbs_g: round1(total.carbs_g / 7),
    fat_g: round1(total.fat_g / 7),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Edit only the weight of a food_log row. Macros are recomputed, never hand-set: if the row's
 * name matches a food_presets row (same exact-match logic as the bot's own matchPreset), macros
 * come from that preset's current per-100g values at the new weight.
 */
export function updateFoodLogWeight(db: DB, id: number, qty: number): FoodRow {
  const existing = db.prepare("SELECT * FROM food_log WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) throw new Error(`food_log row ${id} not found.`);
  const row = rowToFood(existing);

  const preset = matchPreset(listPresets(db), { original: row.name, name: row.name, grams: qty });

  let kcal: number, protein_g: number, carbs_g: number, fat_g: number;
  if (preset) {
    const factor = qty / 100;
    kcal = Math.round(preset.kcal * factor);
    protein_g = round1(preset.protein_g * factor);
    carbs_g = round1(preset.carbs_g * factor);
    fat_g = round1(preset.fat_g * factor);
  } else {
    // No matching preset (e.g. an older USDA-lookup row): scale proportionally from this row's
    // own previous macros instead, since there's no per-100g source to recompute from.
    const ratio = row.qty ? qty / row.qty : 1;
    kcal = Math.round(row.kcal * ratio);
    protein_g = round1(row.protein_g * ratio);
    carbs_g = round1(row.carbs_g * ratio);
    fat_g = round1(row.fat_g * ratio);
  }

  db.prepare(
    "UPDATE food_log SET qty = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?",
  ).run(qty, kcal, protein_g, carbs_g, fat_g, id);

  return rowToFood(
    db.prepare("SELECT * FROM food_log WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export interface ManualEntryInput {
  name: string;
  qty: number;
  /** Total macros for the entered weight — only used (and required) when no preset matches. */
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
}

/**
 * Create a food_log row by hand from the dashboard. If `name` matches an existing preset (same
 * exact-match logic as elsewhere), macros come from that preset scaled to `qty`. Otherwise the
 * caller's macros (for the entered weight) are used as-is, and a new preset is created from them,
 * back-calculated to per-100g — so every manual entry ends up backed by a preset either way.
 */
export function createManualFoodLogEntry(db: DB, input: ManualEntryInput): FoodRow {
  const { name, qty } = input;
  const preset = matchPreset(listPresets(db), { original: name, name, grams: qty });

  let kcal: number, protein_g: number, carbs_g: number, fat_g: number;
  if (preset) {
    const factor = qty / 100;
    kcal = Math.round(preset.kcal * factor);
    protein_g = round1(preset.protein_g * factor);
    carbs_g = round1(preset.carbs_g * factor);
    fat_g = round1(preset.fat_g * factor);
  } else {
    if (
      input.kcal == null ||
      input.protein_g == null ||
      input.carbs_g == null ||
      input.fat_g == null
    ) {
      throw new Error(`No preset matches "${name}" — macros are required to log it.`);
    }
    ({ kcal, protein_g, carbs_g, fat_g } = input as Required<ManualEntryInput>);
    const per100 = 100 / qty;
    addPreset(db, {
      name,
      kcal: Math.round(kcal * per100),
      protein_g: round1(protein_g * per100),
      carbs_g: round1(carbs_g * per100),
      fat_g: round1(fat_g * per100),
    });
  }

  const result = db
    .prepare(
      `INSERT INTO food_log (ts, source, name, qty, unit, kcal, protein_g, carbs_g, fat_g, provenance)
       VALUES (?, 'manual', ?, ?, 'g', ?, ?, ?, ?, 'preset')`,
    )
    .run(new Date().toISOString(), name, qty, kcal, protein_g, carbs_g, fat_g);

  return rowToFood(
    db.prepare("SELECT * FROM food_log WHERE id = ?").get(result.lastInsertRowid) as Record<
      string,
      unknown
    >,
  );
}

/** Delete a single food_log row by id. Returns true if a row was removed. */
export function deleteFoodLogRow(db: DB, id: number): boolean {
  const result = db.prepare("DELETE FROM food_log WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Delete the most recently logged meal (all rows sharing the latest ts). Returns rows removed. */
export function deleteLast(db: DB): number {
  const last = db.prepare("SELECT MAX(ts) AS ts FROM food_log").get() as { ts: string | null };
  if (!last.ts) return 0;
  const before = db.prepare("SELECT COUNT(*) AS n FROM food_log WHERE ts = ?").get(last.ts) as {
    n: number;
  };
  db.prepare("DELETE FROM food_log WHERE ts = ?").run(last.ts);
  return before.n;
}
