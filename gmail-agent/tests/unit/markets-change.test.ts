import { describe, expect, it } from "vitest";
import { calculateChange } from "../../src/markets/change.js";
import type { Candle } from "../../src/markets/types.js";
const candle = (timestamp: number, close: number): Candle => ({ timestamp, open: close, high: close, low: close, close, isLive: false });
describe("daily change", () => {
  it("uses last two Yahoo daily closes and reports the exchange weekday", () => {
    const result = calculateChange("MSTR", [candle(1795219200, 100), candle(1795305600, 105)], "America/New_York")!;
    expect(result.previousClose).toBe(100); expect(result.change).toBe(5); expect(result.changePercent).toBe(5);
    expect(result.weekday).toBe("Sat");
  });
  it("returns no change with one candle or a zero base", () => {
    expect(calculateChange("BTC-USD", [candle(1, 4)], "UTC")?.change).toBeNull();
    expect(calculateChange("BTC-USD", [candle(1, 0), candle(86401, 4)], "UTC")?.changePercent).toBeNull();
  });
});
