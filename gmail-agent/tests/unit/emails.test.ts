import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import {
  upsertEmail,
  listTodaysEmails,
  listUnread,
  applyUnreadSnapshot,
  startOfLocalDayIso,
} from "../../src/memory/emails.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

const nowMs = String(Date.now());
const yesterdayMs = String(Date.now() - 36 * 60 * 60 * 1000);

describe("emails store", () => {
  let db: DB;
  beforeEach(() => {
    db = memDb();
  });

  it("upserts and preserves first_seen while bumping last_seen", () => {
    upsertEmail(db, { id: "e1", subject: "Hi", sender: "a@b.com", internalDate: nowMs, is_unread: true });
    const first = listUnread(db)[0];
    upsertEmail(db, { id: "e1", subject: "Hi (edited)", sender: "a@b.com", internalDate: nowMs, is_unread: true });
    const again = listUnread(db)[0];
    expect(again.first_seen).toBe(first.first_seen);
    expect(again.subject).toBe("Hi (edited)");
  });

  it("lists only today's emails by received_at", () => {
    upsertEmail(db, { id: "today1", subject: "today", internalDate: nowMs });
    upsertEmail(db, { id: "old1", subject: "old", internalDate: yesterdayMs });
    const todays = listTodaysEmails(db, startOfLocalDayIso());
    expect(todays.map((e) => e.id)).toEqual(["today1"]);
  });

  it("lists unread emails", () => {
    upsertEmail(db, { id: "u1", internalDate: nowMs, is_unread: true });
    upsertEmail(db, { id: "r1", internalDate: nowMs, is_unread: false });
    expect(listUnread(db).map((e) => e.id)).toEqual(["u1"]);
  });

  it("applyUnreadSnapshot clears the flag on emails no longer unread", () => {
    upsertEmail(db, { id: "a", internalDate: nowMs, is_unread: true });
    upsertEmail(db, { id: "b", internalDate: nowMs, is_unread: true });
    expect(listUnread(db)).toHaveLength(2);

    // Only "a" is still unread now.
    applyUnreadSnapshot(db, ["a"]);
    expect(listUnread(db).map((e) => e.id)).toEqual(["a"]);
  });

  it("preserves is_parcel once set, even if a later scan omits it", () => {
    upsertEmail(db, { id: "p", internalDate: nowMs, is_parcel: true, tracking_number: "T1" });
    upsertEmail(db, { id: "p", internalDate: nowMs, is_parcel: false });
    const row = listTodaysEmails(db, startOfLocalDayIso()).find((e) => e.id === "p");
    expect(row?.is_parcel).toBe(true);
    expect(row?.tracking_number).toBe("T1");
  });
});
