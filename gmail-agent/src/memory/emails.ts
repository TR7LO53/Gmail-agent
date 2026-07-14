import type { DB } from "./db.js";

/**
 * Lightweight record of every email Ggent has observed — parcel-related or not. This is what makes
 * the "Today" digest and the unread view possible without giving the web server Gmail access: the
 * heartbeat writes here, the dashboard only reads.
 */
export interface EmailRecord {
  id: string;
  thread_id?: string;
  subject?: string;
  sender?: string;
  received_at?: string;
  is_unread: boolean;
  is_parcel: boolean;
  tracking_number?: string;
  first_seen: string;
  last_seen: string;
}

export interface UpsertEmailInput {
  id: string;
  thread_id?: string;
  subject?: string;
  sender?: string;
  /** Gmail internalDate (ms since epoch, as a string) if available. */
  internalDate?: string;
  is_unread?: boolean;
  is_parcel?: boolean;
  tracking_number?: string;
}

function rowToEmail(row: Record<string, unknown>): EmailRecord {
  return {
    id: row.id as string,
    thread_id: (row.thread_id as string | null) ?? undefined,
    subject: (row.subject as string | null) ?? undefined,
    sender: (row.sender as string | null) ?? undefined,
    received_at: (row.received_at as string | null) ?? undefined,
    is_unread: Boolean(row.is_unread),
    is_parcel: Boolean(row.is_parcel),
    tracking_number: (row.tracking_number as string | null) ?? undefined,
    first_seen: row.first_seen as string,
    last_seen: row.last_seen as string,
  };
}

/** The UTC instant of the start of today in the machine's LOCAL timezone (for "today" queries). */
export function startOfLocalDayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Insert or update an email record, preserving first_seen and bumping last_seen. */
export function upsertEmail(db: DB, input: UpsertEmailInput): void {
  const now = new Date().toISOString();
  const receivedAt = input.internalDate
    ? new Date(Number(input.internalDate)).toISOString()
    : null;

  db.prepare(
    `INSERT INTO emails
       (id, thread_id, subject, sender, received_at, is_unread, is_parcel, tracking_number, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       thread_id       = COALESCE(excluded.thread_id, emails.thread_id),
       subject         = COALESCE(excluded.subject, emails.subject),
       sender          = COALESCE(excluded.sender, emails.sender),
       received_at     = COALESCE(excluded.received_at, emails.received_at),
       is_unread       = excluded.is_unread,
       is_parcel       = emails.is_parcel OR excluded.is_parcel,
       tracking_number = COALESCE(excluded.tracking_number, emails.tracking_number),
       last_seen       = excluded.last_seen`,
  ).run(
    input.id,
    input.thread_id ?? null,
    input.subject ?? null,
    input.sender ?? null,
    receivedAt,
    input.is_unread ? 1 : 0,
    input.is_parcel ? 1 : 0,
    input.tracking_number ?? null,
    now,
    now,
  );
}

/** Emails received since the given ISO cutoff (use startOfLocalDayIso for "today"), newest first. */
export function listTodaysEmails(db: DB, sinceIso: string): EmailRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM emails WHERE received_at IS NOT NULL AND received_at >= ? ORDER BY received_at DESC",
    )
    .all(sinceIso) as Record<string, unknown>[];
  return rows.map(rowToEmail);
}

/** The most recently received emails (any day), newest first. */
export function listRecentEmails(db: DB, limit = 15): EmailRecord[] {
  const rows = db
    .prepare("SELECT * FROM emails WHERE received_at IS NOT NULL ORDER BY received_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToEmail);
}

/** All currently-unread emails, newest first. */
export function listUnread(db: DB): EmailRecord[] {
  const rows = db
    .prepare("SELECT * FROM emails WHERE is_unread = 1 ORDER BY received_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToEmail);
}

/**
 * Reconcile the unread set to exactly `unreadIds`: mark those unread, and clear the unread flag on
 * any email that is no longer unread. Emails in `unreadIds` are assumed already inserted (via
 * upsertEmail during the snapshot); this only fixes the flags of previously-unread rows.
 */
export function applyUnreadSnapshot(db: DB, unreadIds: string[]): void {
  const set = new Set(unreadIds);
  const currentlyUnread = db.prepare("SELECT id FROM emails WHERE is_unread = 1").all() as {
    id: string;
  }[];
  const clear = db.prepare("UPDATE emails SET is_unread = 0 WHERE id = ?");
  for (const { id } of currentlyUnread) {
    if (!set.has(id)) clear.run(id);
  }
}
