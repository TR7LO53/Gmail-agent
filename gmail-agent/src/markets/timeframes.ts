import type { Candle, Timeframe } from "./types.js";
export const YAHOO_INTERVAL: Record<Timeframe, string> = { H1: "1h", H4: "1h", D1: "1d", W1: "1wk", MN: "1mo" };
// Yahoo limits hourly history; use a bounded range instead of range=max.
export const YAHOO_RANGE: Record<Timeframe, string> = { H1: "2y", H4: "2y", D1: "max", W1: "max", MN: "max" };
/** H4 has fixed UTC buckets starting 00:00, 04:00, ...; gaps remain gaps. */
export function aggregateH1ToH4(input: readonly Candle[]): Candle[] {
  const sorted = [...input].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, Candle[]>();
  for (const c of sorted) {
    const start = Math.floor(c.timestamp / 14400) * 14400;
    const bucket = buckets.get(start) ?? [];
    bucket.push(c); buckets.set(start, bucket);
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([timestamp, cs]) => ({
    timestamp, open: cs[0].open, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)),
    close: cs[cs.length - 1].close, isLive: cs.some(c => c.isLive),
  }));
}
/** The newest period is live only while its exchange-local period contains the injected clock. */
export function markLive(candles: readonly Candle[], timeframe: Timeframe, nowMs: number, timezone: string): Candle[] {
  if (!candles.length) return [];
  const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).map(p => [p.type, p.value]));
  const now = parts(new Date(nowMs));
  const last = candles[candles.length - 1];
  const point = parts(new Date(last.timestamp * 1000));
  let live = false;
  if (timeframe === "H1" || timeframe === "H4") {
    const period = timeframe === "H1" ? 3600 : 14400;
    live = last.timestamp <= nowMs / 1000 && last.timestamp + period > nowMs / 1000;
  } else if (timeframe === "D1") {
    live = point.year === now.year && point.month === now.month && point.day === now.day;
  } else if (timeframe === "MN") {
    live = point.year === now.year && point.month === now.month;
  } else {
    const week = (p: Record<string,string>) => {
      const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };
    live = week(point) === week(now);
  }
  return candles.map((c, i) => ({ ...c, isLive: i === candles.length - 1 && live }));
}
