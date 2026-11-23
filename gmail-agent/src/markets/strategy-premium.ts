import type { HoldingsSnapshot } from "../memory/holdings.js";
import type { Candle, LinePoint, Timeframe } from "./types.js";

const PERIOD_SECONDS: Record<Timeframe, number> = {
  H1: 3600,
  H4: 4 * 3600,
  D1: 86_400,
  W1: 7 * 86_400,
  MN: 31 * 86_400,
};

function utcDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Strategy Premium as a line, in PERCENT: `50` means MSTR is worth 50% more than the bitcoin it
 * holds, `-25` means 25% less. A change between two points is then a plain subtraction, in
 * percentage points.
 *
 *   premium = ((MSTR close × shares) / (BTC held × BTC close) − 1) × 100
 *
 * - One point per MSTR candle; BTC trades on weekends, MSTR does not, so weekend BTC candles
 *   create no points.
 * - Candle start times differ between the two (D1: MSTR opens ~14:30 UTC, BTC at 00:00 UTC; H1: :30
 *   vs :00), so the BTC candle is the latest one starting at or before the MSTR candle and less than
 *   one period earlier. No such candle → no point.
 * - The Snapshot in effect is the latest one dated on or before the UTC day of the MSTR candle's
 *   START (the same rule as `getHoldingsSnapshotAt`). Candles before the first Snapshot give no point.
 * - A price at or below zero, or a non-finite result, gives no point. Inputs are not modified.
 */
export function strategyPremiumLine(
  mstr: readonly Candle[],
  btc: readonly Candle[],
  snapshots: readonly HoldingsSnapshot[],
  timeframe: Timeframe,
): LinePoint[] {
  const period = PERIOD_SECONDS[timeframe];
  const mstrSorted = [...mstr].sort((a, b) => a.time - b.time);
  const btcSorted = [...btc].sort((a, b) => a.time - b.time);
  const snapshotsSorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

  const points: LinePoint[] = [];
  let btcIndex = -1; // latest BTC candle starting at or before the current MSTR candle
  let snapshotIndex = -1; // latest Snapshot dated on or before the current MSTR candle's UTC day

  for (const stock of mstrSorted) {
    while (btcIndex + 1 < btcSorted.length && btcSorted[btcIndex + 1].time <= stock.time) btcIndex += 1;
    const day = utcDay(stock.time);
    while (
      snapshotIndex + 1 < snapshotsSorted.length &&
      snapshotsSorted[snapshotIndex + 1].date <= day
    ) {
      snapshotIndex += 1;
    }

    if (btcIndex < 0 || snapshotIndex < 0) continue;
    const coin = btcSorted[btcIndex];
    if (stock.time - coin.time >= period) continue;
    const snapshot = snapshotsSorted[snapshotIndex];
    if (stock.close <= 0 || coin.close <= 0) continue;

    const value =
      ((stock.close * snapshot.shares_outstanding) / (snapshot.btc_held * coin.close) - 1) * 100;
    if (!Number.isFinite(value)) continue;
    points.push({ time: stock.time, value, isLive: stock.isLive || coin.isLive });
  }
  return points;
}
