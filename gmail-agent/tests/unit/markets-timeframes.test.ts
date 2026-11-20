import { describe, expect, it } from "vitest";
import { aggregateH1ToH4, markLive } from "../../src/markets/timeframes.js";
import type { Candle } from "../../src/markets/types.js";
const c = (timestamp: number, open: number, high: number, low: number, close: number): Candle => ({ timestamp, open, high, low, close, isLive: false });
describe("market timeframes", () => {
  it("aggregates by UTC bucket instead of consecutive row count", () => {
    expect(aggregateH1ToH4([c(10800, 3, 5, 2, 4), c(3600, 1, 2, 0, 1.5), c(7200, 2, 4, 1, 3), c(14400, 5, 6, 4, 5)])).toEqual([
      { timestamp: 0, open: 1, high: 5, low: 0, close: 4, isLive: false },
      { timestamp: 14400, open: 5, high: 6, low: 4, close: 5, isLive: false },
    ]);
  });
  it("marks the current hourly candle live and keeps a gap unfilled", () => {
    expect(markLive([c(0, 1, 2, 0, 1), c(3600, 1, 3, 1, 2)], "H1", 5_000_000, "UTC").map(x => x.isLive)).toEqual([false, true]);
    expect(aggregateH1ToH4([c(0, 1, 1, 1, 1), c(10800, 3, 3, 3, 3)])).toHaveLength(1);
  });
});
