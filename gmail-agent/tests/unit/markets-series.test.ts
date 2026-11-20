import { describe, expect, it } from "vitest";
import { aggregateDailyByLocalPeriod, aggregateH1ToH4, alignRatio, foldHourlyLatestTrade, markLiveCandles, quoteFromDailyCandles } from "../../src/markets/series.js";
import type { Candle } from "../../src/markets/types.js";
import type { YahooMetadata } from "../../src/markets/yahoo.js";

const candle = (time: number, open: number, high = open + 1, low = open - 1, close = open + 0.5): Candle => ({ time, open, high, low, close, isLive: false });

describe("market derived series", () => {
  it("groups H1 by fixed UTC H4 buckets across gaps", () => {
    const result = aggregateH1ToH4([candle(1, 10), candle(3600, 12, 15, 9, 14), candle(10800, 14, 16, 12, 15), candle(14400, 20)]);
    expect(result).toEqual([
      { time: 0, open: 10, high: 16, low: 9, close: 15, isLive: false },
      { time: 14400, open: 20, high: 21, low: 19, close: 20.5, isLive: false },
    ]);
  });

  it("folds a latest-trade point into the hour it falls in, keeping :30 equity bar starts", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 10, 19, h, m) / 1000;
    const folded = foldHourlyLatestTrade([candle(at(14, 30), 10, 12, 9, 11), candle(at(15, 30), 11, 13, 10, 12), candle(at(15, 47), 12, 20, 12, 18)]);
    expect(folded).toEqual([
      { time: at(14, 30), open: 10, high: 12, low: 9, close: 11, isLive: false },
      { time: at(15, 30), open: 11, high: 20, low: 10, close: 18, isLive: false },
    ]);
  });

  it("groups daily candles into exchange-local Monday weeks and months, across DST", () => {
    // New York equity bars open at 09:30 local: 13:30 UTC before the 2026-11-01 DST end, 14:30 UTC after it.
    const ny = "America/New_York";
    const fri = Date.UTC(2026, 9, 30, 13, 30) / 1000;   // Fri 30 Oct, 09:30 EDT
    const mon = Date.UTC(2026, 10, 2, 14, 30) / 1000;   // Mon 2 Nov, 09:30 EST — 3 days + 1 h later
    const tue = Date.UTC(2026, 10, 3, 14, 30) / 1000;
    const daily = [candle(fri, 10, 11, 9, 10.5), candle(mon, 20, 25, 19, 21), candle(tue, 21, 22, 15, 16)];
    expect(aggregateDailyByLocalPeriod(daily, "W1", ny)).toEqual([
      { time: fri, open: 10, high: 11, low: 9, close: 10.5, isLive: false },
      { time: mon, open: 20, high: 25, low: 15, close: 16, isLive: false },
    ]);
    expect(aggregateDailyByLocalPeriod(daily, "MN", ny).map(({ time, open, close }) => [time, open, close])).toEqual([[fri, 10, 10.5], [mon, 20, 16]]);
    // A latest-trade point later on the same local day is folded into that day.
    const sameDay = Date.UTC(2026, 10, 3, 20, 59) / 1000;
    expect(aggregateDailyByLocalPeriod([...daily, candle(sameDay, 16, 17, 14, 14.5)], "D1", ny).at(-1))
      .toEqual({ time: tue, open: 21, high: 22, low: 14, close: 14.5, isLive: false });
  });

  it("marks only the newest candle live when its interval contains now", () => {
    const rows = [candle(1_700_000_000, 10), candle(1_700_003_600, 11)];
    const now = (1_700_003_600 + 100) * 1000;
    const metadata: YahooMetadata = { exchangeTimezoneName: "UTC" };
    expect(markLiveCandles(rows, "H1", now, metadata, true).map((row) => row.isLive)).toEqual([false, true]);
    expect(markLiveCandles(rows, "H1", (1_700_003_600 + 3600) * 1000, metadata, true).at(-1)?.isLive).toBe(false);
  });

  it("uses the exchange session for equity daily and calendar candles", () => {
    const now = Date.UTC(2026, 10, 20, 15) / 1000;
    const metadata: YahooMetadata = {
      exchangeTimezoneName: "America/New_York",
      currentTradingPeriod: { regular: { start: Date.UTC(2026, 10, 20, 14) / 1000, end: Date.UTC(2026, 10, 20, 21) / 1000 } },
    };
    const sameFriday = Date.UTC(2026, 10, 20, 14, 30) / 1000;
    const priorMonday = Date.UTC(2026, 10, 16, 14, 30) / 1000;
    expect(markLiveCandles([candle(sameFriday, 1)], "D1", now * 1000, metadata, false)[0].isLive).toBe(true);
    expect(markLiveCandles([candle(priorMonday, 1)], "W1", now * 1000, metadata, false)[0].isLive).toBe(true);
    expect(markLiveCandles([candle(Date.UTC(2026, 10, 2, 14, 30) / 1000, 1)], "MN", now * 1000, metadata, false)[0].isLive).toBe(true);
    const saturday = Date.UTC(2026, 10, 21, 16) * 1000;
    expect(markLiveCandles([candle(sameFriday, 1)], "D1", saturday, metadata, false)[0].isLive).toBe(false);
  });

  it("computes the latest observed weekday and previous-close change", () => {
    const fri = Date.UTC(2026, 10, 20, 14, 30) / 1000;
    const quote = quoteFromDailyCandles("MSTR", [candle(fri - 86400, 100, 100, 100, 100), candle(fri, 110, 110, 110, 110)], 1, "America/New_York");
    expect(quote).toMatchObject({ current: 110, previousClose: 100, change: 10, changePercent: 10, observationWeekday: "Fri" });
  });

  it("aligns ratio only at shared timestamps and ignores invalid denominators", () => {
    const points = alignRatio([candle(1, 2000, 2000, 2000, 2000), candle(2, 2100, 2100, 2100, 2100)], [candle(1, 25, 25, 25, 25), candle(3, 30, 30, 30, 30)]);
    expect(points).toEqual([{ time: 1, value: 80, isLive: false }]);
    expect(alignRatio([candle(1, 10, 10, 10, 10)], [candle(1, 0, 0, 0, 0)])).toEqual([]);
  });
});
