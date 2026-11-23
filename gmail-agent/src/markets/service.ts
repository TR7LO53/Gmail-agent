import type { DB } from "../memory/db.js";
import {
  STALE_AFTER_DAYS,
  getLatestHoldingsSnapshot,
  getPendingHoldingsWarning,
  isHoldingsStale,
  isRealDate,
  listHoldingsSnapshots,
  saveHoldingsSnapshot,
  type HoldingsSnapshot,
  type HoldingsWarning,
} from "../memory/holdings.js";
import { localDateKey } from "./series.js";
import { strategyPremiumLine } from "./strategy-premium.js";
import {
  TIMEFRAMES,
  type Candle,
  type Instrument,
  type LinePoint,
  type MarketError,
  type MarketErrorCategory,
  type PriceSource,
  type Quote,
  type Result,
  type Timeframe,
} from "./types.js";

/** Times in every response are Unix seconds (UTC); the UI shows them in this zone. */
export const DISPLAY_TIME_ZONE = "Europe/Warsaw";

export interface MarketsDeps {
  priceSource: PriceSource;
  /** Runs the automatic holdings check (the SEC reader in the app). Its own 6 h throttle applies. */
  refreshHoldings: () => Promise<unknown>;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

export const WATCHLIST = [
  { id: "BTC-USD", label: "Bitcoin", kind: "candles", unit: "USD", changeUnit: "USD" },
  { id: "MSTR", label: "Strategy (MSTR)", kind: "candles", unit: "USD", changeUnit: "USD" },
  { id: "CCJ", label: "Cameco (CCJ)", kind: "candles", unit: "USD", changeUnit: "USD" },
  { id: "gold-silver-ratio", label: "Gold/Silver Ratio", kind: "line", unit: "ratio", changeUnit: "ratio" },
  { id: "strategy-premium", label: "Strategy Premium", kind: "line", unit: "%", changeUnit: "pp" },
] as const;

export type WatchlistItem = (typeof WATCHLIST)[number];
export type WatchlistEntryId = WatchlistItem["id"];

export function isWatchlistEntryId(value: unknown): value is WatchlistEntryId {
  return WATCHLIST.some((item) => item.id === value);
}

export function isTimeframe(value: unknown): value is Timeframe {
  return (TIMEFRAMES as readonly unknown[]).includes(value);
}

export interface MarketsErrorInfo {
  category: MarketErrorCategory;
  message: string;
  /** The inputs that failed; for a Derived Series these are its source Instruments. */
  failedInputs: string[];
}

export interface WatchlistEntry {
  id: WatchlistEntryId;
  label: string;
  kind: "candles" | "line";
  unit: string;
  ok: boolean;
  stale: boolean;
  value: number | null;
  valueTime: number | null;
  change: number | null;
  changePercent: number | null;
  changeUnit: string;
  dayLabel: string | null;
  error: MarketsErrorInfo | null;
  lastSuccessAt: string | null;
}

export interface WatchlistResponse {
  displayTimeZone: string;
  entries: WatchlistEntry[];
}

export interface SeriesResponse {
  entry: WatchlistEntryId;
  timeframe: Timeframe;
  kind: "candles" | "line";
  displayTimeZone: string;
  ok: boolean;
  stale: boolean;
  candles?: Candle[];
  points?: LinePoint[];
  hasLiveCandle: boolean;
  fetchedAt: string | null;
  error: MarketsErrorInfo | null;
  lastSuccessAt: string | null;
}

type Metrics = Pick<WatchlistEntry, "value" | "valueTime" | "change" | "changePercent" | "dayLabel">;
type Outcome = { ok: true; metrics: Metrics } | { ok: false; error: MarketsErrorInfo };

function errorInfo(error: MarketError, failedInputs: string[]): MarketsErrorInfo {
  return { category: error.category, message: error.message, failedInputs };
}

/** An error for a series built from several inputs: the first failure speaks, all failures are listed. */
function inputsFailed(inputs: ReadonlyArray<readonly [string, Result<unknown>]>, first?: MarketError): MarketsErrorInfo | null {
  const failed = inputs.flatMap(([name, result]) => (result.ok ? [] : [{ name, error: result.error }]));
  if (failed.length === 0) return null;
  return errorInfo(first ?? failed[0].error, failed.map((item) => item.name));
}

/** The weekday of the last observation, only when it is not today's day on the exchange. */
function dayLabel(quote: Result<Quote>, nowMs: number): string | null {
  if (!quote.ok) return null;
  const { observationWeekday, currentTime, timeZone } = quote.value;
  if (!observationWeekday || currentTime === null) return null;
  return localDateKey(currentTime, timeZone) === localDateKey(Math.floor(nowMs / 1000), timeZone)
    ? null
    : observationWeekday;
}

function lineMetrics(points: readonly LinePoint[], percent: boolean, label: string | null): Metrics {
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  if (!last) return { value: null, valueTime: null, change: null, changePercent: null, dayLabel: label };
  const change = previous ? last.value - previous.value : null;
  const changePercent = percent && previous && previous.value !== 0 ? (change! / previous.value) * 100 : null;
  return { value: last.value, valueTime: last.time, change, changePercent, dayLabel: label };
}

const EMPTY_METRICS: Metrics = { value: null, valueTime: null, change: null, changePercent: null, dayLabel: null };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createMarketsService(options: { db: DB } & MarketsDeps) {
  const { db, priceSource, refreshHoldings } = options;
  const now = options.now ?? Date.now;
  // In-process memory only: prices are never stored (see the spec), so a restart forgets them.
  const lastGoodEntries = new Map<WatchlistEntryId, { at: number; entry: WatchlistEntry }>();
  const lastGoodSeries = new Map<string, number>();

  async function getWatchlist(): Promise<WatchlistResponse> {
    // Fire and forget: the SEC reader can take many seconds and never throws.
    void Promise.resolve().then(refreshHoldings).catch(() => {});

    // One Promise.all so the source folds every input into a single request per symbol.
    const [btcQ, mstrQ, ccjQ, gcQ, ratio, gcC, siC, mstrC, btcC] = await Promise.all([
      priceSource.getQuote("BTC-USD"),
      priceSource.getQuote("MSTR"),
      priceSource.getQuote("CCJ"),
      priceSource.getQuote("GC=F"),
      priceSource.getGoldSilverRatio("D1"),
      priceSource.getCandles("GC=F", "D1"),
      priceSource.getCandles("SI=F", "D1"),
      priceSource.getCandles("MSTR", "D1"),
      priceSource.getCandles("BTC-USD", "D1"),
    ]);
    const nowMs = now();

    const fromQuote = (symbol: Instrument, quote: Result<Quote>): Outcome => quote.ok
      ? { ok: true, metrics: {
        value: quote.value.current, valueTime: quote.value.currentTime,
        change: quote.value.change, changePercent: quote.value.changePercent,
        dayLabel: dayLabel(quote, nowMs),
      } }
      : { ok: false, error: errorInfo(quote.error, [symbol]) };

    const outcomes: Record<WatchlistEntryId, Outcome> = {
      "BTC-USD": fromQuote("BTC-USD", btcQ),
      MSTR: fromQuote("MSTR", mstrQ),
      CCJ: fromQuote("CCJ", ccjQ),
      "gold-silver-ratio": ratio.ok
        ? { ok: true, metrics: lineMetrics(ratio.value.points, true, dayLabel(gcQ, nowMs)) }
        : { ok: false, error: inputsFailed([["GC=F", gcC], ["SI=F", siC]], ratio.error) ?? errorInfo(ratio.error, []) },
      "strategy-premium": mstrC.ok && btcC.ok
        ? { ok: true, metrics: lineMetrics(
          strategyPremiumLine(mstrC.value.candles, btcC.value.candles, listHoldingsSnapshots(db), "D1"),
          false, dayLabel(mstrQ, nowMs),
        ) }
        : { ok: false, error: inputsFailed([["MSTR", mstrC], ["BTC-USD", btcC]])! },
    };

    const entries = WATCHLIST.map((item): WatchlistEntry => {
      const base = { id: item.id, label: item.label, kind: item.kind, unit: item.unit, changeUnit: item.changeUnit };
      const outcome = outcomes[item.id];
      if (outcome.ok) {
        const entry: WatchlistEntry = {
          ...base, ok: true, stale: false, ...outcome.metrics, error: null, lastSuccessAt: iso(nowMs),
        };
        lastGoodEntries.set(item.id, { at: nowMs, entry });
        return entry;
      }
      const previous = lastGoodEntries.get(item.id);
      return {
        ...base,
        ...(previous
          ? {
            value: previous.entry.value, valueTime: previous.entry.valueTime, change: previous.entry.change,
            changePercent: previous.entry.changePercent, dayLabel: previous.entry.dayLabel,
          }
          : EMPTY_METRICS),
        ok: false, stale: true, error: outcome.error, lastSuccessAt: previous ? iso(previous.at) : null,
      };
    });
    return { displayTimeZone: DISPLAY_TIME_ZONE, entries };
  }

  async function getSeries(entry: WatchlistEntryId, timeframe: Timeframe): Promise<SeriesResponse> {
    const item = WATCHLIST.find((candidate) => candidate.id === entry)!;
    let data: { rows: Candle[] | LinePoint[]; fetchedAt: number } | { error: MarketsErrorInfo };

    if (entry === "gold-silver-ratio") {
      const [ratio, gold, silver] = await Promise.all([
        priceSource.getGoldSilverRatio(timeframe),
        priceSource.getCandles("GC=F", timeframe),
        priceSource.getCandles("SI=F", timeframe),
      ]);
      data = ratio.ok
        ? { rows: ratio.value.points, fetchedAt: ratio.value.fetchedAt }
        : { error: inputsFailed([["GC=F", gold], ["SI=F", silver]], ratio.error) ?? errorInfo(ratio.error, []) };
    } else if (entry === "strategy-premium") {
      const [mstr, btc] = await Promise.all([
        priceSource.getCandles("MSTR", timeframe),
        priceSource.getCandles("BTC-USD", timeframe),
      ]);
      data = mstr.ok && btc.ok
        ? {
          rows: strategyPremiumLine(mstr.value.candles, btc.value.candles, listHoldingsSnapshots(db), timeframe),
          fetchedAt: Math.min(mstr.value.fetchedAt, btc.value.fetchedAt),
        }
        : { error: inputsFailed([["MSTR", mstr], ["BTC-USD", btc]])! };
    } else {
      const series = await priceSource.getCandles(entry, timeframe);
      data = series.ok
        ? { rows: series.value.candles, fetchedAt: series.value.fetchedAt }
        : { error: errorInfo(series.error, [entry]) };
    }

    const key = `${entry}:${timeframe}`;
    const base = { entry, timeframe, kind: item.kind, displayTimeZone: DISPLAY_TIME_ZONE };
    const rowsKey = item.kind === "candles" ? "candles" : "points";
    if ("error" in data) {
      const at = lastGoodSeries.get(key);
      return {
        ...base, ok: false, stale: true, [rowsKey]: [], hasLiveCandle: false, fetchedAt: null,
        error: data.error, lastSuccessAt: at === undefined ? null : iso(at),
      };
    }
    const nowMs = now();
    lastGoodSeries.set(key, nowMs);
    return {
      ...base, ok: true, stale: false, [rowsKey]: data.rows,
      hasLiveCandle: data.rows[data.rows.length - 1]?.isLive === true,
      fetchedAt: iso(data.fetchedAt), error: null, lastSuccessAt: iso(nowMs),
    };
  }

  return { getWatchlist, getSeries };
}

export interface HoldingsResponse {
  latest: HoldingsSnapshot | null;
  stale: boolean;
  staleAfterDays: number;
  warning: HoldingsWarning | null;
}

export function getHoldings(db: DB, nowMs: number): HoldingsResponse {
  return {
    latest: getLatestHoldingsSnapshot(db) ?? null,
    stale: isHoldingsStale(db, new Date(nowMs)),
    staleAfterDays: STALE_AFTER_DAYS,
    warning: getPendingHoldingsWarning(db) ?? null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type ManualHoldingsResult =
  | { ok: true; response: HoldingsResponse & { snapshot: HoldingsSnapshot } }
  | { ok: false; error: string };

/** Validates and saves a manual Snapshot. `saveHoldingsSnapshot` writes the `manual-edit` log itself. */
export function saveManualHoldings(db: DB, nowMs: number, body: unknown): ManualHoldingsResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Expected an object with date, btc_held and shares_outstanding." };
  }
  const { date, btc_held, shares_outstanding } = body as Record<string, unknown>;
  if (typeof date !== "string" || !isRealDate(date)) {
    return { ok: false, error: "date must be a real YYYY-MM-DD date." };
  }
  // A day of slack, so a date that is already "today" east of UTC is accepted.
  if (date > new Date(nowMs + DAY_MS).toISOString().slice(0, 10)) {
    return { ok: false, error: "date must not be in the future." };
  }
  if (typeof btc_held !== "number" || !Number.isFinite(btc_held) || btc_held <= 0) {
    return { ok: false, error: "btc_held must be a positive number." };
  }
  if (typeof shares_outstanding !== "number" || !Number.isSafeInteger(shares_outstanding) || shares_outstanding <= 0) {
    return { ok: false, error: "shares_outstanding must be a positive whole number." };
  }
  const result = saveHoldingsSnapshot(db, { date, btc_held, shares_outstanding, source: "manual" });
  if (result.status !== "saved") return { ok: false, error: "The snapshot was not saved." };
  return { ok: true, response: { snapshot: result.snapshot, ...getHoldings(db, nowMs) } };
}
