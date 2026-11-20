import type { HoldingsSnapshot } from "../memory/holdings.js";

/** Candles must be keyed by their shared Timeframe period; closeAt is the valuation instant. */
export interface ClosingPoint {
  periodKey: string;
  closeAt: string;
  close: number | null;
}
export interface StrategyPremiumPoint {
  periodKey: string;
  closeAt: string;
  value: number;
}

function validMoment(value: string): number { const time = Date.parse(value); return time; }

/** Returns a fractional premium (0.5 means 50%) for shared closing periods only. */
export function calculateStrategyPremium(
  mstr: readonly ClosingPoint[],
  btc: readonly ClosingPoint[],
  snapshots: readonly HoldingsSnapshot[],
): StrategyPremiumPoint[] {
  const btcByPeriod = new Map<string, ClosingPoint>();
  for (const point of btc) btcByPeriod.set(point.periodKey, point);
  const orderedSnapshots = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const orderedMstr = [...mstr].sort((a, b) => validMoment(a.closeAt) - validMoment(b.closeAt));
  const result: StrategyPremiumPoint[] = [];
  let snapshotIndex = 0;
  let active: HoldingsSnapshot | undefined;
  for (const stock of orderedMstr) {
    const crypto = btcByPeriod.get(stock.periodKey);
    const closeTime = validMoment(stock.closeAt);
    // periodKey defines the shared candle; BTC and stock feeds may stamp that candle's close differently.
    if (!crypto || !Number.isFinite(closeTime) || !Number.isFinite(validMoment(crypto.closeAt))) continue;
    while (snapshotIndex < orderedSnapshots.length && Date.parse(`${orderedSnapshots[snapshotIndex].date}T00:00:00.000Z`) <= closeTime) active = orderedSnapshots[snapshotIndex++];
    if (!active || !Number.isFinite(stock.close) || stock.close! <= 0 || !Number.isFinite(crypto.close) || crypto.close! <= 0) continue;
    const value = (stock.close! * active.shares_outstanding) / (active.btc_held * crypto.close!) - 1;
    if (Number.isFinite(value)) result.push({ periodKey: stock.periodKey, closeAt: stock.closeAt, value });
  }
  return result;
}
