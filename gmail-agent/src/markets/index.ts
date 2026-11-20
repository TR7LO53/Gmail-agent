/** Contract units: UTC Unix-second candle starts and fetchedAt in milliseconds. H4 buckets are UTC aligned. */
export { createMarketSource } from "./source.js";
export type { MarketSourceOptions } from "./source.js";
export type { MarketSource, Candle, LinePoint, ChangeData, MarketError, MarketResult, MarketSymbol, Timeframe, SeriesMetadata } from "./types.js";
export { MARKET_SYMBOLS, TIMEFRAMES } from "./types.js";
