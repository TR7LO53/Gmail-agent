import history from "../markets/data/holdings-history.json" with { type: "json" };
import type { DB } from "./db.js";

export interface HoldingsSeedRow {
  date: string;
  btc_held: number;
  shares_outstanding: number;
}

export interface HoldingsHistory {
  metadata: Record<string, unknown>;
  snapshots: HoldingsSeedRow[];
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateHoldingsHistory(data: HoldingsHistory): void {
  if (!data || !Array.isArray(data.snapshots) || data.snapshots.length === 0) {
    throw new Error("Holdings history must contain snapshots.");
  }
  let previous = "";
  for (const row of data.snapshots) {
    if (!validDate(row.date) || row.date <= previous) throw new Error(`Invalid or unsorted holdings date: ${row.date}`);
    if (!Number.isFinite(row.btc_held) || row.btc_held <= 0) throw new Error(`Invalid BTC balance at ${row.date}`);
    if (!Number.isSafeInteger(row.shares_outstanding) || row.shares_outstanding <= 0) throw new Error(`Invalid shares at ${row.date}`);
    previous = row.date;
  }
  if (!data.snapshots[0].date.startsWith("2020-08")) throw new Error("Holdings history must begin in August 2020.");
}

export function seedHoldingsSnapshots(db: DB, data: HoldingsHistory = history as HoldingsHistory): number {
  validateHoldingsHistory(data);
  db.exec("BEGIN IMMEDIATE");
  try {
    const count = (db.prepare("SELECT COUNT(*) AS count FROM holdings_snapshots").get() as { count: number }).count;
    if (count > 0) {
      db.exec("COMMIT");
      return 0;
    }
    const insert = db.prepare("INSERT INTO holdings_snapshots(date, btc_held, shares_outstanding, source, created_at) VALUES (?, ?, ?, 'automatic', ?)");
    const createdAt = new Date().toISOString();
    for (const row of data.snapshots) insert.run(row.date, row.btc_held, row.shares_outstanding, createdAt);
    db.exec("COMMIT");
    return data.snapshots.length;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
