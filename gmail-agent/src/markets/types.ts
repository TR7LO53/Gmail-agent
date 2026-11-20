export const INSTRUMENTS = ["BTC-USD", "MSTR", "CCJ", "GC=F", "SI=F"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const TIMEFRAMES = ["H1", "H4", "D1", "W1", "MN"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Candle {
  /** Unix seconds, UTC. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isLive: boolean;
}

export interface CandleSeries {
  symbol: Instrument;
  timeframe: Timeframe;
  candles: Candle[];
  /** Unix milliseconds, UTC. */
  fetchedAt: number;
}

export interface Quote {
  symbol: Instrument;
  current: number | null;
  currentTime: number | null;
  previousClose: number | null;
  previousCloseTime: number | null;
  change: number | null;
  changePercent: number | null;
  observationWeekday: string | null;
  fetchedAt: number;
  unavailableReason?: string;
}

export interface LinePoint {
  /** Unix seconds, UTC. */
  time: number;
  value: number;
  isLive: boolean;
}

export interface LineSeries {
  name: "gold-silver-ratio";
  timeframe: Timeframe;
  points: LinePoint[];
  fetchedAt: number;
}

export type MarketErrorCategory = "http" | "timeout" | "yahoo" | "protocol" | "transport";
export interface MarketError {
  symbol: Instrument | "GC=F/SI=F";
  operation: string;
  category: MarketErrorCategory;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: MarketError };

export interface PriceSource {
  getCandles(symbol: Instrument, timeframe: Timeframe): Promise<Result<CandleSeries>>;
  getQuote(symbol: Instrument): Promise<Result<Quote>>;
  getMany(symbols: readonly Instrument[], timeframe: Timeframe): Promise<Record<Instrument, Result<CandleSeries> | undefined>>;
  getGoldSilverRatio(timeframe: Timeframe): Promise<Result<LineSeries>>;
}

export type MarketLogger = (error: MarketError) => void | Promise<void>;
