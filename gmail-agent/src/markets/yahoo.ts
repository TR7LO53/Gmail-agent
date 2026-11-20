import { MARKET_SYMBOLS, type Candle, type MarketError, type MarketSymbol, type Timeframe } from "./types.js";
import { YAHOO_INTERVAL, YAHOO_RANGE } from "./timeframes.js";
export interface YahooTransportResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type YahooFetch = (url: string, init: { signal: AbortSignal }) => Promise<YahooTransportResponse>;
export interface YahooChart { candles: Candle[]; exchangeTimezone: string; currency: string | null }
export class YahooError extends Error {
  constructor(readonly code: MarketError["code"], message: string, readonly httpStatus?: number) { super(message); }
}
export function yahooChartUrl(symbol: MarketSymbol, timeframe: Timeframe): string {
  return "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) +
    "?interval=" + YAHOO_INTERVAL[timeframe] + "&range=" + YAHOO_RANGE[timeframe] + "&events=div%2Csplits";
}
function object(v: unknown): Record<string, any> | null { return v !== null && typeof v === "object" ? v as Record<string, any> : null; }
export function parseYahooChart(payload: unknown): YahooChart {
  const chart = object(object(payload)?.chart);
  if (!chart) throw new YahooError("invalid-json", "Yahoo returned an invalid response");
  if (chart.error) throw new YahooError("yahoo", String(chart.error.description ?? chart.error.code ?? "Yahoo chart error"));
  const result = chart.result?.[0];
  if (!result) throw new YahooError("no-data", "Yahoo returned no chart data");
  const timestamps: unknown[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new YahooError("no-data", "Yahoo response has no quote candles");
  const candles = new Map<number, Candle>();
  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    const values = [quote.open?.[i], quote.high?.[i], quote.low?.[i], quote.close?.[i]];
    if (!Number.isInteger(timestamp) || !values.every(v => typeof v === "number" && Number.isFinite(v))) continue;
    const [open, high, low, close] = values as number[];
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    candles.set(timestamp as number, { timestamp: timestamp as number, open, high, low, close, isLive: false });
  }
  const ordered = [...candles.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (!ordered.length) throw new YahooError("no-data", "Yahoo response contains no valid candles");
  return { candles: ordered, exchangeTimezone: result.meta?.exchangeTimezoneName ?? "UTC", currency: result.meta?.currency ?? null };
}
export async function fetchYahooChart(symbol: MarketSymbol, timeframe: Timeframe, fetcher: YahooFetch, timeoutMs = 10_000): Promise<YahooChart> {
  if (!(MARKET_SYMBOLS as readonly string[]).includes(symbol)) throw new YahooError("unsupported", "Unsupported market symbol: " + symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(yahooChartUrl(symbol, timeframe), { signal: controller.signal });
    if (!response.ok) throw new YahooError("http", "Yahoo HTTP " + response.status, response.status);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new YahooError("invalid-json", "Yahoo returned invalid JSON"); }
    return parseYahooChart(payload);
  } catch (error) {
    if (error instanceof YahooError) throw error;
    if (controller.signal.aborted) throw new YahooError("timeout", "Yahoo request timed out");
    throw new YahooError("network", error instanceof Error ? error.message : "Yahoo request failed");
  } finally { clearTimeout(timer); }
}
