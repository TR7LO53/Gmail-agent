import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../../src/memory/db.js";
import {
  getHoldingsSnapshotAt,
  getLatestHoldingsSnapshot,
  getPendingHoldingsWarning,
  isHoldingsStale,
  listHoldingsSnapshots,
  saveHoldingsSnapshot,
  type HoldingsSource,
} from "../../src/memory/holdings.js";
import { listRecentLogs } from "../../src/memory/logs.js";

describe("holdings snapshots", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    // openDb loads the SEC history seed; these tests start from an empty table.
    db.exec("DELETE FROM holdings_snapshots");
  });
  afterEach(() => db.close());

  const save = (date: string, btc_held: number, source: HoldingsSource = "automatic") =>
    saveHoldingsSnapshot(db, { date, btc_held, shares_outstanding: 1000, source });

  describe("manual versus automatic", () => {
    it("a manual snapshot replaces an automatic one for the same date", () => {
      save("2026-01-01", 100);
      const result = saveHoldingsSnapshot(db, {
        date: "2026-01-01",
        btc_held: 90,
        shares_outstanding: 1200,
        source: "manual",
      });
      expect(result.status).toBe("saved");
      expect(listHoldingsSnapshots(db)).toEqual([
        expect.objectContaining({ date: "2026-01-01", btc_held: 90, shares_outstanding: 1200, source: "manual" }),
      ]);
    });

    it("an automatic save never overwrites a manual one", () => {
      saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 90, shares_outstanding: 1200, source: "manual" });
      const before = getLatestHoldingsSnapshot(db);
      expect(save("2026-01-01", 95).status).toBe("skipped_manual");
      expect(getLatestHoldingsSnapshot(db)).toEqual(before);
    });

    it("a manual save skips the sanity check and is logged as a manual edit", () => {
      save("2026-01-01", 100);
      expect(save("2026-01-02", 50, "manual").status).toBe("saved");
      expect(save("2026-01-03", 1000, "manual").status).toBe("saved");
      const logs = listRecentLogs(db, 50).filter((l) => l.source === "manual-edit");
      expect(logs).toHaveLength(2);
      expect(logs[0].data).toMatchObject({ date: "2026-01-03", before: null });
      expect(logs[1].data).toMatchObject({ date: "2026-01-02", after: { btc_held: 50 } });
    });

    it("a manual replacement logs the values before and after", () => {
      save("2026-01-01", 100);
      save("2026-01-01", 120, "manual");
      const log = listRecentLogs(db, 10).find((l) => l.source === "manual-edit");
      expect(log?.data).toMatchObject({
        before: { btc_held: 100, shares_outstanding: 1000 },
        after: { btc_held: 120, shares_outstanding: 1000 },
      });
    });
  });

  describe("sanity check for automatic saves", () => {
    it("rejects a decrease", () => {
      save("2026-01-01", 100);
      expect(save("2026-01-02", 99)).toMatchObject({ status: "rejected", warning: { reason: "btc_decreased" } });
      expect(listHoldingsSnapshots(db)).toHaveLength(1);
    });

    it("rejects a rise of 10.1% but accepts exactly 10% and 5%", () => {
      save("2026-01-01", 100);
      expect(save("2026-01-02", 110.1)).toMatchObject({
        status: "rejected",
        warning: { reason: "btc_increased_too_much", previous_btc_held: 100 },
      });
      expect(save("2026-01-02", 105).status).toBe("saved");
      expect(save("2026-01-03", 105 * 1.1).status).toBe("saved");
    });

    it("keeps the warning until a later save, and logs it", () => {
      save("2026-01-01", 100);
      save("2026-01-02", 50);
      expect(getPendingHoldingsWarning(db)).toMatchObject({ date: "2026-01-02", btc_held: 50 });
      const warn = listRecentLogs(db, 10).find((l) => l.source === "markets");
      expect(warn).toMatchObject({ level: "warn" });

      expect(save("2026-01-02", 105).status).toBe("saved");
      expect(getPendingHoldingsWarning(db)).toBeUndefined();
    });

    it("a manual save also clears a pending warning", () => {
      save("2026-01-01", 100);
      save("2026-01-02", 50);
      save("2026-01-02", 80, "manual");
      expect(getPendingHoldingsWarning(db)).toBeUndefined();
    });

    it("accepts the first snapshot of an empty table", () => {
      expect(save("2026-01-01", 123).status).toBe("saved");
    });
  });

  describe("lookup", () => {
    beforeEach(() => {
      save("2026-01-01", 100);
      save("2026-01-05", 105);
    });

    it("is undefined before the first snapshot", () => {
      expect(getHoldingsSnapshotAt(db, "2025-12-31T23:59:59Z")).toBeUndefined();
    });

    it("returns the earlier snapshot between two", () => {
      expect(getHoldingsSnapshotAt(db, new Date("2026-01-03T12:00:00Z"))?.btc_held).toBe(100);
    });

    it("returns the snapshot of that very day, from 00:00 UTC", () => {
      expect(getHoldingsSnapshotAt(db, "2026-01-05T00:00:00Z")?.btc_held).toBe(105);
      expect(getHoldingsSnapshotAt(db, "2026-01-04T23:59:59Z")?.btc_held).toBe(100);
    });

    it("uses the UTC day, not the offset's local day", () => {
      expect(getHoldingsSnapshotAt(db, "2026-01-05T01:00:00+02:00")?.btc_held).toBe(100);
    });
  });

  describe("staleness", () => {
    it("is stale when the table is empty", () => {
      expect(isHoldingsStale(db, new Date("2026-01-01T00:00:00Z"))).toBe(true);
    });

    it("is not stale at exactly 14 days, stale one millisecond later", () => {
      save("2026-01-01", 100);
      expect(isHoldingsStale(db, new Date("2026-01-15T00:00:00.000Z"))).toBe(false);
      expect(isHoldingsStale(db, new Date("2026-01-15T00:00:00.001Z"))).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects bad input and writes nothing", () => {
      expect(() => save("2026-02-30", 1, "manual")).toThrow();
      expect(() => save("2026-01-01", Infinity, "manual")).toThrow();
      expect(() => save("2026-01-01", 0, "manual")).toThrow();
      expect(() =>
        saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 1, shares_outstanding: 1.5, source: "manual" }),
      ).toThrow();
      expect(() =>
        saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 1, shares_outstanding: 1, source: "bogus" as HoldingsSource }),
      ).toThrow();
      expect(listHoldingsSnapshots(db)).toHaveLength(0);
    });
  });
});
