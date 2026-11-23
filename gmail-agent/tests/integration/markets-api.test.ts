import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type DB } from "../../src/memory/db.js";
import { saveHoldingsSnapshot } from "../../src/memory/holdings.js";
import { createMarketsActivityLogger } from "../../src/markets/activity.js";
import { createPriceSource } from "../../src/markets/source.js";
import { WATCHLIST } from "../../src/markets/service.js";
import { TIMEFRAMES, type Instrument } from "../../src/markets/types.js";
import { createApp } from "../../src/ui/app.js";
import { SseBroadcaster } from "../../src/ui/sse.js";

const SATURDAY_NOON = Date.parse("2026-11-21T12:00:00.000Z");
const DAY_SECONDS = 86_400;
const BASE_PRICE: Record<Instrument, number> = { "BTC-USD": 90_000, MSTR: 200, CCJ: 70, "GC=F": 4_000, "SI=F": 50 };

/** A fake Yahoo: stocks and futures trade on weekdays (NY), BTC every day (UTC), as in the real feed. */
function chartResponse(symbol: Instrument, interval: string): Response {
  const crypto = symbol === "BTC-USD";
  const timestamps: number[] = [];
  if (interval === "1d") {
    const first = Date.UTC(2026, 8, 1) / 1000; // Tue 2026-09-01
    const lastDay = Date.UTC(2026, 10, crypto ? 21 : 20) / 1000; // BTC to Sat, others to Fri
    for (let day = first; day <= lastDay; day += DAY_SECONDS) {
      const weekday = new Date(day * 1000).getUTCDay();
      if (crypto) timestamps.push(day);
      else if (weekday >= 1 && weekday <= 5) timestamps.push(day + 14.5 * 3600);
    }
  } else {
    const first = Date.UTC(2026, 10, 14) / 1000; // Sat 2026-11-14 00:00
    const last = crypto ? SATURDAY_NOON / 1000 : Date.UTC(2026, 10, 20, 20, 30) / 1000;
    for (let time = first + (crypto ? 0 : 1800); time <= last; time += 3600) timestamps.push(time);
  }
  const close = timestamps.map((_, index) => BASE_PRICE[symbol] + index * BASE_PRICE[symbol] * 0.001);
  return new Response(JSON.stringify({ chart: { error: null, result: [{
    timestamp: timestamps,
    indicators: { quote: [{
      open: close.map((value) => value - 1), high: close.map((value) => value + 2),
      low: close.map((value) => value - 2), close,
    }] },
    meta: { exchangeTimezoneName: crypto ? "UTC" : "America/New_York", dataGranularity: interval },
  }] } }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Markets API", () => {
  let db: DB;
  let server: Server | undefined;
  let base: string;
  let clock: number;
  let down: Set<string>;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let refreshHoldings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = openDb(":memory:");
    clock = SATURDAY_NOON;
    down = new Set();
    fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const symbol = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (!(symbol in BASE_PRICE)) return new Response("", { status: 404 });
      if (down.has(symbol)) return new Response("", { status: 503 });
      return chartResponse(symbol as Instrument, url.searchParams.get("interval") ?? "");
    });
    refreshHoldings = vi.fn(async () => ({ status: "throttled" }));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  async function start(withMarkets = true) {
    const priceSource = createPriceSource({
      fetchImpl, now: () => clock, logger: createMarketsActivityLogger(db),
    });
    const markets = withMarkets ? { priceSource, refreshHoldings, now: () => clock } : undefined;
    server = createApp({ db, broadcaster: new SseBroadcaster(), markets }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function json(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: await response.json() as any };
  }

  const entryOf = (body: any, id: string) => body.entries.find((entry: any) => entry.id === id);
  const intervals = () => fetchImpl.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("interval"));
  const marketsLogs = () => db.prepare("SELECT level, message FROM logs WHERE source = 'markets'").all() as { level: string; message: string }[];
  const manualEditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM logs WHERE source = 'manual-edit'").get() as { n: number }).n;
  const snapshotCount = () => (db.prepare("SELECT COUNT(*) AS n FROM holdings_snapshots").get() as { n: number }).n;

  describe("watchlist", () => {
    it("lists the five entries in order with values, changes and day labels", async () => {
      await start();
      const { response, body } = await json("/api/markets/watchlist");
      expect(response.status).toBe(200);
      expect(body.displayTimeZone).toBe("Europe/Warsaw");
      expect(body.entries.map((entry: any) => [entry.id, entry.label, entry.kind, entry.unit, entry.changeUnit])).toEqual(
        WATCHLIST.map((item) => [item.id, item.label, item.kind, item.unit, item.changeUnit]),
      );
      for (const entry of body.entries) {
        expect(entry).toMatchObject({ ok: true, stale: false, error: null });
        expect(typeof entry.value).toBe("number");
        expect(typeof entry.valueTime).toBe("number");
        expect(typeof entry.change).toBe("number");
        expect(entry.lastSuccessAt).toBe(new Date(SATURDAY_NOON).toISOString());
      }
      expect(entryOf(body, "strategy-premium")).toMatchObject({ changeUnit: "pp", changePercent: null });
      expect(typeof entryOf(body, "MSTR").changePercent).toBe("number");
      expect(entryOf(body, "MSTR").dayLabel).toBe("Fri");
      expect(entryOf(body, "strategy-premium").dayLabel).toBe("Fri");
      expect(entryOf(body, "gold-silver-ratio").dayLabel).toBe("Fri");
      expect(entryOf(body, "BTC-USD").dayLabel).toBeNull();
      expect(refreshHoldings).toHaveBeenCalledTimes(1);
    });

    it("asks Yahoo once per symbol for daily bars", async () => {
      await start();
      await json("/api/markets/watchlist");
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(intervals().every((interval) => interval === "1d")).toBe(true);
    });

    it("reports one failing symbol without hurting the others, and logs it", async () => {
      down.add("CCJ");
      await start();
      const { body } = await json("/api/markets/watchlist");
      expect(entryOf(body, "CCJ")).toMatchObject({ ok: false, stale: true });
      expect(entryOf(body, "CCJ").error.message).toBeTruthy();
      for (const id of ["BTC-USD", "MSTR", "gold-silver-ratio", "strategy-premium"]) expect(entryOf(body, id).ok).toBe(true);
      const logs = marketsLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ level: "error" });
      expect(logs[0].message).toContain("CCJ");
    });

    it("marks a Derived Series stale together with a failed input", async () => {
      await start();
      down.add("MSTR");
      let { body } = await json("/api/markets/watchlist");
      expect(entryOf(body, "MSTR").ok).toBe(false);
      expect(entryOf(body, "strategy-premium")).toMatchObject({ ok: false, stale: true });
      expect(entryOf(body, "strategy-premium").error.failedInputs).toContain("MSTR");
      expect(entryOf(body, "gold-silver-ratio").ok).toBe(true);

      clock += 600_000;
      down.clear(); down.add("BTC-USD");
      ({ body } = await json("/api/markets/watchlist"));
      expect(entryOf(body, "strategy-premium")).toMatchObject({ ok: false, stale: true });
      expect(entryOf(body, "strategy-premium").error.failedInputs).toEqual(["BTC-USD"]);

      clock += 600_000;
      down.clear(); down.add("SI=F");
      ({ body } = await json("/api/markets/watchlist"));
      expect(entryOf(body, "gold-silver-ratio")).toMatchObject({ ok: false, stale: true });
      expect(entryOf(body, "gold-silver-ratio").error.failedInputs).toEqual(["SI=F"]);
      for (const id of ["BTC-USD", "MSTR", "CCJ", "strategy-premium"]) expect(entryOf(body, id).ok).toBe(true);
    });

    it("keeps the last good value and its time when a later request fails", async () => {
      await start();
      const first = (await json("/api/markets/watchlist")).body;
      clock += 600_000; // past the cache TTL
      down.add("CCJ");
      const { body } = await json("/api/markets/watchlist");
      const ccj = entryOf(body, "CCJ");
      expect(ccj).toMatchObject({ ok: false, stale: true, value: entryOf(first, "CCJ").value, change: entryOf(first, "CCJ").change });
      expect(ccj.lastSuccessAt).toBe(new Date(SATURDAY_NOON).toISOString());
      expect(entryOf(body, "MSTR").lastSuccessAt).toBe(new Date(clock).toISOString());
    });

    it("shows no value and no success time for an entry that never loaded", async () => {
      down.add("CCJ");
      await start();
      const ccj = entryOf((await json("/api/markets/watchlist")).body, "CCJ");
      expect(ccj).toMatchObject({ ok: false, stale: true, value: null, change: null, lastSuccessAt: null });
    });
  });

  describe("series", () => {
    it.each(TIMEFRAMES)("returns candles for an Instrument at %s", async (tf) => {
      await start();
      const { response, body } = await json(`/api/markets/series?entry=MSTR&tf=${tf}`);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ entry: "MSTR", timeframe: tf, kind: "candles", displayTimeZone: "Europe/Warsaw", ok: true, stale: false, error: null });
      expect(body.candles.length).toBeGreaterThan(0);
      const times = body.candles.map((candle: any) => candle.time);
      expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
      expect(body.candles.every((candle: any) => typeof candle.isLive === "boolean")).toBe(true);
      expect(body.candles.slice(0, -1).some((candle: any) => candle.isLive)).toBe(false);
      expect(body.hasLiveCandle).toBe(body.candles[body.candles.length - 1].isLive);
      expect(new Set(intervals())).toEqual(new Set([tf === "H1" || tf === "H4" ? "1h" : "1d"]));
    });

    it.each(TIMEFRAMES)("marks the Live Candle of BTC at %s", async (tf) => {
      await start();
      const { body } = await json(`/api/markets/series?entry=BTC-USD&tf=${tf}`);
      expect(body.hasLiveCandle).toBe(true);
      expect(body.candles[body.candles.length - 1].isLive).toBe(true);
    });

    it.each(TIMEFRAMES)("returns line points for both Derived Series at %s", async (tf) => {
      await start();
      for (const entry of ["gold-silver-ratio", "strategy-premium"]) {
        const { response, body } = await json(`/api/markets/series?entry=${entry}&tf=${tf}`);
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ entry, timeframe: tf, kind: "line", ok: true, stale: false, error: null });
        expect(body.candles).toBeUndefined();
        expect(body.points.length).toBeGreaterThan(0);
        const times = body.points.map((point: any) => point.time);
        expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
        expect(body.points.every((point: any) => Number.isFinite(point.value) && typeof point.isLive === "boolean")).toBe(true);
        expect(body.points.slice(0, -1).some((point: any) => point.isLive)).toBe(false);
        expect(body.hasLiveCandle).toBe(body.points[body.points.length - 1].isLive);
      }
      expect(new Set(intervals())).toEqual(new Set([tf === "H1" || tf === "H4" ? "1h" : "1d"]));
    });

    it.each([
      ["no entry", "?tf=D1"],
      ["no tf", "?entry=MSTR"],
      ["an input-only symbol", "?entry=GC=F&tf=D1"],
      ["an unknown entry", "?entry=foo&tf=D1"],
      ["an unknown timeframe", "?entry=MSTR&tf=M5"],
      ["a lower-case timeframe", "?entry=MSTR&tf=h1"],
    ])("rejects %s with 400", async (_name, query) => {
      await start();
      const { response, body } = await json(`/api/markets/series${query}`);
      expect(response.status).toBe(400);
      expect(typeof body.error).toBe("string");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("answers 200 with ok:false and empty data when the source fails", async () => {
      down.add("CCJ"); down.add("MSTR");
      await start();
      const ccj = (await json("/api/markets/series?entry=CCJ&tf=D1")).body;
      expect(ccj).toMatchObject({ ok: false, stale: true, candles: [], hasLiveCandle: false, lastSuccessAt: null });
      expect(ccj.error.message).toBeTruthy();
      const premium = (await json("/api/markets/series?entry=strategy-premium&tf=D1")).body;
      expect(premium).toMatchObject({ ok: false, stale: true, points: [] });
      expect(premium.error.failedInputs).toContain("MSTR");
    });

    it("remembers when a series last loaded", async () => {
      await start();
      await json("/api/markets/series?entry=CCJ&tf=D1");
      clock += 600_000;
      down.add("CCJ");
      const { body } = await json("/api/markets/series?entry=CCJ&tf=D1");
      expect(body).toMatchObject({ ok: false, stale: true, lastSuccessAt: new Date(SATURDAY_NOON).toISOString() });
    });
  });

  it("answers 503 for prices when markets are not configured, while holdings still work", async () => {
    await start(false);
    expect((await json("/api/markets/watchlist")).response.status).toBe(503);
    expect((await json("/api/markets/series?entry=MSTR&tf=D1")).response.status).toBe(503);
    const holdings = await json("/api/markets/holdings");
    expect(holdings.response.status).toBe(200);
    expect(holdings.body.latest.date).toBe("2026-11-15");
  });

  describe("holdings", () => {
    it("returns the latest Snapshot and whether it is stale", async () => {
      await start();
      const fresh = (await json("/api/markets/holdings")).body;
      expect(fresh.latest).toMatchObject({ date: "2026-11-15", source: "automatic" });
      expect(fresh).toMatchObject({ stale: false, staleAfterDays: 14, warning: null });
      clock = Date.parse("2026-12-15T12:00:00.000Z");
      expect((await json("/api/markets/holdings")).body.stale).toBe(true);
    });

    it("shows the pending warning from a rejected automatic reading", async () => {
      await start();
      const result = saveHoldingsSnapshot(db, { date: "2026-11-16", btc_held: 1, shares_outstanding: 1000, source: "automatic" });
      expect(result.status).toBe("rejected");
      expect((await json("/api/markets/holdings")).body.warning).toMatchObject({ reason: "btc_decreased", date: "2026-11-16" });
    });

    it("saves a manual Snapshot, ignores a posted source, and logs exactly once", async () => {
      await start();
      const before = manualEditCount();
      const { response, body } = await json("/api/markets/holdings", "POST", {
        date: "2026-11-20", btc_held: 851_000, shares_outstanding: 300_000_000, source: "automatic",
      });
      expect(response.status).toBe(201);
      expect(body.snapshot).toMatchObject({ date: "2026-11-20", btc_held: 851_000, shares_outstanding: 300_000_000, source: "manual" });
      expect(body).toMatchObject({ stale: false, warning: null });
      expect((await json("/api/markets/holdings")).body.latest).toMatchObject({ date: "2026-11-20", source: "manual" });
      expect(manualEditCount()).toBe(before + 1);
    });

    it("accepts tomorrow's date but not a week ahead", async () => {
      await start();
      const tomorrow = await json("/api/markets/holdings", "POST", { date: "2026-11-22", btc_held: 851_000, shares_outstanding: 300_000_000 });
      expect(tomorrow.response.status).toBe(201);
      const nextWeek = await json("/api/markets/holdings", "POST", { date: "2026-11-28", btc_held: 851_000, shares_outstanding: 300_000_000 });
      expect(nextWeek.response.status).toBe(400);
    });

    const valid = { date: "2026-11-20", btc_held: 851_000, shares_outstanding: 300_000_000 };
    it.each([
      ["a missing body", undefined],
      ["an impossible date", { ...valid, date: "2026-02-30" }],
      ["a slashed date", { ...valid, date: "2026/11/20" }],
      ["a non-string date", { ...valid, date: 20261120 }],
      ["a date a week ahead", { ...valid, date: "2026-11-28" }],
      ["zero BTC", { ...valid, btc_held: 0 }],
      ["negative BTC", { ...valid, btc_held: -1 }],
      ["BTC as a string", { ...valid, btc_held: "100" }],
      ["fractional shares", { ...valid, shares_outstanding: 1.5 }],
      ["shares as a string", { ...valid, shares_outstanding: "5" }],
      ["zero shares", { ...valid, shares_outstanding: 0 }],
      ["an array body", [valid]],
    ])("rejects %s with 400 and changes nothing", async (_name, body) => {
      await start();
      const snapshots = snapshotCount();
      const edits = manualEditCount();
      const result = await json("/api/markets/holdings", "POST", body);
      expect(result.response.status).toBe(400);
      expect(typeof result.body.error).toBe("string");
      expect(snapshotCount()).toBe(snapshots);
      expect(manualEditCount()).toBe(edits);
    });
  });
});
