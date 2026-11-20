import { describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/markets/chart-synthetic.json";
import { fetchYahooChart, parseYahooChart, yahooChartUrl } from "../../src/markets/yahoo.js";
import { YAHOO_INTERVAL } from "../../src/markets/timeframes.js";
describe("Yahoo chart adapter", () => {
  it("maps aligned OHLC arrays, sorts and deduplicates by timestamp", () => {
    expect(parseYahooChart(fixture).candles).toEqual([
      { timestamp: 1795046400, open: 100, high: 103, low: 99, close: 102, isLive: false },
      { timestamp: 1795132800, open: 102, high: 106, low: 101, close: 105, isLive: false },
      { timestamp: 1795219200, open: 105, high: 108, low: 104, close: 107, isLive: false },
    ]);
  });
  it("skips a candle when any aligned OHLC value is null", () => {
    const input = structuredClone(fixture);
    input.chart.result[0].indicators.quote[0].close[1] = null as never;
    expect(parseYahooChart(input).candles.map(c => c.timestamp)).toEqual([1795046400, 1795219200]);
  });
  it("encodes futures symbols and maps Yahoo intervals", () => {
    expect(yahooChartUrl("GC=F", "H1")).toContain("/GC%3DF?interval=1h&range=2y");
    expect(YAHOO_INTERVAL).toEqual({ H1: "1h", H4: "1h", D1: "1d", W1: "1wk", MN: "1mo" });
    expect(yahooChartUrl("MSTR", "MN")).toContain("interval=1mo");
  });
  it("returns HTTP and protocol failures as Yahoo errors", async () => {
    await expect(fetchYahooChart("BTC-USD", "D1", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })))).rejects.toMatchObject({ code: "http", httpStatus: 429 });
    await expect(fetchYahooChart("BTC-USD", "D1", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ chart: { error: { description: "bad symbol" } } }) })))).rejects.toMatchObject({ code: "yahoo" });
    expect(() => parseYahooChart({ chart: { result: null, error: null } })).toThrow();
  });
});
