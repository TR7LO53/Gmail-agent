/** Supported Yahoo instruments. Timestamps are Unix seconds in UTC; fetchedAt is Unix milliseconds. */
export const MARKET_SYMBOLS = ["BTC-USD", "MSTR", "CCJ", "GC=F", "SI=F"] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];
export const TIMEFRAMES = ["H1", "H4", "D1", "W1", "MN"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export interface Candle { timestamp: number; open: number; high: number; low: number; close: number; isLive: boolean }
export interface LinePoint { timestamp: number; value: number; isLive: boolean }
export interface SeriesMetadata { symbol: MarketSymbol; timeframe: Timeframe; fetchedAt: number; exchangeTimezone: string; currency: string | null }
export type MarketErrorCode = "http" | "timeout" | "network" | "invalid-json" | "yahoo" | "no-data" | "unsupported";
export interface MarketError { symbol: MarketSymbol; timeframe: Timeframe; code: MarketErrorCode; message: string; httpStatus?: number }
export type MarketResult<T> = { ok: true; data: T; metadata: SeriesMetadata } | { ok: false; error: MarketError };
export interface ChangeData { symbol: MarketSymbol; price: number; previousClose: number | null; change: number | null; changePercent: number | null; referenceDate: string; weekday: string }
/** Yahoo JSON and URLs stay behind this interface; values use UTC Unix seconds. */
export interface MarketSource {
  getCandles(symbol: MarketSymbol, timeframe: Timeframe): Promise<MarketResult<Candle[]>>;
  getCandlesMany(symbols: readonly MarketSymbol[], timeframe: Timeframe): Promise<Partial<Record<MarketSymbol, MarketResult<Candle[]>>>>;
  getChange(symbol: MarketSymbol): Promise<MarketResult<ChangeData>>;
  getGoldSilverRatio(timeframe: Timeframe): Promise<MarketResult<LinePoint[]>>;
}
