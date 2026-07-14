import type { DB } from "./db.js";

/**
 * Observational Memory — durable, compressed learnings the agents accumulate across runs so they
 * don't have to re-derive everything from scratch each time:
 *   - sender_carrier: "emails from this domain are usually <carrier>" (helps a cheap Classifier)
 *   - parcel_note:    a compact current understanding of a parcel, so the Tracker can reuse it
 *                     instead of re-ingesting whole email threads (context compression).
 */
export type ObservationKind = "sender_carrier" | "parcel_note";

export interface Observation {
  id: number;
  kind: ObservationKind;
  key: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

function rowToObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as number,
    kind: row.kind as ObservationKind,
    key: (row.key as string | null) ?? null,
    content: row.content as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/** Upsert by (kind, key). Passing the same kind+key overwrites content and bumps updated_at. */
export function recordObservation(
  db: DB,
  obs: { kind: ObservationKind; key: string; content: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO observations (kind, key, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(obs.kind, obs.key, obs.content, now, now);
}

export function getObservation(db: DB, kind: ObservationKind, key: string): Observation | undefined {
  const row = db
    .prepare("SELECT * FROM observations WHERE kind = ? AND key = ?")
    .get(kind, key) as Record<string, unknown> | undefined;
  return row ? rowToObservation(row) : undefined;
}

export function listRecentObservations(db: DB, limit = 50): Observation[] {
  const rows = db
    .prepare("SELECT * FROM observations ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToObservation);
}
