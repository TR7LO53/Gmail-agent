import type { Candle, LinePoint, Quote, Timeframe } from "./types.js";
import type { YahooMetadata } from "./yahoo.js";

const HOUR = 3600;

/** H4 candles use fixed UTC buckets beginning at 00:00, 04:00, 08:00, and so on. */
export function aggregateH1ToH4(candles: readonly Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / (4 * HOUR)) * 4 * HOUR;
    const group = groups.get(bucket) ?? [];
    group.push(candle);
    groups.set(bucket, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([time, unsorted]) => {
    const group = [...unsorted].sort((a, b) => a.time - b.time);
    return {
      time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      isLive: group.some((c) => c.isLive),
    };
  });
}

function localParts(epochSeconds: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]));
}

function sameLocalDate(a: number, b: number, timeZone: string): boolean {
  const x = localParts(a, timeZone); const y = localParts(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

function sameLocalPeriod(candleTime: number, now: number, timeframe: Timeframe, timeZone: string): boolean {
  const c = localParts(candleTime, timeZone); const n = localParts(now, timeZone);
  if (timeframe === "W1") {
    const date = new Date(Date.UTC(Number(c.year), Number(c.month) - 1, Number(c.day)));
    const weekday = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
    const nd = new Date(Date.UTC(Number(n.year), Number(n.month) - 1, Number(n.day)));
    const nw = nd.getUTCDay(); nd.setUTCDate(nd.getUTCDate() - ((nw + 6) % 7));
    return date.getTime() === nd.getTime();
  }
  return c.year === n.year && c.month === n.month;
}

export function markLiveCandles(
  candles: readonly Candle[], timeframe: Timeframe, nowMs: number, metadata: YahooMetadata, isCrypto: boolean,
): Candle[] {
  const now = Math.floor(nowMs / 1000);
  const last = candles[candles.length - 1];
  if (!last) return [];
  const period = metadata.currentTradingPeriod?.regular;
  const withinSession = isCrypto || !period?.start || !period?.end
    ? isCrypto
    : now >= period.start && now < period.end;
  let isLive = false;
  if (withinSession) {
    if (timeframe === "H1" || timeframe === "H4") {
      const seconds = timeframe === "H1" ? HOUR : 4 * HOUR;
      isLive = now >= last.time && now < last.time + seconds;
    } else if (timeframe === "D1") {
      isLive = sameLocalDate(last.time, now, metadata.exchangeTimezoneName);
    } else {
      isLive = sameLocalPeriod(last.time, now, timeframe, metadata.exchangeTimezoneName);
    }
  }
  return candles.map((candle, index) => ({ ...candle, isLive: index === candles.length - 1 && isLive }));
}

export function quoteFromDailyCandles(
  symbol: Quote["symbol"], candles: readonly Candle[], fetchedAt: number, timeZone: string,
): Quote {
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  if (!current) return {
    symbol, current: null, currentTime: null, previousClose: null, previousCloseTime: null,
    change: null, changePercent: null, observationWeekday: null, fetchedAt,
    unavailableReason: "Yahoo returned no daily price observations.",
  };
  const weekday = localParts(current.time, timeZone).weekday ?? null;
  const change = previous ? current.close - previous.close : null;
  const changePercent = previous && previous.close !== 0 ? (change! / previous.close) * 100 : null;
  return {
    symbol,
    current: current.close,
    currentTime: current.time,
    previousClose: previous?.close ?? null,
    previousCloseTime: previous?.time ?? null,
    change,
    changePercent,
    observationWeekday: weekday,
    fetchedAt,
    ...(!previous ? { unavailableReason: "At least two daily observations are needed to calculate change." } : {}),
    ...(previous?.close === 0 ? { unavailableReason: "Change percent is unavailable because the previous close is zero." } : {}),
  };
}

export function alignRatio(gold: readonly Candle[], silver: readonly Candle[]): LinePoint[] {
  const silverByTime = new Map(silver.map((candle) => [candle.time, candle]));
  return gold.flatMap((goldCandle) => {
    const silverCandle = silverByTime.get(goldCandle.time);
    if (!silverCandle || !Number.isFinite(goldCandle.close) || !Number.isFinite(silverCandle.close) || silverCandle.close === 0) return [];
    return [{ time: goldCandle.time, value: goldCandle.close / silverCandle.close, isLive: goldCandle.isLive || silverCandle.isLive }];
  });
}
