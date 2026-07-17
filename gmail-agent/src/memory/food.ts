import type { DB } from "./db.js";
import type { NutritionItem, NutritionTotals } from "../nutrition/provider.js";

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

export function todaysTotals(db: DB, sinceIso: string): NutritionTotals {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(kcal), 0)      AS kcal,
         COALESCE(SUM(protein_g), 0) AS protein_g,
         COALESCE(SUM(carbs_g), 0)   AS carbs_g,
         COALESCE(SUM(fat_g), 0)     AS fat_g
       FROM food_log WHERE ts >= ?`,
    )
    .get(sinceIso) as Record<string, number>;
  return {
    kcal: Math.round(row.kcal),
    protein_g: Math.round(row.protein_g * 10) / 10,
    carbs_g: Math.round(row.carbs_g * 10) / 10,
    fat_g: Math.round(row.fat_g * 10) / 10,
  };
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
