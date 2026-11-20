import { describe, expect, it } from "vitest";
import { calculateStrategyPremium } from "../../src/markets/strategy-premium.js";
import type { HoldingsSnapshot } from "../../src/memory/holdings.js";

describe("Strategy Premium", () => {
  it("uses the snapshot in effect at each shared close and returns a fraction", () => {
    const snapshots: HoldingsSnapshot[] = [
      { date: "2026-01-01", btc_held: 100, shares_outstanding: 1000, source: "automatic", created_at: "" },
      { date: "2026-01-03", btc_held: 200, shares_outstanding: 1500, source: "automatic", created_at: "" },
    ];
    const stock = ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map((date, i) => ({ periodKey: date, closeAt: `${date}T21:00:00Z`, close: [20, 20, 15, 20, 10][i] }));
    const coin = stock.map(({ periodKey, closeAt }) => ({ periodKey, closeAt: new Date(Date.parse(closeAt) + 60_000).toISOString(), close: 100 }));
    expect(calculateStrategyPremium(stock, coin, snapshots).map(({ value }) => value)).toEqual([1, 0.5, 0.5, -0.25]);
  });
  it("omits unmatched closes without mutating inputs", () => {
    const mstr = [{ periodKey: "x", closeAt: "2026-01-01T00:00:00Z", close: 10 }];
    expect(calculateStrategyPremium(mstr, [], [])).toEqual([]);
    expect(mstr).toHaveLength(1);
  });
});
