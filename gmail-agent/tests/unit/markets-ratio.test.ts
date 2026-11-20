import { describe, expect, it } from "vitest";
import { buildGoldSilverRatio } from "../../src/markets/ratio.js";
import type { Candle } from "../../src/markets/types.js";
const c = (timestamp: number, close: number, isLive = false): Candle => ({ timestamp, open: close, high: close, low: close, close, isLive });
describe("gold/silver ratio", () => {
  it("divides close at exact matching times, skipping gaps and zero silver", () => {
    expect(buildGoldSilverRatio([c(1, 2000), c(2, 2100, true), c(3, 2200)], [c(1, 20), c(2, 0), c(4, 22)])).toEqual([{ timestamp: 1, value: 100, isLive: false }]);
  });
});
