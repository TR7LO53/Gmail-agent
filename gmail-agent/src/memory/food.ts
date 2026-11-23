import type { DB } from "./db.js";
import { auditedWrite, MissingFoodDataError, type ActivityEntry } from "./audit.js";
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

export class FoodMacroRangeError extends Error {}

function round1(value: number): number {
  return Math.abs(value) > Number.MAX_VALUE / 10 ? value : Math.round(value * 10) / 10;
}

function scaleFoodMacros(macros: NutritionTotals, fromGrams: number, toGrams: number): NutritionTotals {
  const factor = toGrams / fromGrams;
  const scale = (value: number, decimals: 0 | 1) => {
    if (value === 0) return 0;
    let scaled = value * factor;
    if (!Number.isFinite(factor)) {
      // Two smaller ratios can keep the result finite even when their product would overflow.
      const midpoint = Math.sqrt(fromGrams) * Math.sqrt(toGrams);
      scaled = value * (midpoint / fromGrams) * (toGrams / midpoint);
    }
    if (!Number.isFinite(scaled)) {
      throw new FoodMacroRangeError("Scaled macros are outside the supported number range.");
    }
    if (decimals === 0) return Math.round(scaled);
    return round1(scaled);
  };
  return {
    kcal: scale(macros.kcal, 0),
    protein_g: scale(macros.protein_g, 1),
    carbs_g: scale(macros.carbs_g, 1),
    fat_g: scale(macros.fat_g, 1),
  };
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
  if (!existing) throw new MissingFoodDataError(`food_log row ${id} not found.`);
  const row = rowToFood(existing);

  const preset = matchPreset(listPresets(db), { original: row.name, name: row.name, grams: qty });

  // Legacy rows without a Preset keep their macros in proportion to the previous weight.
  const { kcal, protein_g, carbs_g, fat_g } = preset
    ? scaleFoodMacros(preset, 100, qty)
    : scaleFoodMacros(row, row.qty || qty, qty);
  const updated = db.prepare(
    "UPDATE food_log SET qty = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ? RETURNING *",
  ).get(qty, kcal, protein_g, carbs_g, fat_g, id);
  if (!updated) throw new Error("Food weight update returned no row.");
  return rowToFood(updated);
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

export class MissingManualMacrosError extends Error {}

/**
 * Create a food_log row by hand from the dashboard. If `name` matches an existing preset (same
 * exact-match logic as elsewhere), macros come from that preset scaled to `qty`. Otherwise the
 * caller's macros (for the entered weight) are used as-is, and a new preset is created from them,
 * back-calculated to per-100g — so every manual entry ends up backed by a preset either way.
 */
export function createManualFoodLogEntry(db: DB, input: ManualEntryInput): FoodRow {
  return auditedWrite(db, () => {
    const { name, qty } = input;
    const preset = matchPreset(listPresets(db), { original: name, name, grams: qty });
    let createdPreset: ActivityEntry | undefined;
    let { kcal, protein_g, carbs_g, fat_g } = input;
    if (preset) {
      ({ kcal, protein_g, carbs_g, fat_g } = scaleFoodMacros(preset, 100, qty));
    } else {
      if (kcal == null || protein_g == null || carbs_g == null || fat_g == null) {
        throw new MissingManualMacrosError(`No preset matches "${name}" — macros are required to log it.`);
      }
      const per100 = scaleFoodMacros({ kcal, protein_g, carbs_g, fat_g }, qty, 100);
      const created = addPreset(db, { name, ...per100 });
      createdPreset = { table: "food_presets", action: "created", name: created.name };
    }

    const inserted = db.prepare(
      `INSERT INTO food_log (ts, source, name, qty, unit, kcal, protein_g, carbs_g, fat_g, provenance)
       VALUES (?, 'manual', ?, ?, 'g', ?, ?, ?, ?, 'preset') RETURNING *`,
    ).get(new Date().toISOString(), name, qty, kcal, protein_g, carbs_g, fat_g);
    if (!inserted) throw new Error("Manual Entry insert returned no row.");

    const value = rowToFood(inserted);
    const createdFood: ActivityEntry = {
      table: "food_log", action: "created", id: value.id, name: value.name, qty,
    };
    return { value, entries: createdPreset ? [createdPreset, createdFood] : [createdFood] };
  });
}

/** Delete a single food_log row by id. Returns true if a row was removed. */
export function deleteFoodLogRow(db: DB, id: number): boolean {
  return deleteFoodLogRowReturningName(db, id) !== undefined;
}

export function deleteFoodLogRowReturningName(db: DB, id: number): string | undefined {
  const removed = db.prepare("DELETE FROM food_log WHERE id = ? RETURNING name").get(id);
  return removed?.name as string | undefined;
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
