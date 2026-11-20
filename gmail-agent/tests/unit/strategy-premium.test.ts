import { describe, expect, it } from "vitest";
import type { HoldingsSnapshot } from "../../src/memory/holdings.js";
import { strategyPremiumLine } from "../../src/markets/strategy-premium.js";
import type { Candle } from "../../src/markets/types.js";

const utc = (month: number, day: number, hour = 0, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour, minute) / 1000;

const candle = (time: number, close: number, isLive = false): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  isLive,
});

const snapshot = (date: string, btc_held: number, shares_outstanding: number): HoldingsSnapshot => ({
  date,
  btc_held,
  shares_outstanding,
  source: "automatic",
  created_at: "2026-01-01T00:00:00.000Z",
});

// Hand-worked example: the Snapshot changes on 2026-01-07.
const snapshots = [snapshot("2026-01-05", 100, 1000), snapshot("2026-01-07", 200, 1500)];
const mstr = [
  candle(utc(1, 2, 14, 30), 20),
  candle(utc(1, 5, 14, 30), 20),
  candle(utc(1, 6, 14, 30), 15),
  candle(utc(1, 7, 14, 30), 20),
];
// BTC trades every day, including the weekend of 3–4 January; close is 100 throughout.
const btc = [2, 3, 4, 5, 6, 7].map((day) => candle(utc(1, day), 100));

describe("strategyPremiumLine", () => {
  it("computes percent premium with the Snapshot in effect, skipping days before the first", () => {
    const line = strategyPremiumLine(mstr, btc, snapshots, "D1");
    expect(line.map((p) => p.time)).toEqual([utc(1, 5, 14, 30), utc(1, 6, 14, 30), utc(1, 7, 14, 30)]);
    // 20·1000/(100·100) − 1 = +100%;  15·1000/(100·100) − 1 = +50%;  20·1500/(200·100) − 1 = +50%
    expect(line.map((p) => p.value)).toEqual([100, 50, 50]);
  });

  it("makes no point for BTC-only weekend candles", () => {
    const line = strategyPremiumLine(mstr, btc, snapshots, "D1");
    expect(line.some((p) => p.time === utc(1, 3) || p.time === utc(1, 4))).toBe(false);
  });

  it("skips an MSTR candle that has no BTC candle in its period", () => {
    const withoutJan6 = btc.filter((c) => c.time !== utc(1, 6));
    const line = strategyPremiumLine(mstr, withoutJan6, snapshots, "D1");
    // Jan 6's nearest earlier BTC candle (Jan 5) is more than one day before 14:30 on Jan 6.
    expect(line.map((p) => p.time)).toEqual([utc(1, 5, 14, 30), utc(1, 7, 14, 30)]);
  });

  it("uses the BTC candle of the same period, not a later one", () => {
    const btcLater = [candle(utc(1, 5, 20), 50)]; // starts after the MSTR candle
    expect(strategyPremiumLine([candle(utc(1, 5, 14, 30), 20)], btcLater, snapshots, "D1")).toEqual([]);
  });

  it("matches hourly candles that start at :30 with BTC candles that start at :00", () => {
    const line = strategyPremiumLine(
      [candle(utc(1, 5, 14, 30), 20), candle(utc(1, 5, 15, 30), 20)],
      [candle(utc(1, 5, 14), 100), candle(utc(1, 5, 15), 200)],
      snapshots,
      "H1",
    );
    expect(line.map((p) => p.value)).toEqual([100, 0]);
  });

  it("matches weekly and monthly candles that start on different days of the period", () => {
    const week = strategyPremiumLine([candle(utc(1, 6, 14, 30), 20)], [candle(utc(1, 5), 100)], snapshots, "W1");
    expect(week.map((p) => p.value)).toEqual([100]);
    const month = strategyPremiumLine([candle(utc(2, 2, 14, 30), 20)], [candle(utc(2, 1), 100)], snapshots, "MN");
    // On 2 Feb the 2026-01-07 Snapshot is in effect: 20·1500/(200·100) − 1 = +50%.
    expect(month.map((p) => p.value)).toEqual([50]);
  });

  it("is live when either candle is live", () => {
    const line = strategyPremiumLine(
      [candle(utc(1, 5, 14, 30), 20, true), candle(utc(1, 6, 14, 30), 20)],
      [candle(utc(1, 5), 100), candle(utc(1, 6), 100, true)],
      snapshots,
      "D1",
    );
    expect(line.map((p) => p.isLive)).toEqual([true, true]);
    expect(strategyPremiumLine(mstr, btc, snapshots, "D1").some((p) => p.isLive)).toBe(false);
  });

  it("skips non-positive prices", () => {
    const line = strategyPremiumLine([candle(utc(1, 5, 14, 30), 0)], btc, snapshots, "D1");
    expect(line).toEqual([]);
    expect(strategyPremiumLine([candle(utc(1, 5, 14, 30), 20)], [candle(utc(1, 5), 0)], snapshots, "D1")).toEqual([]);
  });

  it("returns nothing without Snapshots and leaves its inputs untouched", () => {
    expect(strategyPremiumLine(mstr, btc, [], "D1")).toEqual([]);

    const unsortedSnapshots = [snapshots[1], snapshots[0]];
    const mstrCopy = structuredClone(mstr);
    const btcCopy = structuredClone(btc);
    const snapshotsCopy = structuredClone(unsortedSnapshots);
    const line = strategyPremiumLine(mstrCopy.reverse(), btcCopy.reverse(), unsortedSnapshots, "D1");
    expect(line.map((p) => p.value)).toEqual([100, 50, 50]);
    expect(unsortedSnapshots).toEqual(snapshotsCopy);
    expect(btcCopy[0]).toEqual(btc[btc.length - 1]);
  });
});
