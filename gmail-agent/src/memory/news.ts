import type { DB } from "./db.js";
import { getMeta, setMeta } from "./meta.js";

export type NewsSummaryStatus = "ok" | "failed" | "not_an_issue" | "pending";

export interface NewsSender {
  id: number;
  pattern: string;
  display_name?: string;
  added_at: string;
  removed_at?: string;
}

export interface ParsedFromHeader {
  address: string;
  name?: string;
}

export interface NewsSummary {
  message_id: string;
  sender_id: number;
  from_address: string;
  subject: string;
  received_at: string;
  status: NewsSummaryStatus;
  attempts: number;
  bullets: string[];
  score?: number;
  reason?: string;
  error?: string;
  created_at: string;
}

export interface SaveNewsSummaryInput {
  message_id: string;
  sender_id: number;
  from_address: string;
  subject: string;
  received_at: string;
  status: NewsSummaryStatus;
  attempts?: number;
  bullets?: string[];
  score?: number;
  reason?: string;
  error?: string;
  /** Used only on insert; omitted values use the current UTC time. */
  created_at?: string;
}

export interface NewsFeedItem extends NewsSummary {
  sender: NewsSender;
}

export interface NewsLeaderboardEntry {
  sender_id: number;
  pattern: string;
  display_name?: string;
  average_score: number;
  count: number;
}

function rowToSender(row: Record<string, unknown>): NewsSender {
  return {
    id: row.id as number,
    pattern: row.pattern as string,
    display_name: (row.display_name as string | null) ?? undefined,
    added_at: row.added_at as string,
    removed_at: (row.removed_at as string | null) ?? undefined,
  };
}

function rowToSummary(row: Record<string, unknown>): NewsSummary {
  return {
    message_id: row.message_id as string,
    sender_id: row.sender_id as number,
    from_address: row.from_address as string,
    subject: row.subject as string,
    received_at: row.received_at as string,
    status: row.status as NewsSummaryStatus,
    attempts: row.attempts as number,
    bullets: JSON.parse(row.bullets as string) as string[],
    score: (row.score as number | null) ?? undefined,
    reason: (row.reason as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    created_at: row.created_at as string,
  };
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.trim().toLowerCase();
  const address = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;
  const domain = /^@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;
  if (!address.test(normalized) && !domain.test(normalized)) {
    throw new Error(`Invalid news sender pattern: ${pattern}`);
  }
  return normalized;
}

export function addNewsSender(db: DB, pattern: string, displayName?: string): NewsSender {
  const normalized = normalizePattern(pattern);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO news_senders (pattern, display_name, added_at, removed_at)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(pattern) DO UPDATE SET
       display_name = CASE WHEN excluded.display_name IS NOT NULL
                           THEN excluded.display_name ELSE news_senders.display_name END,
       removed_at = NULL`,
  ).run(normalized, displayName ?? null, now);
  return rowToSender(
    db.prepare("SELECT * FROM news_senders WHERE pattern = ?").get(normalized) as Record<
      string,
      unknown
    >,
  );
}

/** Rename an existing sender. Passing undefined clears its display name. */
export function renameNewsSender(db: DB, id: number, displayName?: string): NewsSender {
  const result = db.prepare("UPDATE news_senders SET display_name = ? WHERE id = ?").run(
    displayName ?? null,
    id,
  );
  if (!result.changes) throw new Error(`News sender ${id} does not exist.`);
  return rowToSender(
    db.prepare("SELECT * FROM news_senders WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

/** Soft remove. Repeated removal preserves the first removed_at timestamp. */
export function removeNewsSender(db: DB, id: number): boolean {
  const result = db
    .prepare("UPDATE news_senders SET removed_at = ? WHERE id = ? AND removed_at IS NULL")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function listNewsSenders(db: DB): NewsSender[] {
  const rows = db
    .prepare("SELECT * FROM news_senders WHERE removed_at IS NULL ORDER BY pattern ASC, id ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToSender);
}

export function parseFromHeader(fromHeader: string): ParsedFromHeader {
  const bracketed = fromHeader.match(/<\s*([^<>]+?)\s*>/);
  const rawAddress = (bracketed?.[1] ?? fromHeader).trim();
  const address = /^[^\s@<>]+@[^\s@<>]+$/.test(rawAddress) ? rawAddress.toLowerCase() : "";
  if (!address) return { address: "", name: undefined };

  let name: string | undefined;
  if (bracketed) {
    const prefix = fromHeader.slice(0, bracketed.index).trim();
    name = prefix.replace(/^"([\s\S]*)"$/, "$1").trim() || undefined;
  }
  return { address, name };
}

/** Exact address takes precedence over an exact domain pattern. */
export function matchSender(fromHeader: string, senders: NewsSender[]): NewsSender | null {
  const { address } = parseFromHeader(fromHeader);
  if (!address) return null;
  const active = senders.filter((sender) => sender.removed_at == null);
  const exact = active
    .filter((sender) => normalizePattern(sender.pattern) === address)
    .sort((a, b) => a.id - b.id)[0];
  if (exact) return exact;
  const domain = `@${address.slice(address.lastIndexOf("@") + 1)}`;
  return (
    active
      .filter((sender) => normalizePattern(sender.pattern) === domain)
      .sort((a, b) => a.id - b.id)[0] ?? null
  );
}

export function saveNewsSummary(db: DB, input: SaveNewsSummaryInput): void {
  const statuses: NewsSummaryStatus[] = ["ok", "failed", "not_an_issue", "pending"];
  if (!statuses.includes(input.status)) throw new Error(`Invalid news summary status: ${input.status}`);
  const attempts = input.attempts ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error("attempts must be a non-negative integer.");
  if (input.status === "ok" && (!Number.isInteger(input.score) || input.score! < 1 || input.score! > 10)) {
    throw new Error("An ok news summary requires an integer score from 1 to 10.");
  }
  if (input.score !== undefined && (!Number.isInteger(input.score) || input.score < 1 || input.score > 10)) {
    throw new Error("score must be an integer from 1 to 10.");
  }
  if (!db.prepare("SELECT 1 AS present FROM news_senders WHERE id = ?").get(input.sender_id)) {
    throw new Error(`News sender ${input.sender_id} does not exist.`);
  }
  db.prepare(
    `INSERT INTO news_summaries
       (message_id, sender_id, from_address, subject, received_at, status, attempts, bullets, score, reason, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       sender_id = excluded.sender_id, from_address = excluded.from_address,
       subject = excluded.subject, received_at = excluded.received_at,
       status = excluded.status, attempts = excluded.attempts, bullets = excluded.bullets,
       score = excluded.score, reason = excluded.reason, error = excluded.error`,
  ).run(
    input.message_id,
    input.sender_id,
    input.from_address,
    input.subject,
    input.received_at,
    input.status,
    attempts,
    JSON.stringify(input.bullets ?? []),
    input.score ?? null,
    input.reason ?? null,
    input.error ?? null,
    input.created_at ?? new Date().toISOString(),
  );
}

export function getNewsSummary(db: DB, messageId: string): NewsSummary | undefined {
  const row = db.prepare("SELECT * FROM news_summaries WHERE message_id = ?").get(messageId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSummary(row) : undefined;
}

export function listNewsFeed(db: DB, sinceIso: string): NewsFeedItem[] {
  const rows = db
    .prepare(
      `SELECT s.*, n.id AS feed_sender_id, n.pattern AS feed_pattern,
              n.display_name AS feed_display_name, n.added_at AS feed_added_at,
              n.removed_at AS feed_removed_at
       FROM news_summaries s JOIN news_senders n ON n.id = s.sender_id
       WHERE n.removed_at IS NULL AND s.status IN ('ok', 'failed') AND s.received_at >= ?
       ORDER BY s.received_at DESC, s.message_id ASC`,
    )
    .all(sinceIso) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...rowToSummary(row),
    sender: rowToSender({
      id: row.feed_sender_id,
      pattern: row.feed_pattern,
      display_name: row.feed_display_name,
      added_at: row.feed_added_at,
      removed_at: row.feed_removed_at,
    }),
  }));
}

export function newsLeaderboard(db: DB, sinceIso: string): NewsLeaderboardEntry[] {
  const rows = db
    .prepare(
      `SELECT n.id AS sender_id, n.pattern, n.display_name,
              AVG(s.score) AS average_score, COUNT(*) AS count
       FROM news_summaries s JOIN news_senders n ON n.id = s.sender_id
       WHERE n.removed_at IS NULL AND s.status = 'ok' AND s.received_at >= ?
       GROUP BY n.id, n.pattern, n.display_name
       ORDER BY average_score DESC, sender_id ASC`,
    )
    .all(sinceIso) as Record<string, unknown>[];
  return rows.map((row) => ({
    sender_id: row.sender_id as number,
    pattern: row.pattern as string,
    display_name: (row.display_name as string | null) ?? undefined,
    average_score: row.average_score as number,
    count: row.count as number,
  }));
}

export function getNewsInterests(db: DB): string {
  return getMeta(db, "news_interests") ?? "";
}

export function setNewsInterests(db: DB, value: string): void {
  setMeta(db, "news_interests", value);
}
