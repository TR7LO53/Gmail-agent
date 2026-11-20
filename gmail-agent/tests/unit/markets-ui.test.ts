// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/ui/public");
const STORAGE_KEY = "ggent.markets.layout.v1";

let createMarketsTab: (deps: Record<string, any>) => Record<string, any>;

beforeAll(() => {
  document.body.innerHTML = "";
  const context = vm.createContext(window as any);
  vm.runInContext(readFileSync(path.join(PUBLIC_DIR, "markets.js"), "utf-8"), context);
  createMarketsTab = (context as any).createMarketsTab;
});

// The real markup of the tab, so the test notices when index.html and markets.js drift apart.
function marketsMarkup(): string {
  const html = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
  const match = /<main id="view-markets"[\s\S]*?<\/main>/.exec(html);
  if (!match) throw new Error("view-markets not found in index.html");
  return match[0];
}

interface FakeSeries { type: string; setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }

function fakeCharts() {
  const created: { chart: any; series: FakeSeries[]; scale: any }[] = [];
  const lib = {
    CandlestickSeries: "candles",
    LineSeries: "line",
    createChart: vi.fn(() => {
      const record: { chart: any; series: FakeSeries[]; scale: any } = {
        chart: null,
        series: [],
        scale: { scrollToRealTime: vi.fn(), fitContent: vi.fn(), setVisibleLogicalRange: vi.fn() },
      };
      record.chart = {
        addSeries: vi.fn((type: string) => {
          const series = { type, setData: vi.fn(), update: vi.fn() };
          record.series.push(series);
          return series;
        }),
        removeSeries: vi.fn(),
        timeScale: () => record.scale,
      };
      created.push(record);
      return record.chart;
    }),
  };
  return { lib, created };
}

const candle = (time: number, close = 100) => ({ time, open: close - 1, high: close + 1, low: close - 2, close, isLive: false });
const point = (time: number, value = 25) => ({ time, value, isLive: false });

function seriesBody(entry: string, tf: string, extra: Record<string, unknown> = {}) {
  const kind = entry === "gold-silver-ratio" || entry === "strategy-premium" ? "line" : "candles";
  return {
    entry,
    timeframe: tf,
    kind,
    displayTimeZone: "Europe/Warsaw",
    ok: true,
    stale: false,
    ...(kind === "candles" ? { candles: [candle(1000), candle(2000)] } : { points: [point(1000), point(2000)] }),
    hasLiveCandle: false,
    fetchedAt: "2026-11-21T11:10:00.000Z",
    error: null,
    lastSuccessAt: "2026-11-21T11:10:00.000Z",
    ...extra,
  };
}

function watchlistEntry(id: string, label: string, over: Record<string, unknown> = {}) {
  return {
    id, label, kind: "candles", unit: "USD", ok: true, stale: false, value: 1234.5, valueTime: 1, change: 12.34,
    changePercent: 1.4, changeUnit: "USD", dayLabel: null, error: null, lastSuccessAt: "2026-11-21T11:05:00.000Z", ...over,
  };
}

const WATCHLIST = {
  displayTimeZone: "Europe/Warsaw",
  entries: [
    watchlistEntry("BTC-USD", "Bitcoin", { dayLabel: "Fri" }),
    watchlistEntry("MSTR", "Strategy (MSTR)"),
    watchlistEntry("CCJ", "Cameco (CCJ)"),
    watchlistEntry("gold-silver-ratio", "Gold/Silver Ratio", { kind: "line", unit: "ratio", value: 80.123, change: -0.5, changePercent: -0.6, changeUnit: "ratio" }),
    watchlistEntry("strategy-premium", "Strategy Premium", { kind: "line", unit: "%", value: 25.3, change: 4, changePercent: null, changeUnit: "pp" }),
  ],
};

const HOLDINGS = {
  latest: { date: "2026-11-18", btc_held: 640000.5, shares_outstanding: 300000000, source: "automatic", created_at: "x" },
  stale: false,
  staleAfterDays: 14,
  warning: null,
};

interface World {
  series: (entry: string, tf: string) => any | "network-error";
  watchlist: any;
  holdings: any;
  post: (body: any) => { status: number; body: any };
}

function setup(over: Partial<World> = {}) {
  document.body.innerHTML = marketsMarkup();
  const world: World = {
    series: (entry, tf) => seriesBody(entry, tf),
    watchlist: WATCHLIST,
    holdings: HOLDINGS,
    post: () => ({ status: 201, body: { ...HOLDINGS, snapshot: HOLDINGS.latest } }),
    ...over,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    if (url === "/api/markets/watchlist") return json(world.watchlist);
    if (url === "/api/markets/holdings" && init?.method === "POST") {
      const result = world.post(JSON.parse(init.body));
      return json(result.body, result.status);
    }
    if (url === "/api/markets/holdings") return json(world.holdings);
    const match = /^\/api\/markets\/series\?entry=([^&]+)&tf=(\w+)$/.exec(url);
    if (match) {
      const body = world.series(decodeURIComponent(match[1]), match[2]);
      if (body === "network-error") throw new Error("offline");
      return json(body);
    }
    return json({ error: "unexpected" }, 404);
  });
  const charts = fakeCharts();
  const intervals = { set: vi.fn(() => 42), clear: vi.fn() };
  const tab = createMarketsTab({
    root: document,
    fetch: fetchMock,
    storage: window.localStorage,
    charts: charts.lib,
    setInterval: intervals.set,
    clearInterval: intervals.clear,
    isPageVisible: () => true,
  });
  return { tab, world, fetchMock, charts, intervals };
}

const slotEl = (i: number) => document.querySelector(`.chart-slot[data-slot="${i}"]`) as HTMLElement;
const slotTitle = (i: number) => slotEl(i).querySelector(".slot-title")!.textContent;
const activeTf = (i: number) => slotEl(i).querySelector(".tf.active")!.getAttribute("data-tf");
const watchRow = (id: string) => document.querySelector(`.wl-row[data-entry="${id}"]`) as HTMLElement;
const onGridMark = (id: string) => !(watchRow(id).querySelector(".wl-grid-mark") as HTMLElement).hidden;
const click = (node: Element) => node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const seriesUrls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith("/api/markets/series"));
const savedLayout = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);

beforeEach(() => {
  window.localStorage.clear();
});

describe("Markets tab", () => {
  it("shows the default D1 grid on first open", async () => {
    const { tab } = setup();
    await tab.show();
    expect([0, 1, 2, 3].map(slotTitle)).toEqual(["Bitcoin", "Cameco (CCJ)", "Strategy Premium", "Gold/Silver Ratio"]);
    expect([0, 1, 2, 3].map(activeTf)).toEqual(["D1", "D1", "D1", "D1"]);
    expect(Array.from(document.querySelectorAll(".chart-slot.selected"))).toEqual([slotEl(0)]);
    expect(onGridMark("MSTR")).toBe(false);
    for (const id of ["BTC-USD", "CCJ", "gold-silver-ratio", "strategy-premium"]) expect(onGridMark(id)).toBe(true);
  });

  it("does not fetch anything until the tab is shown", () => {
    const { fetchMock } = setup();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects a slot and swaps its entry from the Watchlist", async () => {
    const { tab, fetchMock, charts } = setup();
    await tab.show();
    click(slotEl(3));
    expect(Array.from(document.querySelectorAll(".chart-slot.selected"))).toEqual([slotEl(3)]);

    click(watchRow("MSTR"));
    await vi.waitFor(() => expect(seriesUrls(fetchMock)).toContain("/api/markets/series?entry=MSTR&tf=D1"));
    expect(slotTitle(3)).toBe("Strategy (MSTR)");
    await vi.waitFor(() => expect(charts.created[3].series.at(-1)?.type).toBe("candles"));
    expect(onGridMark("MSTR")).toBe(true);
    expect(onGridMark("gold-silver-ratio")).toBe(false);
    expect(savedLayout().slots[3]).toEqual({ entry: "MSTR", tf: "D1" });
    expect(savedLayout().selected).toBe(3);
  });

  it("allows the same entry in several slots", async () => {
    const { tab } = setup();
    await tab.show();
    click(watchRow("BTC-USD")); // slot 0 is selected and already Bitcoin
    click(slotEl(1));
    click(watchRow("BTC-USD"));
    expect(slotTitle(0)).toBe("Bitcoin");
    expect(slotTitle(1)).toBe("Bitcoin");
    expect(savedLayout().slots.map((s: any) => s.entry)).toEqual(["BTC-USD", "BTC-USD", "strategy-premium", "gold-silver-ratio"]);
  });

  it("changes the timeframe of one slot only", async () => {
    const { tab, fetchMock } = setup();
    await tab.show();
    click(slotEl(1).querySelector('.tf[data-tf="H4"]')!);
    await vi.waitFor(() => expect(seriesUrls(fetchMock)).toContain("/api/markets/series?entry=CCJ&tf=H4"));
    expect([0, 1, 2, 3].map(activeTf)).toEqual(["D1", "H4", "D1", "D1"]);
    expect(savedLayout().slots.map((s: any) => s.tf)).toEqual(["D1", "H4", "D1", "D1"]);
    expect(savedLayout().selected).toBe(1);
  });

  it("restores the layout from localStorage", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selected: 2,
        slots: [
          { entry: "BTC-USD", tf: "D1" },
          { entry: "CCJ", tf: "H1" },
          { entry: "MSTR", tf: "W1" },
          { entry: "gold-silver-ratio", tf: "MN" },
        ],
      }),
    );
    setup();
    expect([0, 1, 2, 3].map(slotTitle)).toEqual(["Bitcoin", "Cameco (CCJ)", "Strategy (MSTR)", "Gold/Silver Ratio"]);
    expect([0, 1, 2, 3].map(activeTf)).toEqual(["D1", "H1", "W1", "MN"]);
    expect(Array.from(document.querySelectorAll(".chart-slot.selected"))).toEqual([slotEl(2)]);
  });

  it("falls back to the default grid for broken saved layouts, fixing only a bad slot", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    let { tab } = setup();
    expect(tab.getLayout().slots[0]).toEqual({ entry: "BTC-USD", tf: "D1" });

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ selected: 9, slots: [{ entry: "DOGE", tf: "D1" }, { entry: "MSTR", tf: "H4" }, { entry: "CCJ", tf: "X9" }, null] }),
    );
    ({ tab } = setup());
    expect(tab.getLayout()).toEqual({
      selected: 0,
      slots: [
        { entry: "BTC-USD", tf: "D1" },
        { entry: "MSTR", tf: "H4" },
        { entry: "strategy-premium", tf: "D1" },
        { entry: "gold-silver-ratio", tf: "D1" },
      ],
    });

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ selected: 1, slots: [] }));
    ({ tab } = setup());
    expect(tab.getLayout().selected).toBe(0);
  });

  it("keeps the old chart and shows a grey last-update label when a refresh fails", async () => {
    const { tab, world, charts } = setup();
    await tab.show();
    const first = charts.created[0].series[0];
    expect(first.setData).toHaveBeenCalledTimes(1);

    world.series = (entry, tf) =>
      seriesBody(entry, tf, { ok: false, stale: true, candles: [], points: [], lastSuccessAt: "2026-11-21T11:05:00.000Z", error: { category: "network" } });
    await tab.refreshAll();

    for (const record of charts.created) {
      for (const series of record.series) {
        expect(series.setData).not.toHaveBeenCalledWith([]);
        expect(series.update).not.toHaveBeenCalled();
      }
    }
    expect(charts.created[0].chart.removeSeries).not.toHaveBeenCalled();
    expect(slotEl(0).querySelector(".stale-label")!.textContent).toBe("last update 12:05");
    expect((slotEl(0).querySelector(".slot-msg") as HTMLElement).hidden).toBe(true);
  });

  it("treats a network error like a failed refresh", async () => {
    const { tab, world, charts } = setup();
    await tab.show();
    world.series = () => "network-error";
    await tab.refreshAll();
    expect(charts.created[0].series[0].setData).toHaveBeenCalledTimes(1);
    expect(slotEl(0).querySelector(".stale-label")!.textContent).toMatch(/^last update \d\d:\d\d$/);
  });

  it("says so when an entry has never loaded", async () => {
    const { tab } = setup({ series: (entry, tf) => seriesBody(entry, tf, { ok: false, stale: true, candles: [], points: [], lastSuccessAt: null }) });
    await tab.show();
    const msg = slotEl(0).querySelector(".slot-msg") as HTMLElement;
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toBe("No data. Retrying every 5 minutes.");
  });

  it("picks candles for instruments and lines for derived series", async () => {
    const { tab, charts } = setup();
    await tab.show();
    expect(charts.created.map((r) => r.series[0].type)).toEqual(["candles", "candles", "line", "line"]);
  });

  it("pushes only the live bar when the same series is refreshed, keeping the zoom", async () => {
    const { tab, world, charts } = setup();
    await tab.show();
    world.series = (entry, tf) =>
      seriesBody(entry, tf, entry === "BTC-USD" ? { candles: [candle(1000), candle(2000, 150), candle(3000, 160)] } : {});
    await tab.refreshAll();
    const btc = charts.created[0].series[0];
    expect(btc.setData).toHaveBeenCalledTimes(1);
    expect(btc.update).toHaveBeenCalledTimes(2);
    expect(btc.update).toHaveBeenLastCalledWith(expect.objectContaining({ time: 3000, close: 160 }));
    expect(charts.created[0].scale.fitContent).toHaveBeenCalledTimes(1);
  });

  it("ignores an older response that arrives after a newer one", async () => {
    let releaseH4: (() => void) | undefined;
    const { tab, fetchMock, charts } = setup();
    await tab.show();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (url.includes("entry=CCJ&tf=H4")) await new Promise<void>((resolve) => { releaseH4 = resolve; });
      return original(url, init);
    });
    click(slotEl(1).querySelector('.tf[data-tf="H4"]')!);
    click(slotEl(1).querySelector('.tf[data-tf="W1"]')!);
    await vi.waitFor(() => expect(releaseH4).toBeDefined());
    await vi.waitFor(() => expect(charts.created[1].series.length).toBe(2));
    releaseH4!();
    await new Promise((r) => setTimeout(r, 20));
    expect(charts.created[1].series).toHaveLength(2); // the late H4 answer did not replace W1
    expect(activeTf(1)).toBe("W1");
  });

  it("renders the Watchlist with values, day label, changes and stale label", async () => {
    const watchlist = {
      ...WATCHLIST,
      entries: WATCHLIST.entries.map((e) =>
        e.id === "CCJ" ? { ...e, stale: true, ok: false } : e.id === "MSTR" ? { ...e, value: null, change: null, changePercent: null, lastSuccessAt: null } : e,
      ),
    };
    const { tab } = setup({ watchlist });
    await tab.show();
    expect(document.querySelectorAll(".wl-row")).toHaveLength(5);
    expect(watchRow("BTC-USD").textContent).toContain("1,234.50");
    expect(watchRow("BTC-USD").textContent).toContain("+12.34 (+1.4%)");
    expect(watchRow("BTC-USD").textContent).toContain("Fri");
    expect(watchRow("gold-silver-ratio").textContent).toContain("80.12");
    expect(watchRow("gold-silver-ratio").textContent).toContain("-0.50 (-0.6%)");
    expect(watchRow("strategy-premium").textContent).toContain("+25.3%");
    expect(watchRow("strategy-premium").textContent).toContain("+4.0 pp");
    expect(watchRow("CCJ").textContent).toContain("last update 12:05");
    expect(watchRow("MSTR").textContent).toContain("No data");
  });

  it("renders holdings, the stale warning and the sanity warning", async () => {
    const { tab, world } = setup();
    await tab.show();
    const box = document.getElementById("marketsHoldingsInfo")!;
    expect(box.textContent).toContain("Holdings as of 2026-11-18 (automatic): 640,000.5 BTC, 300,000,000 shares");

    world.holdings = {
      latest: { ...HOLDINGS.latest, source: "manual" },
      stale: true,
      staleAfterDays: 14,
      warning: { reason: "btc_increased_too_much", date: "2026-11-20", btc_held: 800000, previous_date: "2026-11-18", previous_btc_held: 640000 },
    };
    await tab.refreshAll();
    expect(box.textContent).toContain("Holdings are more than 14 days old (as of 2026-11-18).");
    expect(box.textContent).toContain("An automatic reading from 2026-11-20 was not saved: BTC held rose more than 10% (from 640,000 to 800,000). If it is right, enter it below.");

    world.holdings = { ...world.holdings, stale: false, warning: { reason: "btc_decreased", date: "2026-11-20", btc_held: 600000, previous_date: "2026-11-18", previous_btc_held: 640000 } };
    await tab.refreshAll();
    expect(box.textContent).toContain("BTC held fell from 640,000 to 600,000");

    world.holdings = { latest: null, stale: true, staleAfterDays: 14, warning: null };
    await tab.refreshAll();
    expect(box.textContent).toContain("No holdings yet.");
  });

  it("posts the holdings form as numbers and shows the new snapshot", async () => {
    const post = vi.fn(() => ({
      status: 201,
      body: { snapshot: {}, latest: { date: "2026-11-20", btc_held: 641000, shares_outstanding: 301000000, source: "manual", created_at: "x" }, stale: false, staleAfterDays: 14, warning: null },
    }));
    const { tab } = setup({ post });
    await tab.show();
    const form = document.getElementById("marketsHoldingsForm") as HTMLFormElement;
    (form.elements.namedItem("date") as HTMLInputElement).value = "2026-11-20";
    (form.elements.namedItem("btc_held") as HTMLInputElement).value = "641000";
    (form.elements.namedItem("shares_outstanding") as HTMLInputElement).value = "301000000";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("marketsHoldingsInfo")!.textContent).toContain("Holdings as of 2026-11-20 (manual)"));
    expect(post).toHaveBeenCalledWith({ date: "2026-11-20", btc_held: 641000, shares_outstanding: 301000000 });
    expect((form.elements.namedItem("btc_held") as HTMLInputElement).value).toBe("");
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the server's error when the holdings form is rejected", async () => {
    const { tab } = setup({ post: () => ({ status: 400, body: { error: "shares_outstanding must be a positive whole number." } }) });
    await tab.show();
    const form = document.getElementById("marketsHoldingsForm") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("marketsHoldingsErr")!.textContent).toBe("shares_outstanding must be a positive whole number."));
  });

  it("maximizes and restores a slot, and Escape restores it", async () => {
    const { tab } = setup();
    await tab.show();
    const button = slotEl(2).querySelector('[data-action="maximize"]')!;
    click(button);
    expect(slotEl(2).classList.contains("maximized")).toBe(true);
    expect(button.textContent).toBe("Restore");
    click(button);
    expect(slotEl(2).classList.contains("maximized")).toBe(false);
    click(button);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(slotEl(2).classList.contains("maximized")).toBe(false);
  });

  it("jumps to now", async () => {
    const { tab, charts } = setup();
    await tab.show();
    click(slotEl(0).querySelector('[data-action="jump"]')!);
    expect(charts.created[0].scale.scrollToRealTime).toHaveBeenCalledTimes(1);
  });

  it("refreshes every 5 minutes only while shown, without doubling the timer", async () => {
    const { tab, intervals } = setup();
    await tab.show();
    await tab.show();
    expect(intervals.set).toHaveBeenCalledTimes(1);
    expect(intervals.set).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
    tab.hide();
    expect(intervals.clear).toHaveBeenCalledWith(42);
    await tab.show();
    expect(intervals.set).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing when the browser tab is hidden and refreshes again on return", async () => {
    let visible = true;
    document.body.innerHTML = marketsMarkup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ displayTimeZone: "Europe/Warsaw", entries: [] })));
    const intervals = { set: vi.fn(() => 7), clear: vi.fn() };
    const tab = createMarketsTab({
      root: document, fetch: fetchMock, storage: window.localStorage, charts: undefined,
      setInterval: intervals.set, clearInterval: intervals.clear, isPageVisible: () => visible,
    });
    await tab.show();
    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(intervals.clear).toHaveBeenCalledWith(7);
    const callsBefore = fetchMock.mock.calls.length;
    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(intervals.set).toHaveBeenCalledTimes(2);
  });

  it("shows a message instead of throwing when the chart library is missing", async () => {
    document.body.innerHTML = marketsMarkup();
    const tab = createMarketsTab({
      root: document,
      fetch: async (url: string) => new Response(JSON.stringify(url.includes("series") ? seriesBody("BTC-USD", "D1") : {})),
      storage: window.localStorage, charts: undefined,
      setInterval: () => 1, clearInterval: () => {}, isPageVisible: () => true,
    });
    await tab.show();
    expect(slotEl(0).querySelector(".slot-msg")!.textContent).toContain("Chart library failed to load");
  });
});
