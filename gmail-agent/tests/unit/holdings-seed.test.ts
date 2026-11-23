import { afterEach, beforeEach, describe, expect, it } from "vitest";
import history from "../../src/markets/data/holdings-history.json";
import { openDb, type DB } from "../../src/memory/db.js";
import { listHoldingsSnapshots, saveHoldingsSnapshot } from "../../src/memory/holdings.js";
import {
  seedHoldingsSnapshots,
  validateHoldingsHistory,
  type HoldingsHistory,
} from "../../src/memory/holdings-seed.js";

const row = (date: string, btc_held = 100, shares_outstanding = 1000) => ({ date, btc_held, shares_outstanding });
const tiny = (...rows: ReturnType<typeof row>[]): HoldingsHistory => ({ metadata: {}, snapshots: rows });

describe("holdings seed loading", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("openDb loads the whole history once", () => {
    expect(listHoldingsSnapshots(db)).toHaveLength(history.snapshots.length);
    expect(listHoldingsSnapshots(db).every((s) => s.source === "automatic")).toBe(true);
  });

  it("a second seed run inserts nothing and changes nothing", () => {
    const before = listHoldingsSnapshots(db);
    expect(seedHoldingsSnapshots(db)).toBe(0);
    expect(listHoldingsSnapshots(db)).toEqual(before);
  });

  it("does not seed a table that has any row, even a manual one", () => {
    db.exec("DELETE FROM holdings_snapshots");
    saveHoldingsSnapshot(db, { date: "2026-01-01", btc_held: 5, shares_outstanding: 10, source: "manual" });
    expect(seedHoldingsSnapshots(db)).toBe(0);
    expect(listHoldingsSnapshots(db)).toHaveLength(1);
  });

  it("seeds an emptied table, skipping the 10% sanity check", () => {
    db.exec("DELETE FROM holdings_snapshots");
    expect(seedHoldingsSnapshots(db, tiny(row("2020-08-11", 100), row("2020-09-14", 300)))).toBe(2);
    expect(listHoldingsSnapshots(db).map((s) => s.btc_held)).toEqual([100, 300]);
  });

  it("writes only to holdings_snapshots", () => {
    db.exec("DELETE FROM holdings_snapshots");
    const logsBefore = (db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n;
    const metaBefore = (db.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }).n;
    seedHoldingsSnapshots(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n).toBe(logsBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }).n).toBe(metaBefore);
  });
});

describe("validateHoldingsHistory", () => {
  it("rejects an empty history", () => {
    expect(() => validateHoldingsHistory(tiny())).toThrow(/snapshots/);
  });

  it("rejects duplicate and unsorted dates", () => {
    expect(() => validateHoldingsHistory(tiny(row("2020-08-11"), row("2020-08-11")))).toThrow(/unsorted/);
    expect(() => validateHoldingsHistory(tiny(row("2020-09-01"), row("2020-08-11")))).toThrow(/unsorted/);
  });

  it("rejects impossible dates, bad BTC and bad share counts", () => {
    expect(() => validateHoldingsHistory(tiny(row("2020-02-30")))).toThrow();
    expect(() => validateHoldingsHistory(tiny(row("2020-08-11", 0)))).toThrow(/BTC/);
    expect(() => validateHoldingsHistory(tiny(row("2020-08-11", 1, 1.5)))).toThrow(/shares/);
  });

  it("rejects a history that does not start in August 2020", () => {
    expect(() => validateHoldingsHistory(tiny(row("2020-09-14")))).toThrow(/August 2020/);
  });
});

describe("the committed history file (SEC EDGAR)", () => {
  const rows = history.snapshots;

  it("passes validation", () => {
    expect(() => validateHoldingsHistory(history as HoldingsHistory)).not.toThrow();
  });

  it("starts in August 2020 and its dates strictly increase", () => {
    expect(rows[0].date.startsWith("2020-08")).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i].date > rows[i - 1].date).toBe(true);
  });

  it("BTC held never decreases, except where the filing reports bitcoin sales", () => {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].btc_held < rows[i - 1].btc_held) {
        expect(rows[i].btc_source as { sold?: boolean }, rows[i].date).toMatchObject({ sold: true });
        // A real sale is small; a parsing slip would be far bigger.
        expect(rows[i].btc_held / rows[i - 1].btc_held, rows[i].date).toBeGreaterThan(0.95);
      }
    }
  });

  it("share counts on both sides of the 2024-08-08 split are on the same scale", () => {
    const before = [...rows].reverse().find((r) => r.date < "2024-08-08")!;
    const after = rows.find((r) => r.date >= "2024-08-08")!;
    const ratio = after.shares_outstanding / before.shares_outstanding;
    // A missed split would give about 10 (or 0.1 if applied twice).
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("every row names its sources, and a share count is never from the future", () => {
    for (const r of rows) {
      expect(r.btc_source.accession, r.date).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(r.shares_source.accession, r.date).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(r.shares_source.as_of <= r.date, r.date).toBe(true);
    }
  });

  it("shares are class A + class B, on the post-split scale", () => {
    for (const r of rows) {
      const { class_a, class_b, split_factor, as_of } = r.shares_source;
      expect(split_factor, r.date).toBe(as_of < "2024-08-08" ? 10 : 1);
      expect(r.shares_outstanding, r.date).toBe((class_a + class_b) * split_factor);
    }
  });
});
