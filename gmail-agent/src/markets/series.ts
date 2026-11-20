import type { Candle, LinePoint, Quote, Timeframe } from "./types.js";
import type { YahooMetadata } from "./yahoo.js";

const HOUR = 3600;
const H4_SECONDS = 4 * HOUR;

/** One candle spanning `group` (sorted by time), stamped at `time`. */
function combine(time: number, group: readonly Candle[]): Candle {
  return {
    time,
    open: group[0].open,
    high: Math.max(...group.map((c) => c.high)),
    low: Math.min(...group.map((c) => c.low)),
    close: group[group.length - 1].close,
    isLive: group.some((c) => c.isLive),
  };
}

/** H4 candles use fixed UTC buckets beginning at 00:00, 04:00, 08:00, and so on. */
export function aggregateH1ToH4(candles: readonly Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / H4_SECONDS) * H4_SECONDS;
    const group = groups.get(bucket) ?? [];
    group.push(candle);
    groups.set(bucket, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b)
    .map(([time, group]) => combine(time, [...group].sort((a, b) => a.time - b.time)));
}

/**
 * Yahoo appends a "latest trade" point after the last hourly bar, stamped minutes into
 * the same hour. Fold any candle that starts less than an hour after the previous one
 * into it, keeping the previous candle's start (equity H1 bars start at :30).
 */
export function foldHourlyLatestTrade(candles: readonly Candle[]): Candle[] {
  const result: Candle[] = [];
  for (const candle of candles) {
    const previous = result[result.length - 1];
    if (previous && candle.time < previous.time + HOUR) result[result.length - 1] = combine(previous.time, [previous, candle]);
    else result.push(candle);
  }
  return result;
}

function localParts(epochSeconds: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]));
}

type CalendarTimeframe = "D1" | "W1" | "MN";

/** The exchange-local day, Monday-started week, or month an instant falls in, as a comparable key. */
function localPeriodKey(epochSeconds: number, timeframe: CalendarTimeframe, timeZone: string): string {
  const { year, month, day } = localParts(epochSeconds, timeZone);
  if (timeframe === "MN") return `${year}-${month}`;
  if (timeframe === "D1") return `${year}-${month}-${day}`;
  const monday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * Groups daily candles into exchange-local days, weeks or months. Each candle is stamped
 * at its first daily candle. For D1 this folds Yahoo's appended latest-trade point into
 * its day; W1 and MN are always built this way because Yahoo's own weekly and monthly
 * bars split or replace the current period.
 */
export function aggregateDailyByLocalPeriod(
  candles: readonly Candle[], timeframe: CalendarTimeframe, timeZone: string,
): Candle[] {
  const groups = new Map<string, Candle[]>();
  for (const candle of [...candles].sort((a, b) => a.time - b.time)) {
    const key = localPeriodKey(candle.time, timeframe, timeZone);
    const group = groups.get(key) ?? [];
    group.push(candle);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => combine(group[0].time, group));
}

function sameLocalPeriod(a: number, b: number, timeframe: CalendarTimeframe, timeZone: string): boolean {
  return localPeriodKey(a, timeframe, timeZone) === localPeriodKey(b, timeframe, timeZone);
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
      const seconds = timeframe === "H1" ? HOUR : H4_SECONDS;
      isLive = now >= last.time && now < last.time + seconds;
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
