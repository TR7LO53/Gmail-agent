import { describe, expect, it, vi } from "vitest";
import { createPriceSource } from "../../src/markets/source.js";

function response(close = 100) {
  return new Response(JSON.stringify({ chart: { error: null, result: [{
    timestamp: [1_700_000_000, 1_700_003_600],
    indicators: { quote: [{ open: [close, close], high: [close, close], low: [close, close], close: [close, close] }] },
    meta: { exchangeTimezoneName: "UTC", currentTradingPeriod: { regular: { start: 1_700_000_000, end: 1_700_100_000 } } },
  }] } }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("price source cache and isolation", () => {
  it("shares concurrent requests and expires at the TTL boundary", async () => {
    let now = 5_000;
    const fetchImpl = vi.fn(async () => response());
    const source = createPriceSource({ fetchImpl, now: () => now, ttlMs: 100, logger: vi.fn() });
    const [a, b] = await Promise.all([source.getCandles("BTC-USD", "H1"), source.getCandles("BTC-USD", "H1")]);
    expect(a.ok && b.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 5_099; await source.getCandles("BTC-USD", "H1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 5_100; await source.getCandles("BTC-USD", "H1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares H1/H4 and D1/quote inputs, and reports one symbol failure independently", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => String(input).includes("MSTR")
      ? new Response("", { status: 503 }) : response());
    const logger = vi.fn();
    const source = createPriceSource({ fetchImpl, now: () => 1_700_050_000_000, logger });
    const [h1, h4] = await Promise.all([source.getCandles("BTC-USD", "H1"), source.getCandles("BTC-USD", "H4")]);
    expect(h1.ok && h4.ok).toBe(true);
    await source.getCandles("BTC-USD", "D1"); await source.getQuote("BTC-USD");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const many = await source.getMany(["BTC-USD", "MSTR", "CCJ"], "D1");
    expect(many["BTC-USD"]?.ok).toBe(true);
    expect(many.MSTR?.ok).toBe(false);
    expect(many.CCJ?.ok).toBe(true);
    expect(logger).toHaveBeenCalledTimes(1);
  });
});
