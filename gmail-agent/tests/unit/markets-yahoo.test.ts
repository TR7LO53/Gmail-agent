import { describe, expect, it, vi } from "vitest";
import { buildYahooUrl, fetchYahooChart, parseYahooChart, YahooError } from "../../src/markets/yahoo.js";

const syntheticPayload = {
  chart: { result: [{
    timestamp: [30, 10, 20, 40],
    indicators: { quote: [{ open: [3, 1, null, 4], high: [4, 2, 3, 5], low: [2, 0, 2, 3], close: [3.5, 1.5, 2.5, 4.5] }] },
    meta: { exchangeTimezoneName: "America/New_York" },
  }], error: null },
};

describe("Yahoo chart adapter", () => {
  it("maps timeframes and encodes futures symbols without a 4h interval", () => {
    expect(new URL(buildYahooUrl("GC=F", "H4")).pathname).toContain("GC%3DF");
    expect(new URL(buildYahooUrl("GC=F", "H4")).searchParams.get("interval")).toBe("1h");
    expect(new URL(buildYahooUrl("BTC-USD", "W1")).searchParams.get("interval")).toBe("1wk");
    expect(new URL(buildYahooUrl("SI=F", "MN")).searchParams.get("interval")).toBe("1mo");
  });

  it("parses a synthetic Yahoo-shaped response, preserves indices, sorts and resolves duplicates", () => {
    const parsed = parseYahooChart(syntheticPayload);
    expect(parsed.candles.map(({ time, close }) => [time, close])).toEqual([[10, 1.5], [30, 3.5], [40, 4.5]]);
    expect(parsed.metadata.exchangeTimezoneName).toBe("America/New_York");
  });

  it("returns distinct protocol and Yahoo errors", () => {
    expect(() => parseYahooChart({ chart: { result: null, error: null } })).toThrow(YahooError);
    expect(() => parseYahooChart({ chart: { error: { description: "denied" }, result: null } })).toThrow("denied");
  });

  it("checks HTTP status and never calls ambient fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    await expect(fetchYahooChart(fetchImpl, "MSTR", "D1")).rejects.toMatchObject({ category: "http" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
