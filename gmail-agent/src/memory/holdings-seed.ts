import history from "../markets/data/holdings-history.json" with { type: "json" };
import type { DB } from "./db.js";
import { isRealDate } from "./holdings.js";

/**
 * One-time history of Strategy's holdings (SEC EDGAR, from August 2020), loaded the first time the
 * `holdings_snapshots` table is empty. The file is built by hand with
 * `npm run build-holdings-history` — see src/markets/data/README.md. The JSON is imported
 * relative to this module, never read through process.cwd().
 */
export interface HoldingsSeedRow {
  date: string;
  btc_held: number;
  shares_outstanding: number;
}

export interface HoldingsHistory {
  metadata: Record<string, unknown>;
  snapshots: HoldingsSeedRow[];
}

/** Throws if the history is empty, unsorted, has bad numbers or does not start in August 2020. */
export function validateHoldingsHistory(data: HoldingsHistory): void {
  if (!data || !Array.isArray(data.snapshots) || data.snapshots.length === 0) {
    throw new Error("Holdings history must contain snapshots.");
  }
  let previous = "";
  for (const row of data.snapshots) {
    if (!isRealDate(row.date) || row.date <= previous) {
      throw new Error(`Invalid or unsorted holdings date: ${row.date}`);
    }
    if (!Number.isFinite(row.btc_held) || row.btc_held <= 0) {
      throw new Error(`Invalid BTC balance at ${row.date}`);
    }
    if (!Number.isSafeInteger(row.shares_outstanding) || row.shares_outstanding <= 0) {
      throw new Error(`Invalid shares at ${row.date}`);
    }
    previous = row.date;
  }
  if (!data.snapshots[0].date.startsWith("2020-08")) {
    throw new Error("Holdings history must begin in August 2020.");
  }
}

/**
 * Insert the history as automatic snapshots, but only when the table has no rows at all.
 * Returns how many rows were inserted (0 when the table was not empty).
 * Rows go in directly: the history has jumps above 10%, so the sanity check of
 * `saveHoldingsSnapshot` must not apply. Writes to no other table.
 */
export function seedHoldingsSnapshots(db: DB, data: HoldingsHistory = history as HoldingsHistory): number {
  const countRows = () =>
    (db.prepare("SELECT COUNT(*) AS count FROM holdings_snapshots").get() as { count: number }).count;
  // Every openDb call lands here: skip validation and the write lock once the table has rows.
  if (countRows() > 0) return 0;

  validateHoldingsHistory(data);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (countRows() > 0) {
      db.exec("COMMIT");
      return 0;
    }
    const insert = db.prepare(
      "INSERT INTO holdings_snapshots (date, btc_held, shares_outstanding, source, created_at) VALUES (?, ?, ?, 'automatic', ?)",
    );
    const createdAt = new Date().toISOString();
    for (const row of data.snapshots) {
      insert.run(row.date, row.btc_held, row.shares_outstanding, createdAt);
    }
    db.exec("COMMIT");
    return data.snapshots.length;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
