import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../../src/memory/db.js";
import { getHoldingsSnapshotAt, getLatestHoldingsSnapshot, getPendingHoldingsWarning, isHoldingsStale, listHoldingsSnapshots, saveHoldingsSnapshot } from "../../src/memory/holdings.js";

describe("holdings snapshots", () => {
  let db: DB;
  beforeEach(() => { db = openDb(":memory:"); db.exec("DELETE FROM holdings_snapshots"); });
  afterEach(() => db.close());
  const save = (date: string, btc_held: number, source: "manual" | "automatic" = "automatic") => saveHoldingsSnapshot(db, { date, btc_held, shares_outstanding: 1000, source });
  it("manual records win for a date and automatic saves cannot replace them", () => {
    save("2026-01-01", 100);
    saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 90, shares_outstanding: 1200, source: "manual" });
    const before = getLatestHoldingsSnapshot(db)!.created_at;
    expect(save("2026-01-01", 1).status).toBe("skipped_manual");
    expect(getLatestHoldingsSnapshot(db)).toMatchObject({ btc_held: 90, shares_outstanding: 1200, created_at: before, source: "manual" });
  });
  it("rejects decreases and rises over ten percent but accepts the boundary", () => {
    save("2026-01-01", 100);
    expect(save("2026-01-02", 99)).toMatchObject({ status: "rejected", warning: { reason: "btc_decreased" } });
    expect(save("2026-01-02", 110.1).status).toBe("rejected");
    expect(getPendingHoldingsWarning(db)).toBeDefined();
    expect(save("2026-01-02", 110).status).toBe("saved");
    expect(getPendingHoldingsWarning(db)).toBeUndefined();
    expect(listHoldingsSnapshots(db)).toHaveLength(2);
  });
  it("looks up by effective UTC date and calculates staleness from snapshot date", () => {
    save("2026-01-03", 100);
    saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 90, shares_outstanding: 1000, source: "manual" });
    expect(getHoldingsSnapshotAt(db, "2025-12-31T23:59:00Z")).toBeUndefined();
    expect(getHoldingsSnapshotAt(db, "2026-01-02T23:00:00+02:00")?.btc_held).toBe(90);
    expect(getHoldingsSnapshotAt(db, "2026-01-03T00:00:00Z")?.btc_held).toBe(100);
    expect(isHoldingsStale(db, new Date("2026-01-15T00:00:00Z"))).toBe(false);
    expect(isHoldingsStale(db, new Date("2026-01-17T00:00:00Z"))).toBe(false);
    expect(isHoldingsStale(db, new Date("2026-01-17T00:00:00.001Z"))).toBe(true);
  });
  it("validates values before writing", () => {
    expect(() => saveHoldingsSnapshot(db, { date: "2026-02-30", btc_held: 1, shares_outstanding: 1, source: "manual" })).toThrow();
    expect(() => saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: Infinity, shares_outstanding: 1, source: "manual" })).toThrow();
    expect(() => saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 1, shares_outstanding: 1.5, source: "manual" })).toThrow();
    expect(listHoldingsSnapshots(db)).toHaveLength(0);
  });
});
