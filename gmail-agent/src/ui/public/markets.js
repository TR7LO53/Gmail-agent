// Markets tab: Watchlist, 2×2 grid of Chart Slots and the holdings form.
// Self-contained on purpose: app.js shares this page's global scope, so everything lives inside
// createMarketsTab() and the only top-level names here are that function and window.marketsTab.
// Nothing is fetched until the tab is shown (show()), and it stops again when hidden (hide()).

function createMarketsTab(deps) {
  const root = deps.root;
  const fetchFn = deps.fetch;
  const storage = deps.storage;
  const charts = deps.charts;
  const setIntervalFn = deps.setInterval;
  const clearIntervalFn = deps.clearInterval;
  const isPageVisible = deps.isPageVisible;
  const now = deps.now || Date.now;

  // Same ids and order as the server's WATCHLIST / TIMEFRAMES (src/markets).
  const ENTRIES = [
    { id: "BTC-USD", label: "Bitcoin", kind: "candles" },
    { id: "MSTR", label: "Strategy (MSTR)", kind: "candles" },
    { id: "CCJ", label: "Cameco (CCJ)", kind: "candles" },
    { id: "gold-silver-ratio", label: "Gold/Silver Ratio", kind: "line" },
    { id: "strategy-premium", label: "Strategy Premium", kind: "line" },
  ];
  const TIMEFRAMES = ["H1", "H4", "D1", "W1", "MN"];
  const INTRADAY = new Set(["H1", "H4"]);
  const DEFAULT_SLOTS = [
    { entry: "BTC-USD", tf: "D1" },
    { entry: "CCJ", tf: "D1" },
    { entry: "strategy-premium", tf: "D1" },
    { entry: "gold-silver-ratio", tf: "D1" },
  ];
  const STORAGE_KEY = "ggent.markets.layout.v1";
  const REFRESH_MS = 5 * 60 * 1000;
  const VISIBLE_BARS = 120;
  const NO_DATA_TEXT = "No data. Retrying every 5 minutes.";

  let timeZone = "Europe/Warsaw";
  let watchlist = null;
  let holdingsData = null;
  let shown = false;
  let timer = null;
  let maximized = null;
  const cache = new Map(); // "entry:tf" -> last good data
  const slots = [];
  const entryById = (id) => ENTRIES.find((e) => e.id === id);

  const el = (id) => root.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---- Time and number formatting (always the display time zone, never the machine's) ----
  const formatters = new Map();
  function dtf(options) {
    const key = `${timeZone}|${JSON.stringify(options)}`;
    if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat("pl-PL", { timeZone, ...options }));
    return formatters.get(key);
  }
  const hm = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms) : "";
  };
  const num = (value, digits) =>
    Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const plain = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 });
  const signed = (value, digits) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${num(Math.abs(value), digits)}`;

  function crosshairTime(seconds, tf) {
    const date = new Date(seconds * 1000);
    const day = dtf({ day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
    if (!INTRADAY.has(tf)) return day;
    return `${day} ${dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)}`;
  }

  // tickMarkType: 0 year, 1 month, 2 day of month, 3 time, 4 time with seconds.
  function tickLabel(seconds, tickMarkType) {
    const date = new Date(seconds * 1000);
    if (tickMarkType === 0) return dtf({ year: "numeric" }).format(date);
    if (tickMarkType === 1) return dtf({ month: "short" }).format(date);
    if (tickMarkType === 2) return dtf({ day: "numeric", month: "short" }).format(date);
    return dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  }

  // ---- Layout (remembered in localStorage) ----
  function defaultLayout() {
    return { selected: 0, slots: DEFAULT_SLOTS.map((s) => ({ ...s })) };
  }

  function loadLayout() {
    const layout = defaultLayout();
    let saved;
    try {
      saved = JSON.parse(storage.getItem(STORAGE_KEY));
    } catch {
      return layout;
    }
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.slots) || saved.slots.length !== 4) return layout;
    saved.slots.forEach((slot, i) => {
      if (slot && entryById(slot.entry) && TIMEFRAMES.includes(slot.tf)) layout.slots[i] = { entry: slot.entry, tf: slot.tf };
    });
    if (Number.isInteger(saved.selected) && saved.selected >= 0 && saved.selected <= 3) layout.selected = saved.selected;
    return layout;
  }

  let layout = loadLayout();

  function saveLayout() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Storage full or blocked: the grid just won't be remembered.
    }
  }

  // ---- Grid ----
  function buildGrid() {
    const grid = el("marketsGrid");
    grid.innerHTML = [0, 1, 2, 3]
      .map(
        (i) => `
      <div class="chart-slot" data-slot="${i}">
        <div class="slot-head">
          <span class="slot-title"></span>
          ${TIMEFRAMES.map((tf) => `<button type="button" class="btn tf" data-tf="${tf}">${tf}</button>`).join("")}
          <button type="button" class="btn" data-action="jump">Jump to now</button>
          <button type="button" class="btn" data-action="maximize">Maximize</button>
        </div>
        <div class="slot-body"><div class="slot-chart"></div><div class="slot-msg" hidden></div></div>
        <div class="slot-foot"><span class="stale-label"></span></div>
      </div>`,
      )
      .join("");
    grid.querySelectorAll(".chart-slot").forEach((node) => {
      const i = Number(node.dataset.slot);
      slots[i] = {
        node,
        chartEl: node.querySelector(".slot-chart"),
        msgEl: node.querySelector(".slot-msg"),
        staleEl: node.querySelector(".stale-label"),
        chart: null,
        series: null,
        seriesKey: null,
        lastData: null,
        version: 0,
      };
    });
  }

  const slotKey = (i) => `${layout.slots[i].entry}:${layout.slots[i].tf}`;

  function renderSlotHeaders() {
    slots.forEach((slot, i) => {
      const { entry, tf } = layout.slots[i];
      slot.node.classList.toggle("selected", i === layout.selected);
      slot.node.classList.toggle("maximized", i === maximized);
      slot.node.querySelector(".slot-title").textContent = entryById(entry).label;
      slot.node.querySelectorAll(".tf").forEach((btn) => btn.classList.toggle("active", btn.dataset.tf === tf));
      slot.node.querySelector('[data-action="maximize"]').textContent = i === maximized ? "Restore" : "Maximize";
    });
  }

  function setMessage(slot, text) {
    slot.msgEl.textContent = text || "";
    slot.msgEl.hidden = !text;
  }

  function setStale(slot, iso) {
    const time = iso ? hm(iso) : "";
    slot.staleEl.textContent = time ? `last update ${time}` : "";
  }

  // ---- Charts ----
  function ensureChart(slot, i) {
    if (slot.chart) return true;
    if (!charts) {
      setMessage(slot, "Chart library failed to load.");
      return false;
    }
    slot.chart = charts.createChart(slot.chartEl, {
      autoSize: true,
      layout: { background: { type: "solid", color: "#191d2f" }, textColor: "#9aa0b8" },
      grid: { vertLines: { color: "#21263c" }, horzLines: { color: "#21263c" } },
      rightPriceScale: { borderColor: "#2b3150" },
      timeScale: {
        borderColor: "#2b3150",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time, tickMarkType) => tickLabel(time, tickMarkType),
      },
      localization: { timeFormatter: (time) => crosshairTime(time, layout.slots[i].tf) },
    });
    return true;
  }

  function dropSeries(slot) {
    if (slot.chart && slot.series) slot.chart.removeSeries(slot.series);
    slot.series = null;
    slot.seriesKey = null;
    slot.lastData = null;
  }

  // Times must strictly increase or the library throws and the whole slot stays blank.
  function normalize(kind, rows) {
    const out = [];
    for (const row of rows) {
      const bar =
        kind === "candles"
          ? { time: row.time, open: row.open, high: row.high, low: row.low, close: row.close }
          : { time: row.time, value: row.value };
      const last = out[out.length - 1];
      if (last && bar.time === last.time) out[out.length - 1] = bar;
      else if (!last || bar.time > last.time) out.push(bar);
    }
    return out;
  }

  function seriesOptions(entryId) {
    if (entryId === "strategy-premium") {
      return { priceFormat: { type: "custom", minMove: 0.1, formatter: (v) => `${v.toFixed(1)}%` } };
    }
    if (entryId === "gold-silver-ratio") return { priceFormat: { type: "price", precision: 2, minMove: 0.01 } };
    return {};
  }

  function applyData(i, key, kind, rows) {
    const slot = slots[i];
    if (!ensureChart(slot, i)) return false;
    const data = normalize(kind, rows);
    if (slot.seriesKey !== key || !slot.series) {
      dropSeries(slot);
      slot.series =
        kind === "candles"
          ? slot.chart.addSeries(charts.CandlestickSeries, {
              upColor: "#47d16c",
              downColor: "#ff6b6b",
              borderUpColor: "#47d16c",
              borderDownColor: "#ff6b6b",
              wickUpColor: "#47d16c",
              wickDownColor: "#ff6b6b",
            })
          : slot.chart.addSeries(charts.LineSeries, { color: "#6c8cff", lineWidth: 2, ...seriesOptions(layout.slots[i].entry) });
      slot.series.setData(data);
      slot.seriesKey = key;
      slot.lastData = data;
      const scale = slot.chart.timeScale();
      if (data.length > VISIBLE_BARS) scale.setVisibleLogicalRange({ from: data.length - VISIBLE_BARS, to: data.length + 4 });
      else scale.fitContent();
      return true;
    }
    // Same series refreshed: keep the user's zoom. If the earlier bars are unchanged, only the
    // live bar and any new bars need to be pushed.
    const old = slot.lastData || [];
    const overlap = Math.min(old.length, data.length);
    let samePrefix = old.length > 0 && data.length >= old.length;
    for (let k = 0; samePrefix && k < overlap - 1; k++) if (old[k].time !== data[k].time) samePrefix = false;
    if (samePrefix && old[old.length - 1].time === data[old.length - 1].time) {
      for (let k = old.length - 1; k < data.length; k++) slot.series.update(data[k]);
    } else {
      slot.series.setData(data);
    }
    slot.lastData = data;
    return true;
  }

  // ---- Series data ----
  async function requestSeries(entry, tf) {
    try {
      const res = await fetchFn(`/api/markets/series?entry=${encodeURIComponent(entry)}&tf=${tf}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function dataOf(body) {
    const rows = body && (body.candles || body.points);
    return Array.isArray(rows) ? rows : [];
  }

  function showCached(i) {
    const slot = slots[i];
    const cached = cache.get(slotKey(i));
    if (cached) {
      if (applyData(i, slotKey(i), cached.kind, cached.rows)) setMessage(slot, null);
      setStale(slot, "");
    } else {
      dropSeries(slot);
      setMessage(slot, "Loading…");
      setStale(slot, "");
    }
  }

  async function refreshSlot(i, memo) {
    const slot = slots[i];
    const key = slotKey(i);
    const { entry, tf } = layout.slots[i];
    const version = ++slot.version;
    let pending = memo && memo.get(key);
    if (!pending) {
      pending = requestSeries(entry, tf);
      if (memo) memo.set(key, pending);
    }
    const body = await pending;
    if (slot.version !== version || slotKey(i) !== key) return; // The slot moved on while we waited.
    if (body && body.displayTimeZone) timeZone = body.displayTimeZone;
    const rows = dataOf(body);
    if (body && body.ok === true && rows.length > 0) {
      const lastSuccessAt = body.lastSuccessAt || new Date(now()).toISOString();
      cache.set(key, { kind: entryById(entry).kind, rows, lastSuccessAt });
      if (applyData(i, key, entryById(entry).kind, rows)) setMessage(slot, null);
      setStale(slot, "");
      return;
    }
    // A failed refresh never blanks a chart: keep what we have and say when it is from.
    const cached = cache.get(key);
    if (!cached) {
      dropSeries(slot);
      setMessage(slot, NO_DATA_TEXT);
      setStale(slot, "");
      return;
    }
    if (slot.seriesKey === key || applyData(i, key, cached.kind, cached.rows)) setMessage(slot, null);
    setStale(slot, (body && body.lastSuccessAt) || cached.lastSuccessAt);
  }

  // ---- Watchlist ----
  function buildWatchlist() {
    el("marketsWatchlist").innerHTML = ENTRIES.map(
      (e) => `
      <button type="button" class="wl-row" data-entry="${esc(e.id)}">
        <span class="wl-top"><span class="wl-name">${esc(e.label)}</span><span class="wl-value">—</span></span>
        <span class="wl-sub"><span class="wl-change"></span><span class="wl-grid-mark" hidden>on grid</span></span>
        <span class="wl-sub"><span class="wl-day"></span><span class="stale-label"></span></span>
      </button>`,
    ).join("");
  }

  function formatValue(entry) {
    if (entry.value === null || entry.value === undefined) return "—";
    if (entry.unit === "%") return `${signed(entry.value, 1)}%`;
    return num(entry.value, 2);
  }

  function formatChange(entry) {
    if (entry.change === null || entry.change === undefined) return { text: "", cls: "" };
    const cls = entry.change > 0 ? "chg-up" : entry.change < 0 ? "chg-down" : "";
    if (entry.changeUnit === "pp") return { text: `${signed(entry.change, 1)} pp`, cls };
    const pct = entry.changePercent === null || entry.changePercent === undefined ? "" : ` (${signed(entry.changePercent, 1)}%)`;
    return { text: `${signed(entry.change, 2)}${pct}`, cls };
  }

  function renderWatchlist() {
    const onGrid = new Set(layout.slots.map((s) => s.entry));
    el("marketsWatchlist").querySelectorAll(".wl-row").forEach((row) => {
      const id = row.dataset.entry;
      const data = watchlist && watchlist.find((e) => e.id === id);
      row.querySelector(".wl-grid-mark").hidden = !onGrid.has(id);
      if (!data) return;
      const noValue = data.value === null || data.value === undefined;
      row.querySelector(".wl-value").textContent = noValue ? "No data" : formatValue(data);
      const change = formatChange(data);
      const changeEl = row.querySelector(".wl-change");
      changeEl.textContent = noValue ? "" : change.text;
      changeEl.className = `wl-change ${change.cls}`.trim();
      row.querySelector(".wl-day").textContent = data.dayLabel || "";
      const staleTime = data.stale && data.lastSuccessAt ? hm(data.lastSuccessAt) : "";
      row.querySelector(".stale-label").textContent = staleTime ? `last update ${staleTime}` : "";
    });
  }

  async function refreshWatchlist() {
    try {
      const res = await fetchFn("/api/markets/watchlist");
      if (!res.ok) return;
      const body = await res.json();
      if (body.displayTimeZone) timeZone = body.displayTimeZone;
      if (Array.isArray(body.entries)) watchlist = body.entries;
    } catch {
      return; // Keep the last numbers.
    }
    renderWatchlist();
  }

  // ---- Holdings ----
  function warningText(w) {
    const was = plain(w.previous_btc_held);
    const got = plain(w.btc_held);
    const head = `An automatic reading from ${w.date} was not saved`;
    if (w.reason === "btc_decreased") return `${head}: BTC held fell from ${was} to ${got}. If it is right, enter it below.`;
    return `${head}: BTC held rose more than 10% (from ${was} to ${got}). If it is right, enter it below.`;
  }

  function renderHoldings() {
    const box = el("marketsHoldingsInfo");
    if (!holdingsData) {
      box.innerHTML = '<p class="empty">Loading…</p>';
      return;
    }
    const { latest, stale, staleAfterDays, warning } = holdingsData;
    const parts = [];
    if (!latest) {
      parts.push('<div class="empty">No holdings yet.</div>');
    } else {
      parts.push(
        `<div>Holdings as of ${esc(latest.date)} (${esc(latest.source)}): ${esc(plain(latest.btc_held))} BTC, ${esc(plain(latest.shares_outstanding))} shares</div>`,
      );
      if (stale) {
        parts.push(`<div class="hold-warn">Holdings are more than ${esc(staleAfterDays || 14)} days old (as of ${esc(latest.date)}).</div>`);
      }
    }
    if (warning) parts.push(`<div class="hold-warn">${esc(warningText(warning))}</div>`);
    box.innerHTML = parts.join("");
  }

  async function refreshHoldings() {
    try {
      const res = await fetchFn("/api/markets/holdings");
      if (!res.ok) return;
      holdingsData = await res.json();
    } catch {
      return;
    }
    renderHoldings();
  }

  async function submitHoldings(event) {
    event.preventDefault();
    const form = el("marketsHoldingsForm");
    const errEl = el("marketsHoldingsErr");
    const button = form.querySelector('button[type="submit"]');
    errEl.textContent = "";
    button.disabled = true;
    try {
      const res = await fetchFn("/api/markets/holdings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: form.elements.date.value,
          btc_held: Number(form.elements.btc_held.value),
          shares_outstanding: Number(form.elements.shares_outstanding.value),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errEl.textContent = body.error || `Save failed (${res.status})`;
        return;
      }
      form.reset();
      holdingsData = body;
      renderHoldings();
      refreshWatchlist();
      slots.forEach((_, i) => {
        if (layout.slots[i].entry === "strategy-premium") refreshSlot(i);
      });
    } catch {
      errEl.textContent = "Save failed (network error)";
    } finally {
      button.disabled = false;
    }
  }

  // ---- Refresh cycle ----
  function refreshAll() {
    const memo = new Map();
    return Promise.all([refreshWatchlist(), refreshHoldings(), ...slots.map((_, i) => refreshSlot(i, memo))]);
  }

  function startTimer() {
    if (timer !== null) return;
    timer = setIntervalFn(() => {
      refreshAll();
    }, REFRESH_MS);
  }

  function stopTimer() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function show() {
    shown = true;
    renderSlotHeaders();
    renderWatchlist();
    const done = refreshAll();
    if (isPageVisible()) startTimer();
    return done;
  }

  function hide() {
    shown = false;
    stopTimer();
  }

  root.addEventListener("visibilitychange", () => {
    if (!shown) return;
    if (isPageVisible()) {
      refreshAll();
      startTimer();
    } else {
      stopTimer();
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && maximized !== null) {
      maximized = null;
      renderSlotHeaders();
    }
  });

  // ---- Wiring ----
  function selectSlot(i) {
    layout.selected = i;
  }

  function changeSlot(i, patch) {
    layout.slots[i] = { ...layout.slots[i], ...patch };
    showCached(i);
    renderSlotHeaders();
    renderWatchlist();
    refreshSlot(i);
  }

  buildGrid();
  buildWatchlist();
  renderSlotHeaders();
  renderWatchlist();
  renderHoldings();

  el("marketsGrid").addEventListener("click", (event) => {
    const node = event.target.closest(".chart-slot");
    if (!node) return;
    const i = Number(node.dataset.slot);
    selectSlot(i);
    const button = event.target.closest("button");
    const action = button && button.dataset.action;
    if (button && button.dataset.tf) {
      if (button.dataset.tf !== layout.slots[i].tf) changeSlot(i, { tf: button.dataset.tf });
    } else if (action === "jump") {
      if (slots[i].chart) slots[i].chart.timeScale().scrollToRealTime();
    } else if (action === "maximize") {
      maximized = maximized === i ? null : i;
    }
    saveLayout();
    renderSlotHeaders();
  });

  el("marketsWatchlist").addEventListener("click", (event) => {
    const row = event.target.closest(".wl-row");
    if (!row) return;
    changeSlot(layout.selected, { entry: row.dataset.entry });
    saveLayout();
  });

  el("marketsHoldingsForm").addEventListener("submit", submitHoldings);

  return {
    show,
    hide,
    refreshAll,
    getLayout: () => JSON.parse(JSON.stringify(layout)),
  };
}

if (typeof document !== "undefined" && document.getElementById("view-markets")) {
  window.marketsTab = createMarketsTab({
    root: document,
    fetch: (...args) => window.fetch(...args),
    storage: window.localStorage,
    charts: window.LightweightCharts,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    isPageVisible: () => document.visibilityState === "visible",
  });
}
