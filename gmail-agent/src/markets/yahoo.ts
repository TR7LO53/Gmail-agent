import type { Candle, Instrument, Timeframe, MarketErrorCategory } from "./types.js";

export interface YahooMetadata {
  exchangeTimezoneName: string;
  currentTradingPeriod?: { regular?: { start?: number; end?: number } };
}

export interface YahooChart {
  candles: Candle[];
  metadata: YahooMetadata;
}

export class YahooError extends Error {
  constructor(readonly category: MarketErrorCategory, message: string) {
    super(message);
    this.name = "YahooError";
  }
}

type YahooInterval = "1h" | "1d" | "1wk" | "1mo";

const intervalFor: Record<Exclude<Timeframe, "H4">, YahooInterval> = {
  H1: "1h", D1: "1d", W1: "1wk", MN: "1mo",
};

// Yahoo silently downgrades 1d and 1wk to monthly bars when asked for range=max
// (checked 2026-11-20 on all five Instruments), so those use the longest range
// that still keeps the requested interval. Intraday history is capped at ~2 years.
const rangeFor: Record<YahooInterval, string> = {
  "1h": "730d", "1d": "20y", "1wk": "50y", "1mo": "max",
};

export function yahooIntervalFor(timeframe: Timeframe): YahooInterval {
  return timeframe === "H4" ? "1h" : intervalFor[timeframe];
}

export function buildYahooUrl(symbol: Instrument, timeframe: Timeframe): string {
  const interval = yahooIntervalFor(timeframe);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", rangeFor[interval]);
  url.searchParams.set("interval", interval);
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

/** `expectedInterval`, when given, rejects a response whose bars are not the interval that was asked for. */
export function parseYahooChart(payload: unknown, expectedInterval?: YahooInterval): YahooChart {
  const root = record(payload);
  const chart = record(root?.chart);
  if (!chart) throw new YahooError("protocol", "Yahoo response is missing chart data.");
  if (chart.error) {
    const error = record(chart.error);
    throw new YahooError("yahoo", typeof error?.description === "string" ? error.description : "Yahoo rejected the chart request.");
  }
  const results = chart.result;
  if (!Array.isArray(results) || !results[0]) throw new YahooError("protocol", "Yahoo response is missing chart result.");
  const result = record(results[0]);
  const timestamps = result?.timestamp;
  const indicators = record(result?.indicators);
  const quote = Array.isArray(indicators?.quote) ? record(indicators.quote[0]) : null;
  if (!Array.isArray(timestamps) || !quote) throw new YahooError("protocol", "Yahoo response is missing timestamps or quote data.");

  const fields = [quote.open, quote.high, quote.low, quote.close];
  const validTimes = timestamps.filter((time): time is number => Number.isFinite(time));
  const byTime = new Map<number, Candle>();
  for (let index = 0; index < timestamps.length; index++) {
    const time = timestamps[index];
    if (!Number.isFinite(time)) continue;
    const values = fields.map((field) => Array.isArray(field) ? field[index] : undefined);
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    byTime.set(time as number, {
      time: time as number,
      open: values[0] as number,
      high: values[1] as number,
      low: values[2] as number,
      close: values[3] as number,
      isLive: false,
    });
  }
  if (validTimes.length !== timestamps.length) throw new YahooError("protocol", "Yahoo response contains invalid timestamps.");
  const meta = record(result?.meta);
  const tz = meta?.exchangeTimezoneName;
  if (typeof tz !== "string" || !tz) throw new YahooError("protocol", "Yahoo response is missing exchange timezone metadata.");
  const granularity = meta?.dataGranularity;
  if (expectedInterval && granularity !== expectedInterval) {
    throw new YahooError("protocol", `Yahoo returned ${String(granularity)} bars instead of ${expectedInterval}.`);
  }
  return {
    candles: [...byTime.values()].sort((a, b) => a.time - b.time),
    metadata: {
      exchangeTimezoneName: tz,
      currentTradingPeriod: record(meta.currentTradingPeriod) as YahooMetadata["currentTradingPeriod"],
    },
  };
}

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function fetchYahooChart(fetchImpl: FetchImpl, symbol: Instrument, timeframe: Timeframe): Promise<YahooChart> {
  const url = buildYahooUrl(symbol, timeframe);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new YahooError("timeout", "Yahoo request timed out.");
    }
    throw new YahooError("transport", "Could not reach Yahoo Finance.");
  }
  if (!response.ok) throw new YahooError("http", `Yahoo returned HTTP ${response.status}.`);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new YahooError("protocol", "Yahoo returned invalid JSON."); }
  return parseYahooChart(payload, yahooIntervalFor(timeframe));
}
