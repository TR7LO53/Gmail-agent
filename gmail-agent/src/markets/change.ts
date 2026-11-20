import type { Candle, ChangeData, MarketSymbol } from "./types.js";
export function calculateChange(symbol: MarketSymbol, candles: readonly Candle[], timezone: string): ChangeData | null {
  if (!candles.length) return null;
  const current = candles[candles.length - 1];
  const previous = candles.length > 1 ? candles[candles.length - 2] : null;
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(current.timestamp * 1000)).map(p => [p.type, p.value]));
  const previousClose = previous?.close ?? null;
  const change = previousClose === null ? null : current.close - previousClose;
  return { symbol, price: current.close, previousClose, change,
    changePercent: previousClose === null || previousClose === 0 ? null : (change! / previousClose) * 100,
    referenceDate: fields.year + "-" + fields.month + "-" + fields.day, weekday: fields.weekday };
}
