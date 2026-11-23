import type { DB } from "./db.js";
import { getMeta, setMeta } from "./meta.js";
import { logEvent } from "./logs.js";

/**
 * Holdings Snapshots — dated observations of Strategy's BTC held and basic shares outstanding
 * (class A + class B). Automatic snapshots come from the SEC reader and the one-time seed; manual
 * snapshots are typed in by the user and always win. See CONTEXT.md → Holdings Snapshot.
 */
export type HoldingsSource = "automatic" | "manual";

export interface HoldingsSnapshot {
  /** YYYY-MM-DD, a UTC day. The snapshot applies from 00:00 UTC of this day. */
  date: string;
  btc_held: number;
  shares_outstanding: number;
  source: HoldingsSource;
  created_at: string;
}

export interface SaveHoldingsInput {
  date: string;
  btc_held: number;
  shares_outstanding: number;
  source: HoldingsSource;
  created_at?: string;
}

export interface HoldingsWarning {
  reason: "btc_decreased" | "btc_increased_too_much";
  date: string;
  btc_held: number;
  previous_date: string;
  previous_btc_held: number;
}

export type SaveHoldingsResult =
  | { status: "saved"; snapshot: HoldingsSnapshot }
  | { status: "skipped_manual"; snapshot: HoldingsSnapshot }
  | { status: "rejected"; warning: HoldingsWarning };

/** A snapshot older than this many days (newest one, measured from its UTC midnight) is stale. */
export const STALE_AFTER_DAYS = 14;
/** An automatic reading may raise BTC held by at most this fraction over the latest snapshot. */
export const MAX_AUTOMATIC_RISE = 0.1;

const WARNING_KEY = "markets_holdings_warning";
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateInput(input: SaveHoldingsInput): void {
  if (!isRealDate(input.date)) throw new Error("date must be a real YYYY-MM-DD date.");
  if (!Number.isFinite(input.btc_held) || input.btc_held <= 0) {
    throw new Error("btc_held must be finite and positive.");
  }
  if (!Number.isSafeInteger(input.shares_outstanding) || input.shares_outstanding <= 0) {
    throw new Error("shares_outstanding must be a positive safe integer.");
  }
  if (input.source !== "automatic" && input.source !== "manual") {
    throw new Error("source must be automatic or manual.");
  }
  if (input.created_at !== undefined && !Number.isFinite(Date.parse(input.created_at))) {
    throw new Error("created_at must be a valid timestamp.");
  }
}

function fromRow(row: Record<string, unknown>): HoldingsSnapshot {
  return {
    date: row.date as string,
    btc_held: row.btc_held as number,
    shares_outstanding: row.shares_outstanding as number,
    source: row.source as HoldingsSource,
    created_at: row.created_at as string,
  };
}

/** All snapshots, oldest first. */
export function listHoldingsSnapshots(db: DB): HoldingsSnapshot[] {
  const rows = db.prepare("SELECT * FROM holdings_snapshots ORDER BY date ASC").all();
  return (rows as Record<string, unknown>[]).map(fromRow);
}

/** The newest snapshot, or undefined if the table is empty. */
export function getLatestHoldingsSnapshot(db: DB): HoldingsSnapshot | undefined {
  const row = db.prepare("SELECT * FROM holdings_snapshots ORDER BY date DESC LIMIT 1").get();
  return row ? fromRow(row as Record<string, unknown>) : undefined;
}

/** The newest snapshot with source "automatic", or undefined if there is none. */
export function getLatestAutomaticHoldingsSnapshot(db: DB): HoldingsSnapshot | undefined {
  const row = db
    .prepare("SELECT * FROM holdings_snapshots WHERE source = 'automatic' ORDER BY date DESC LIMIT 1")
    .get();
  return row ? fromRow(row as Record<string, unknown>) : undefined;
}

/**
 * The snapshot in effect at a moment: the latest one dated on or before that moment's UTC day.
 * Undefined if the moment is before the first snapshot.
 */
export function getHoldingsSnapshotAt(db: DB, moment: Date | string): HoldingsSnapshot | undefined {
  const timestamp = moment instanceof Date ? moment.getTime() : Date.parse(moment);
  if (!Number.isFinite(timestamp)) throw new Error("moment must be a valid timestamp.");
  const day = new Date(timestamp).toISOString().slice(0, 10);
  const row = db
    .prepare("SELECT * FROM holdings_snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1")
    .get(day);
  return row ? fromRow(row as Record<string, unknown>) : undefined;
}

/** The warning left by the last rejected automatic save, until a later save clears it. */
export function getPendingHoldingsWarning(db: DB): HoldingsWarning | undefined {
  const value = getMeta(db, WARNING_KEY);
  return value ? (JSON.parse(value) as HoldingsWarning) : undefined;
}

/** True when there is no snapshot, or the newest one is older than STALE_AFTER_DAYS. */
export function isHoldingsStale(db: DB, now: Date = new Date()): boolean {
  const latest = getLatestHoldingsSnapshot(db);
  if (!latest) return true;
  const age = now.getTime() - Date.parse(`${latest.date}T00:00:00.000Z`);
  return age > STALE_AFTER_DAYS * DAY_MS;
}

/** Sanity check for automatic readings; returns a warning when the reading looks wrong. */
function checkAutomaticReading(
  input: SaveHoldingsInput,
  latest: HoldingsSnapshot | undefined,
): HoldingsWarning | undefined {
  if (!latest) return undefined;
  const base = {
    date: input.date,
    btc_held: input.btc_held,
    previous_date: latest.date,
    previous_btc_held: latest.btc_held,
  };
  if (input.btc_held < latest.btc_held) return { reason: "btc_decreased", ...base };
  if (input.btc_held > latest.btc_held * (1 + MAX_AUTOMATIC_RISE)) {
    return { reason: "btc_increased_too_much", ...base };
  }
  return undefined;
}

/**
 * Save a snapshot.
 * - Automatic never overwrites a manual one for the same date (`skipped_manual`).
 * - Automatic is sanity-checked against the latest snapshot; a drop or a rise above 10% is
 *   rejected, remembered as a pending warning and logged.
 * - Manual skips the check, replaces the row for that date and is logged as a manual edit.
 * Any successful save clears the pending warning.
 */
export function saveHoldingsSnapshot(db: DB, input: SaveHoldingsInput): SaveHoldingsResult {
  validateInput(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM holdings_snapshots WHERE date = ?").get(input.date) as
      | Record<string, unknown>
      | undefined;

    if (input.source === "automatic") {
      if (existing?.source === "manual") {
        db.exec("COMMIT");
        return { status: "skipped_manual", snapshot: fromRow(existing) };
      }
      const warning = checkAutomaticReading(input, getLatestHoldingsSnapshot(db));
      if (warning) {
        setMeta(db, WARNING_KEY, JSON.stringify(warning));
        const what =
          warning.reason === "btc_decreased"
            ? "BTC decreased"
            : `BTC increased by more than ${MAX_AUTOMATIC_RISE * 100}%`;
        logEvent(db, {
          source: "markets",
          level: "warn",
          message: `Rejected holdings snapshot for ${input.date}: ${what}.`,
          data: { ...warning },
        });
        db.exec("COMMIT");
        return { status: "rejected", warning };
      }
    }

    const createdAt = input.created_at ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO holdings_snapshots (date, btc_held, shares_outstanding, source, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         btc_held = excluded.btc_held,
         shares_outstanding = excluded.shares_outstanding,
         source = excluded.source,
         created_at = excluded.created_at`,
    ).run(input.date, input.btc_held, input.shares_outstanding, input.source, createdAt);
    db.prepare("DELETE FROM meta WHERE key = ?").run(WARNING_KEY);

    if (input.source === "manual") {
      logEvent(db, {
        source: "manual-edit",
        level: "info",
        message: `Updated holdings snapshot for ${input.date}.`,
        data: {
          date: input.date,
          before: existing
            ? { btc_held: existing.btc_held, shares_outstanding: existing.shares_outstanding }
            : null,
          after: { btc_held: input.btc_held, shares_outstanding: input.shares_outstanding },
        },
      });
    }

    const row = db.prepare("SELECT * FROM holdings_snapshots WHERE date = ?").get(input.date);
    db.exec("COMMIT");
    return { status: "saved", snapshot: fromRow(row as Record<string, unknown>) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
