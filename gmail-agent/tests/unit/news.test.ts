import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { openDb } from "../../src/memory/db.js";
import type { DB } from "../../src/memory/db.js";
import {
  addNewsSender,
  getNewsInterests,
  getNewsSummary,
  listNewsFeed,
  listPendingNewsSummaries,
  listNewsSenders,
  matchSender,
  newsLeaderboard,
  parseFromHeader,
  removeNewsSender,
  renameNewsSender,
  saveNewsSummary,
  setNewsInterests,
} from "../../src/memory/news.js";

const DEFAULT_INTERESTS = [
  "Architecture of AI workflows and agentic systems",
  "Tools, but only if useful at work and if they raise the quality of software and systems",
  "Evaluation of AI coding agents",
  "NOT wanted: local models (counts against the score)",
].join("\n");
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function closeDiskDb(db: DB): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  db.close();
}

function save(
  db: DB,
  message_id: string,
  sender_id: number,
  status: "ok" | "failed" | "not_an_issue" | "pending",
  received_at: string,
  score?: number,
  extra: Partial<Parameters<typeof saveNewsSummary>[1]> = {},
): void {
  saveNewsSummary(db, {
    message_id,
    sender_id,
    from_address: "writer@example.com",
    subject: message_id,
    received_at,
    status,
    score,
    created_at: received_at,
    ...extra,
  });
}

describe("AI News storage", () => {
  let db: DB;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("manages sender CRUD, normalizes patterns, and reactivates the same record", () => {
    expect(listNewsSenders(db)).toEqual([]);
    const sender = addNewsSender(db, "  Person@Example.COM  ", "Person");
    expect(sender.pattern).toBe("person@example.com");
    const same = addNewsSender(db, "PERSON@example.com");
    expect(same.id).toBe(sender.id);
    expect(same.display_name).toBe("Person");
    expect(addNewsSender(db, "@Example.com").pattern).toBe("@example.com");
    expect(renameNewsSender(db, sender.id, "Renamed").display_name).toBe("Renamed");
    expect(renameNewsSender(db, sender.id).display_name).toBeUndefined();
    expect(removeNewsSender(db, sender.id)).toBe(true);
    const removed = db.prepare("SELECT removed_at FROM news_senders WHERE id = ?").get(sender.id) as { removed_at: string };
    expect(removeNewsSender(db, sender.id)).toBe(false);
    expect((db.prepare("SELECT removed_at FROM news_senders WHERE id = ?").get(sender.id) as { removed_at: string }).removed_at).toBe(removed.removed_at);
    const restored = addNewsSender(db, "person@example.com");
    expect(restored.id).toBe(sender.id);
    expect(restored.added_at).toBe(sender.added_at);
    expect(restored.display_name).toBeUndefined();
    expect(listNewsSenders(db).map((entry) => entry.id)).toContain(sender.id);
    expect(() => addNewsSender(db, "*.example.com")).toThrow();
    expect(() => renameNewsSender(db, 999, "Missing")).toThrow();
    expect(removeNewsSender(db, 999)).toBe(false);
  });

  it("parses a single From header and matches exact address before domain", () => {
    expect(parseFromHeader("  PERSON@Example.com  ")).toEqual({ address: "person@example.com", name: undefined });
    expect(parseFromHeader("Jane Doe <Jane@Example.com>")).toEqual({ address: "jane@example.com", name: "Jane Doe" });
    expect(parseFromHeader('"News, Team" <news@example.com>')).toEqual({ address: "news@example.com", name: "News, Team" });
    expect(parseFromHeader("broken")).toEqual({ address: "", name: undefined });
    expect(parseFromHeader("person@example.com (bad")).toEqual({ address: "", name: undefined });
    expect(parseFromHeader('person@example.com shown <real@example.net>')).toEqual({ address: "real@example.net", name: "person@example.com shown" });

    const domain = addNewsSender(db, "@example.com");
    const exact = addNewsSender(db, "news@example.com");
    expect(matchSender("NEWS@example.COM", [domain, exact])?.id).toBe(exact.id);
    expect(matchSender("NEWS@example.COM", [exact, domain])?.id).toBe(exact.id);
    expect(matchSender("Other <other@example.com>", [exact, domain])?.id).toBe(domain.id);
    expect(matchSender("other@evil-example.com", [domain])).toBeNull();
    expect(matchSender("other@sub.example.com", [domain])).toBeNull();
    removeNewsSender(db, domain.id);
    expect(matchSender("other@example.com", listNewsSenders(db))).toBeNull();
  });

  it("round-trips summaries, permits incomplete statuses, and upserts without changing created_at", () => {
    const sender = addNewsSender(db, "@example.com");
    saveNewsSummary(db, {
      message_id: "m1", sender_id: sender.id, from_address: "a@example.com", subject: "AI",
      received_at: T1, status: "ok", attempts: 2, bullets: ["Zażółć", 'say "hi"'], score: 10,
      reason: "useful", created_at: T0,
    });
    expect(getNewsSummary(db, "missing")).toBeUndefined();
    expect(getNewsSummary(db, "m1")).toEqual({
      message_id: "m1", sender_id: sender.id, from_address: "a@example.com", subject: "AI",
      received_at: T1, status: "ok", attempts: 2, bullets: ["Zażółć", 'say "hi"'], score: 10,
      reason: "useful", error: undefined, created_at: T0,
    });
    save(db, "m1", sender.id, "failed", T2, undefined, { attempts: 3, error: "temporary" });
    expect(getNewsSummary(db, "m1")).toMatchObject({ created_at: T0, status: "failed", attempts: 3, score: undefined, error: "temporary" });
    save(db, "m1", sender.id, "ok", T2, 1, { attempts: 4 });
    expect(getNewsSummary(db, "m1")).toMatchObject({ created_at: T0, status: "ok", attempts: 4, score: 1, error: undefined });
    save(db, "pending", sender.id, "pending", T1);
    expect(getNewsSummary(db, "pending")?.bullets).toEqual([]);
    expect(() => save(db, "bad", sender.id, "ok", T1)).toThrow();
    expect(() => save(db, "bad-score", sender.id, "ok", T1, 11)).toThrow();
    expect(() => save(db, "bad-attempts", sender.id, "failed", T1, undefined, { attempts: -1 })).toThrow();
    expect(() => save(db, "bad-sender", 999, "failed", T1)).toThrow();
    expect(() => saveNewsSummary(db, { message_id: "bad-status", sender_id: sender.id, from_address: "a@example.com", subject: "", received_at: T1, status: "unknown" as "ok" })).toThrow();
  });

  it("lists active pending rows in stable order and omits removed senders", () => {
    const active = addNewsSender(db, "@example.com");
    const removed = addNewsSender(db, "@removed.example");
    save(db, "z", active.id, "pending", T1, undefined, { created_at: T1 });
    save(db, "a", active.id, "pending", T1, undefined, { created_at: T0 });
    save(db, "gone", removed.id, "pending", T1);
    removeNewsSender(db, removed.id);
    expect(listPendingNewsSummaries(db).map((item) => item.message_id)).toEqual(["a", "z"]);
  });

  it("filters feed by received time and status, and ranks active senders by ok average", () => {
    const a = addNewsSender(db, "@a.example");
    const b = addNewsSender(db, "@b.example");
    const c = addNewsSender(db, "@c.example");
    save(db, "a4", a.id, "ok", T1, 4, { from_address: "one@a.example", attempts: 5 });
    save(db, "a9", a.id, "ok", T2, 9, { from_address: "two@a.example", attempts: 1 });
    save(db, "b8", b.id, "ok", T2, 8);
    save(db, "a-failed", a.id, "failed", T2);
    save(db, "a-pending", a.id, "pending", T2);
    save(db, "a-no", a.id, "not_an_issue", T2, undefined);
    save(db, "a-old", a.id, "ok", T0, 10);
    save(db, "c-failed", c.id, "failed", T2);
    expect(listNewsFeed(db, T2).map(({ message_id }) => message_id)).toEqual(["a-failed", "a9", "b8", "c-failed"]);
    expect(newsLeaderboard(db, T1)).toEqual([
      { sender_id: b.id, pattern: "@b.example", display_name: undefined, average_score: 8, count: 1 },
      { sender_id: a.id, pattern: "@a.example", display_name: undefined, average_score: 6.5, count: 2 },
    ]);
    removeNewsSender(db, a.id);
    expect(listNewsFeed(db, T0).some((item) => item.sender.id === a.id)).toBe(false);
    expect(newsLeaderboard(db, T0).some((entry) => entry.sender_id === a.id)).toBe(false);
    expect(getNewsSummary(db, "a9")?.score).toBe(9);
    addNewsSender(db, "@a.example");
    expect(newsLeaderboard(db, T1).find((entry) => entry.sender_id === a.id)?.count).toBe(2);
  });

  it("seeds interests once and preserves edits, including an empty string, across reopen", () => {
    expect(getNewsInterests(db)).toBe(DEFAULT_INTERESTS);
    setNewsInterests(db, "Line one\nLine two");
    expect(getNewsInterests(db)).toBe("Line one\nLine two");
    db.prepare("INSERT INTO meta(key, value) VALUES ('other', 'kept')").run();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'other'").get()).toEqual({ value: "kept" });
  });
});

describe("AI News database initialization", () => {
  it("upgrades an older database and preserves seeded or edited interest values", () => {
    const tempRoot = path.resolve(".dyrygent-robocze");
    mkdirSync(tempRoot, { recursive: true });
    const dir = mkdtempSync(path.join(tempRoot, "news-db-"));
    const file = path.join(dir, "db.sqlite");
    try {
      let db = openDb(file);
      setNewsInterests(db, "");
      addNewsSender(db, "@example.com");
      closeDiskDb(db);
      db = openDb(file);
      expect(getNewsInterests(db)).toBe("");
      expect(listNewsSenders(db)).toHaveLength(1);
      closeDiskDb(db);

      const legacyFile = path.join(dir, "legacy.sqlite");
      const legacy = openDb(legacyFile);
      setNewsInterests(legacy, "legacy edit");
      legacy.prepare("INSERT INTO meta(key, value) VALUES ('keep', 'legacy data')").run();
      legacy.exec("DROP TABLE news_summaries; DROP TABLE news_senders;");
      closeDiskDb(legacy);
      const upgraded = openDb(legacyFile);
      expect(getNewsInterests(upgraded)).toBe("legacy edit");
      expect(upgraded.prepare("SELECT value FROM meta WHERE key = 'keep'").get()).toEqual({ value: "legacy data" });
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'news_summaries'").get()).toBeDefined();
      closeDiskDb(upgraded);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // On Windows SQLite may keep WAL sidecars locked; fixtures stay isolated in .dyrygent-robocze.
      }
    }
  });
});
