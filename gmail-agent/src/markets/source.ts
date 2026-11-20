import { INSTRUMENTS, type Candle, type CandleSeries, type Instrument, type LineSeries, type MarketError, type MarketLogger, type PriceSource, type Quote, type Result, type Timeframe } from "./types.js";
import { aggregateH1ToH4, alignRatio, markLiveCandles, quoteFromDailyCandles } from "./series.js";
import { fetchYahooChart, type FetchImpl, type YahooChart, YahooError } from "./yahoo.js";

const DEFAULT_TTL_MS = 270_000;
interface CachedChart extends YahooChart { fetchedAt: number; expiresAt: number }
export interface MarketSourceOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  ttlMs?: number;
  logger: MarketLogger;
}

function rawTimeframe(timeframe: Timeframe): Timeframe { return timeframe === "H4" ? "H1" : timeframe; }
function cloneCandles(candles: readonly Candle[]): Candle[] { return candles.map((candle) => ({ ...candle })); }

export function createPriceSource(options: MarketSourceOptions): PriceSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CachedChart>();
  const pending = new Map<string, Promise<Result<CachedChart>>>();

  async function report(error: MarketError): Promise<void> {
    try { await options.logger(error); } catch { /* Logging trouble must not fan out into market results. */ }
  }

  async function load(symbol: Instrument, timeframe: Timeframe): Promise<Result<CachedChart>> {
    const upstream = rawTimeframe(timeframe);
    const key = `${symbol}:${upstream}`;
    const hit = cache.get(key);
    if (hit && now() < hit.expiresAt) return { ok: true, value: hit };
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const request = (async (): Promise<Result<CachedChart>> => {
      try {
        const chart = await fetchYahooChart(fetchImpl, symbol, upstream);
        const fetchedAt = now();
        const value = { ...chart, candles: cloneCandles(chart.candles), fetchedAt, expiresAt: fetchedAt + ttlMs };
        cache.set(key, value);
        return { ok: true, value };
      } catch (cause) {
        const detail = cause instanceof YahooError
          ? { category: cause.category, message: cause.message }
          : { category: "transport" as const, message: "Market data request failed." };
        const error: MarketError = { symbol, operation: timeframe, ...detail };
        await report(error);
        return { ok: false, error };
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  }

  async function getCandles(symbol: Instrument, timeframe: Timeframe): Promise<Result<CandleSeries>> {
    const loaded = await load(symbol, timeframe);
    if (!loaded.ok) return loaded;
    const { value } = loaded;
    const raw = cloneCandles(value.candles);
    const prepared = timeframe === "H4" ? aggregateH1ToH4(raw) : raw;
    const candles = markLiveCandles(prepared, timeframe, now(), value.metadata, symbol === "BTC-USD");
    return { ok: true, value: { symbol, timeframe, candles, fetchedAt: value.fetchedAt } };
  }

  async function getQuote(symbol: Instrument): Promise<Result<Quote>> {
    const loaded = await load(symbol, "D1");
    if (!loaded.ok) return loaded;
    const quote = quoteFromDailyCandles(symbol, loaded.value.candles, loaded.value.fetchedAt, loaded.value.metadata.exchangeTimezoneName);
    return { ok: true, value: quote };
  }

  async function getMany(symbols: readonly Instrument[] = INSTRUMENTS, timeframe: Timeframe = "D1") {
    const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await getCandles(symbol, timeframe)] as const));
    return Object.fromEntries(entries) as Record<Instrument, Result<CandleSeries> | undefined>;
  }

  async function getGoldSilverRatio(timeframe: Timeframe): Promise<Result<LineSeries>> {
    const [gold, silver] = await Promise.all([getCandles("GC=F", timeframe), getCandles("SI=F", timeframe)]);
    if (!gold.ok || !silver.ok) {
      const reason = !gold.ok ? gold.error : !silver.ok ? silver.error : undefined;
      return { ok: false, error: {
        symbol: "GC=F/SI=F", operation: `ratio:${timeframe}`, category: reason?.category ?? "transport",
        message: `Gold/Silver Ratio unavailable because ${reason?.symbol ?? "an input"} failed: ${reason?.message ?? "unknown error"}`,
      } };
    }
    const points = alignRatio(gold.value.candles, silver.value.candles);
    return { ok: true, value: {
      name: "gold-silver-ratio", timeframe, points,
      fetchedAt: Math.min(gold.value.fetchedAt, silver.value.fetchedAt),
    } };
  }

  return { getCandles, getQuote, getMany, getGoldSilverRatio };
}
