import type { DB } from "../memory/db.js";
import { logEvent } from "../memory/logs.js";
import { calculateChange } from "./change.js";
import { aggregateH1ToH4, markLive } from "./timeframes.js";
import { buildGoldSilverRatio } from "./ratio.js";
import type { ChangeData, MarketError, MarketResult, MarketSource, MarketSymbol, SeriesMetadata, Timeframe, LinePoint } from "./types.js";
import { fetchYahooChart, YahooError, type YahooFetch } from "./yahoo.js";
export interface MarketSourceOptions { db: DB; fetch?: YahooFetch; now?: () => number; ttlMs?: number; timeoutMs?: number }
interface Cached { candles: import("./types.js").Candle[]; metadata: SeriesMetadata; expiresAt: number }
const defaultFetch: YahooFetch = (url, init) => fetch(url, init) as unknown as ReturnType<YahooFetch>;
const clone = <T>(value: T): T => structuredClone(value);
/** Per-instance cache lasts 270s after a successful fetch. No background work is started. */
export function createMarketSource(options: MarketSourceOptions): MarketSource {
  const fetcher = options.fetch ?? defaultFetch;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 270_000;
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Cached>>();
  const currentSnapshot = (value: Cached, timeframe: Timeframe): Cached => ({
    ...clone(value),
    candles: markLive(value.candles, timeframe, now(), value.metadata.exchangeTimezone),
  });
  async function load(symbol: MarketSymbol, timeframe: Timeframe): Promise<MarketResult<Cached>> {
    const key = symbol + ":" + timeframe;
    const hit = cache.get(key);
    if (hit && now() < hit.expiresAt) {
      const snapshot = currentSnapshot(hit, timeframe);
      return { ok: true, data: snapshot, metadata: clone(snapshot.metadata) };
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const chart = timeframe === "H4"
            ? await load(symbol, "H1").then(result => {
              if (!result.ok) throw new YahooError(result.error.code, result.error.message, result.error.httpStatus);
              return { candles: result.data.candles, exchangeTimezone: result.data.metadata.exchangeTimezone, currency: result.data.metadata.currency };
            })
            : await fetchYahooChart(symbol, timeframe, fetcher, options.timeoutMs);
          const fetchedAt = now();
          const raw = timeframe === "H4" ? aggregateH1ToH4(chart.candles) : chart.candles;
          const candles = markLive(raw, timeframe, fetchedAt, chart.exchangeTimezone);
          const metadata: SeriesMetadata = { symbol, timeframe, fetchedAt, exchangeTimezone: chart.exchangeTimezone, currency: chart.currency };
          const value = { candles, metadata, expiresAt: fetchedAt + ttl };
          cache.set(key, value);
          return value;
        } catch (cause) {
          const err = cause instanceof YahooError ? cause : new YahooError("network", cause instanceof Error ? cause.message : "Yahoo request failed");
          try {
            logEvent(options.db, { source: "markets", level: "error", message: symbol + " " + timeframe + ": " + err.message,
              data: { symbol, timeframe, category: err.code, ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }) } });
          } catch { /* Logging failure must not change market-data results. */ }
          throw err;
        } finally { inflight.delete(key); }
      })();
      inflight.set(key, pending);
    }
    try {
      const value = await pending;
      const snapshot = currentSnapshot(value, timeframe);
      return { ok: true, data: snapshot, metadata: clone(snapshot.metadata) };
    } catch (cause) {
      const err = cause instanceof YahooError ? cause : new YahooError("network", "Yahoo request failed");
      const error: MarketError = { symbol, timeframe, code: err.code, message: err.message, ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }) };
      return { ok: false, error };
    }
  }
  return {
    async getCandles(symbol, timeframe) {
      const result = await load(symbol, timeframe);
      return result.ok ? { ok: true, data: clone(result.data.candles), metadata: result.metadata } : result;
    },
    async getCandlesMany(symbols, timeframe) {
      const entries = await Promise.all(symbols.map(async symbol => [symbol, await this.getCandles(symbol, timeframe)] as const));
      return Object.fromEntries(entries);
    },
    async getChange(symbol): Promise<MarketResult<ChangeData>> {
      const result = await load(symbol, "D1");
      if (!result.ok) return result;
      const value = calculateChange(symbol, result.data.candles, result.data.metadata.exchangeTimezone);
      if (!value) return { ok: false, error: { symbol, timeframe: "D1", code: "no-data", message: "No daily candles available" } };
      return { ok: true, data: value, metadata: result.metadata };
    },
    async getGoldSilverRatio(timeframe): Promise<MarketResult<LinePoint[]>> {
      const [gold, silver] = await Promise.all([this.getCandles("GC=F", timeframe), this.getCandles("SI=F", timeframe)]);
      if (!gold.ok) return gold;
      if (!silver.ok) return silver;
      const data = buildGoldSilverRatio(gold.data, silver.data);
      if (!data.length) return { ok: false, error: { symbol: "GC=F", timeframe, code: "no-data", message: "Gold and silver have no aligned candle closes" } };
      return { ok: true, data, metadata: gold.metadata };
    },
  };
}
