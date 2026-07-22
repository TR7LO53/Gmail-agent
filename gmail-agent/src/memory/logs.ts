import type { DB } from "./db.js";

/**
 * Activity log — a durable, human-readable trail of what Ggent does each heartbeat: Gmail searches
 * (query + result count), classifier/tracker/summary outcomes, and errors. Agents write here
 * directly with `deps.db`, exactly like recordDecision/upsertEmail. The dashboard reads it so you
 * can actually SEE the agent working.
 */
export type LogLevel = "info" | "warn" | "error";
export type LogSource =
  | "heartbeat"
  | "gmail_search"
  | "classifier"
  | "tracker"
  | "inbox"
  | "summary"
  | "manual-edit";

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogInput {
  source: LogSource;
  message: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
}

export function logEvent(db: DB, entry: LogInput): void {
  db.prepare("INSERT INTO logs (ts, level, source, message, data) VALUES (?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    entry.level ?? "info",
    entry.source,
    entry.message,
    entry.data ? JSON.stringify(entry.data) : null,
  );
}

function rowToEntry(row: Record<string, unknown>): LogEntry {
  return {
    id: row.id as number,
    ts: row.ts as string,
    level: row.level as LogLevel,
    source: row.source as LogSource,
    message: row.message as string,
    data: row.data ? (JSON.parse(row.data as string) as Record<string, unknown>) : undefined,
  };
}

/** Most recent log entries, newest first. */
export function listRecentLogs(db: DB, limit = 50): LogEntry[] {
  const rows = db
    .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/** Keep only the newest `keep` rows so the log can't grow unbounded. */
export function pruneLogs(db: DB, keep = 500): void {
  db.prepare(
    "DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?",
  ).run(keep);
}
