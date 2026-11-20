import type { DB } from "./db.js";
import { getMeta } from "./meta.js";
import { logEvent } from "./logs.js";

export type HoldingsSource = "automatic" | "manual";
export interface HoldingsSnapshot { date: string; btc_held: number; shares_outstanding: number; source: HoldingsSource; created_at: string }
export interface SaveHoldingsInput { date: string; btc_held: number; shares_outstanding: number; source: HoldingsSource; created_at?: string }
export interface HoldingsWarning { reason: "btc_decreased" | "btc_increased_too_much"; date: string; btc_held: number; previous_date: string; previous_btc_held: number }
export type SaveHoldingsResult = { status: "saved"; snapshot: HoldingsSnapshot } | { status: "skipped_manual"; snapshot: HoldingsSnapshot } | { status: "rejected"; warning: HoldingsWarning };
const WARNING_KEY = "markets_holdings_warning";

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validate(input: SaveHoldingsInput): void {
  if (!validDate(input.date)) throw new Error("date must be a real YYYY-MM-DD date.");
  if (!Number.isFinite(input.btc_held) || input.btc_held <= 0) throw new Error("btc_held must be finite and positive.");
  if (!Number.isSafeInteger(input.shares_outstanding) || input.shares_outstanding <= 0) throw new Error("shares_outstanding must be a positive safe integer.");
  if (input.source !== "automatic" && input.source !== "manual") throw new Error("source must be automatic or manual.");
  if (input.created_at !== undefined && !Number.isFinite(Date.parse(input.created_at))) throw new Error("created_at must be a valid timestamp.");
}
function fromRow(row: Record<string, unknown>): HoldingsSnapshot { return { date: row.date as string, btc_held: row.btc_held as number, shares_outstanding: row.shares_outstanding as number, source: row.source as HoldingsSource, created_at: row.created_at as string }; }
export function listHoldingsSnapshots(db: DB): HoldingsSnapshot[] { return (db.prepare("SELECT * FROM holdings_snapshots ORDER BY date ASC").all() as Record<string, unknown>[]).map(fromRow); }
export function getLatestHoldingsSnapshot(db: DB): HoldingsSnapshot | undefined { const row = db.prepare("SELECT * FROM holdings_snapshots ORDER BY date DESC LIMIT 1").get() as Record<string, unknown> | undefined; return row ? fromRow(row) : undefined; }
export function getHoldingsSnapshotAt(db: DB, moment: Date | string): HoldingsSnapshot | undefined {
  const timestamp = moment instanceof Date ? moment.getTime() : Date.parse(moment);
  if (!Number.isFinite(timestamp)) throw new Error("moment must be a valid timestamp.");
  const date = new Date(timestamp).toISOString().slice(0, 10);
  const row = db.prepare("SELECT * FROM holdings_snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1").get(date) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : undefined;
}
export function getPendingHoldingsWarning(db: DB): HoldingsWarning | undefined { const value = getMeta(db, WARNING_KEY); return value ? JSON.parse(value) as HoldingsWarning : undefined; }
export function isHoldingsStale(db: DB, now = new Date()): boolean { const latest = getLatestHoldingsSnapshot(db); return !latest || now.getTime() - Date.parse(`${latest.date}T00:00:00.000Z`) > 14 * 24 * 60 * 60 * 1000; }

export function saveHoldingsSnapshot(db: DB, input: SaveHoldingsInput): SaveHoldingsResult {
  validate(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const atDate = db.prepare("SELECT * FROM holdings_snapshots WHERE date = ?").get(input.date) as Record<string, unknown> | undefined;
    if (input.source === "automatic" && atDate?.source === "manual") {
      db.exec("COMMIT"); return { status: "skipped_manual", snapshot: fromRow(atDate) };
    }
    const latest = getLatestHoldingsSnapshot(db);
    if (input.source === "automatic" && latest && input.btc_held < latest.btc_held) {
      const warning: HoldingsWarning = { reason: "btc_decreased", date: input.date, btc_held: input.btc_held, previous_date: latest.date, previous_btc_held: latest.btc_held };
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(WARNING_KEY, JSON.stringify(warning));
      logEvent(db, { source: "markets", level: "warn", message: `Rejected holdings snapshot for ${input.date}: BTC decreased.`, data: { ...warning } });
      db.exec("COMMIT"); return { status: "rejected", warning };
    }
    if (input.source === "automatic" && latest && input.btc_held > latest.btc_held * 1.1) {
      const warning: HoldingsWarning = { reason: "btc_increased_too_much", date: input.date, btc_held: input.btc_held, previous_date: latest.date, previous_btc_held: latest.btc_held };
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(WARNING_KEY, JSON.stringify(warning));
      logEvent(db, { source: "markets", level: "warn", message: `Rejected holdings snapshot for ${input.date}: BTC increased by more than 10%.`, data: { ...warning } });
      db.exec("COMMIT"); return { status: "rejected", warning };
    }
    const createdAt = atDate?.created_at as string | undefined ?? input.created_at ?? new Date().toISOString();
    db.prepare(`INSERT INTO holdings_snapshots(date,btc_held,shares_outstanding,source,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET btc_held=excluded.btc_held, shares_outstanding=excluded.shares_outstanding, source=excluded.source, created_at=holdings_snapshots.created_at
      WHERE holdings_snapshots.source != 'manual' OR excluded.source = 'manual'`).run(input.date,input.btc_held,input.shares_outstanding,input.source,createdAt);
    db.prepare("DELETE FROM meta WHERE key = ?").run(WARNING_KEY);
    if (input.source === "manual") logEvent(db, { source: "manual-edit", level: "info", message: `Updated holdings snapshot for ${input.date}.`, data: { date: input.date, before: atDate ? { btc_held: atDate.btc_held, shares_outstanding: atDate.shares_outstanding } : null, after: { btc_held: input.btc_held, shares_outstanding: input.shares_outstanding } } });
    const row = db.prepare("SELECT * FROM holdings_snapshots WHERE date = ?").get(input.date) as Record<string, unknown>;
    db.exec("COMMIT"); return { status: "saved", snapshot: fromRow(row) };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
