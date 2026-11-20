import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { quoteFromDailyCandles } from "../../src/markets/series.js";
import { createPriceSource } from "../../src/markets/source.js";
import { buildYahooUrl, fetchYahooChart, parseYahooChart, YahooError } from "../../src/markets/yahoo.js";

/** Unmodified Yahoo responses — see tests/fixtures/markets/yahoo/README.md. */
function recorded(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/markets/yahoo/${name}.json`, import.meta.url), "utf8"));
}

const syntheticPayload = {
  chart: { result: [{
    timestamp: [30, 10, 20, 40],
    indicators: { quote: [{ open: [3, 1, null, 4], high: [4, 2, 3, 5], low: [2, 0, 2, 3], close: [3.5, 1.5, 2.5, 4.5] }] },
    meta: { exchangeTimezoneName: "America/New_York" },
  }], error: null },
};

describe("Yahoo chart adapter", () => {
  it("encodes futures symbols and fetches only hourly and daily bars, with ranges that keep them", () => {
    expect(new URL(buildYahooUrl("GC=F", "H1")).pathname).toContain("GC%3DF");
    const params = (timeframe: Parameters<typeof buildYahooUrl>[1]) => {
      const { searchParams } = new URL(buildYahooUrl("MSTR", timeframe));
      return [searchParams.get("interval"), searchParams.get("range")];
    };
    expect(params("H1")).toEqual(["1h", "730d"]);
    expect(params("D1")).toEqual(["1d", "30y"]);
  });

  it("parses a recorded daily Yahoo response into ordered daily candles and a previous-day quote", () => {
    const { candles, metadata } = parseYahooChart(recorded("mstr-1d-5d"), "1d");
    expect(candles).toHaveLength(5);
    const days = candles.map(({ time }) => new Date(time * 1000).toISOString().slice(0, 10));
    expect(new Set(days).size).toBe(5);
    expect(days).toEqual([...days].sort());
    const quote = quoteFromDailyCandles("MSTR", candles, 1, metadata.exchangeTimezoneName);
    expect(quote.previousClose).toBe(candles[3].close);
    expect(quote.current).toBe(candles[4].close);
  });

  it("rejects a recorded response where Yahoo downgraded 1d to monthly bars", () => {
    const payload = recorded("btc-usd-1d-range-max-downgraded");
    expect(() => parseYahooChart(payload, "1d")).toThrow(/1mo bars instead of 1d/);
    expect(() => parseYahooChart(payload)).not.toThrow();
  });

  it("reports a downgraded response as a protocol error instead of a wrong chart", async () => {
    const payload = JSON.stringify(recorded("btc-usd-1d-range-max-downgraded"));
    const logger = vi.fn();
    const source = createPriceSource({ fetchImpl: async () => new Response(payload, { status: 200 }), logger });
    const result = await source.getCandles("BTC-USD", "D1");
    expect(result).toMatchObject({ ok: false, error: { category: "protocol" } });
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("folds Yahoo's appended latest-trade point into the current hour (recorded BTC-USD 1h)", async () => {
    const payload = JSON.stringify(recorded("btc-usd-1h-1d"));
    const source = createPriceSource({ fetchImpl: async () => new Response(payload, { status: 200 }), logger: vi.fn() });
    const result = await source.getCandles("BTC-USD", "H1");
    if (!result.ok) throw new Error(result.error.message);
    const stamps = result.value.candles.map(({ time }) => new Date(time * 1000).toISOString().slice(0, 16));
    expect(stamps.at(-1)).toBe("2026-11-20T14:00");
    expect(stamps.every((stamp) => stamp.endsWith(":00"))).toBe(true);
    expect(result.value.candles.at(-1)).toMatchObject({ open: 61812.171875, close: 61868.94921875 });
  });

  it("builds the current month from daily bars, not Yahoo's one-day monthly bar (recorded GC=F 1d)", async () => {
    const payload = JSON.stringify(recorded("gc-f-1d-2mo"));
    const source = createPriceSource({ fetchImpl: async () => new Response(payload, { status: 200 }), logger: vi.fn() });
    const month = await source.getCandles("GC=F", "MN");
    const week = await source.getCandles("GC=F", "W1");
    if (!month.ok || !week.ok) throw new Error("expected candles");
    const november = month.value.candles.at(-1)!;
    expect(new Date(november.time * 1000).toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(november).toMatchObject({ open: 3890, close: 3567.60009765625 });
    const thisWeek = week.value.candles.at(-1)!;
    expect(new Date(thisWeek.time * 1000).toISOString().slice(0, 10)).toBe("2026-11-16");
    expect(thisWeek.close).toBe(3567.60009765625);
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
