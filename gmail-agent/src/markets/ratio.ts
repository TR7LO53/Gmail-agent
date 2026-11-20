import type { Candle, LinePoint } from "./types.js";
/** Join exact timestamps only, divide closes, and never interpolate missing points. */
export function buildGoldSilverRatio(gold: readonly Candle[], silver: readonly Candle[]): LinePoint[] {
  const byTime = new Map(silver.map(c => [c.timestamp, c]));
  return gold.flatMap(g => {
    const s = byTime.get(g.timestamp);
    if (!s || !Number.isFinite(g.close) || !Number.isFinite(s.close) || s.close === 0) return [];
    return [{ timestamp: g.timestamp, value: g.close / s.close, isLive: g.isLive || s.isLive }];
  }).sort((a, b) => a.timestamp - b.timestamp);
}
