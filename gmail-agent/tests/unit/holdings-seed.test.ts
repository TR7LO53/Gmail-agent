import { describe, expect, it } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { seedHoldingsSnapshots, validateHoldingsHistory, type HoldingsHistory } from "../../src/memory/holdings-seed.js";
import { listHoldingsSnapshots, saveHoldingsSnapshot } from "../../src/memory/holdings.js";

describe("holdings history seed", () => {
  it("loads static history once and respects any existing row", () => {
    const db = openDb(":memory:");
    const first = listHoldingsSnapshots(db);
    expect(first[0]).toMatchObject({ date: "2020-08-10", btc_held: 21454, source: "automatic" });
    expect(seedHoldingsSnapshots(db)).toBe(0);
    expect(listHoldingsSnapshots(db)).toEqual(first);
    db.exec("DELETE FROM holdings_snapshots");
    saveHoldingsSnapshot(db, { date: "2025-01-01", btc_held: 10, shares_outstanding: 10, source: "manual" });
    expect(seedHoldingsSnapshots(db)).toBe(0);
    expect(listHoldingsSnapshots(db)).toHaveLength(1);
    db.close();
  });
  it("rejects invalid, duplicate, or unsorted seed rows before import", () => {
    const invalid = { metadata: {}, snapshots: [
      { date: "2020-08-11", btc_held: 2, shares_outstanding: 3 },
      { date: "2020-08-11", btc_held: 4, shares_outstanding: 3 },
    ] } as HoldingsHistory;
    expect(() => validateHoldingsHistory(invalid)).toThrow();
  });
});
