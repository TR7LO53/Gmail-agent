// Vanilla dashboard client. Fetches the read-only API and re-renders on SSE `update` events.
// No framework, no build step.

let showAll = false;
let emailsExpanded = false;
let activityExpanded = false;
let decisionsExpanded = false;
let lastEmails = null;
let lastLogs = null;
let foodsExpanded = false;
let lastFood = null;
let lastDecisions = null;

const EMAILS_COLLAPSED_COUNT = 5;

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function timeAgo(iso) {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

function fmtDate(iso) {
  // Render in the browser's LOCAL timezone (stored values are UTC ISO strings).
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// Compact one-line summary at the top of the dashboard: kcal/goal · P/goal · C/goal · F/goal.
function renderTodayLine({ totals, goals }) {
  const part = (key, label, dp) => {
    const val = dp ? round1(totals[key]) : Math.round(totals[key]);
    const over = totals[key] > goals[key];
    return `<span class="${over ? "over" : ""}">${val}/${goals[key]}<small> ${label}</small></span>`;
  };
  $("todayLine").innerHTML =
    part("kcal", "kcal", false) +
    part("protein_g", "g P", true) +
    part("carbs_g", "g C", true) +
    part("fat_g", "g F", true);
}

const FOODS_VISIBLE_COUNT = 5;

// Foods list is collapsed by default; when expanded it shows FOODS_VISIBLE_COUNT entries at once
// and scrolls for the rest.
function renderNutrition(data) {
  lastFood = data;
  const { entries } = data;
  const el = $("food");

  const foods = entries.length
    ? `<div class="foods foods-scroll">${entries
        .map(
          (e) => `<div class="food">
            <div class="row">
              <span class="food-name">${esc(e.original || e.name)}${e.qty ? ` <span class="who">· ${Math.round(e.qty)} g</span>` : ""}</span>
              <span class="who">${Math.round(e.kcal)} kcal</span>
            </div>
            <div class="who food-matched">${esc(e.name)}${e.provenance ? ` <span class="badge provenance-${esc(e.provenance)}">${e.provenance === "preset" ? "Preset" : "Lookup"}</span>` : ""}</div>
            <div class="food-macros">${round1(e.protein_g)} g P · ${round1(e.carbs_g)} g C · ${round1(e.fat_g)} g F</div>
          </div>`,
        )
        .join("")}</div>`
    : `<p class="empty" style="margin-top:12px">Nothing logged yet today — send Ggent a message on Discord.</p>`;

  el.innerHTML = foods;
  el.hidden = !foodsExpanded;
  $("toggleFoods").setAttribute("aria-expanded", String(foodsExpanded));
  sizeFoodsScroll();
}

// Cap the list's height at the combined height of the first FOODS_VISIBLE_COUNT entries (they vary
// in height). Needs the list to be visible to measure, so it runs after `hidden` is cleared.
function sizeFoodsScroll() {
  const list = document.querySelector("#food .foods-scroll");
  if (!list) return;
  list.style.maxHeight = "";
  const items = list.querySelectorAll(".food");
  if (items.length > FOODS_VISIBLE_COUNT) {
    list.style.maxHeight = `${items[FOODS_VISIBLE_COUNT].offsetTop - items[0].offsetTop}px`;
  }
}

function renderParcels({ parcels }) {
  const el = $("parcels");
  if (!parcels.length) {
    el.innerHTML = `<p class="empty">${showAll ? "No parcels yet." : "No active parcels. Run a scan to populate."}</p>`;
    return;
  }
  el.innerHTML = parcels
    .map((p) => {
      const hist =
        p.history && p.history.length > 1
          ? `<div class="hist">${p.history.map((h) => esc(h.status)).join(" → ")}</div>`
          : "";
      return `<div class="parcel">
        <div class="row">
          <div>
            <div class="tn">${esc(p.tracking_number)}</div>
            <div class="sub">${esc(p.carrier)} · updated ${esc(fmtDate(p.last_update))}</div>
            ${hist}
          </div>
          <span class="badge ${esc(p.status)}">${esc(p.status)}</span>
        </div>
      </div>`;
    })
    .join("");
}

function renderSummary({ summary, generatedAt }) {
  $("summary").innerHTML = summary
    ? `<div class="summary-text">${esc(summary)}</div><div class="hist" style="margin-top:10px">generated ${esc(fmtDate(generatedAt))}</div>`
    : `<p class="empty">No summary yet. Run <code>npm run try -- summary</code> or a heartbeat tick.</p>`;
}

function renderTodayEmails(data) {
  lastEmails = data;
  const { recent, today, counts, lastChecked } = data;
  $("unreadCount").textContent = `${counts.unread} unread`;
  $("unreadCount").className = "badge" + (counts.unread > 0 ? " unread" : "");
  $("lastScanLine").textContent = `Last Gmail check: ${timeAgo(lastChecked)} · ${counts.today} new today · ${counts.unread} unread`;

  const list = recent && recent.length ? recent : today || [];
  const el = $("todayEmails");
  const moreRow = $("emailsMoreRow");
  if (!list.length) {
    el.innerHTML = `<p class="empty">No emails seen yet — run a heartbeat scan to populate.</p>`;
    moreRow.hidden = true;
    return;
  }
  const hiddenCount = Math.max(0, list.length - EMAILS_COLLAPSED_COUNT);
  moreRow.hidden = hiddenCount === 0;
  $("toggleEmails").textContent = emailsExpanded ? "Show less" : `Show ${hiddenCount} more`;
  const visible = emailsExpanded ? list : list.slice(0, EMAILS_COLLAPSED_COUNT);
  const todayIds = new Set((today || []).map((e) => e.id));
  el.innerHTML = visible
    .map(
      (e) => `<div class="email">
        <div class="row">
          <span>${e.is_unread ? '<span class="badge unread">unread</span> ' : ""}${todayIds.has(e.id) ? '<span class="badge">today</span> ' : ""}${esc(e.subject ?? "(no subject)")}</span>
          <span class="who">${esc(fmtDate(e.received_at))}</span>
        </div>
        <div class="who">${esc(e.sender ?? "")}</div>
      </div>`,
    )
    .join("");
}

function renderLogs(data) {
  lastLogs = data;
  const { logs } = data;
  const el = $("logs");
  el.hidden = !activityExpanded;
  $("toggleActivity").setAttribute("aria-expanded", String(activityExpanded));
  if (!logs || !logs.length) {
    el.innerHTML = `<p class="empty">No activity logged yet — run a heartbeat tick.</p>`;
    return;
  }
  el.innerHTML = logs
    .map(
      (l) => `<div class="log ${esc(l.level)}">
        <span class="when">${esc(fmtTime(l.ts))}</span>
        <span class="src">${esc(l.source)}</span>
        <span class="msg">${esc(l.message)}</span>
      </div>`,
    )
    .join("");
}

function renderDecisions(data) {
  lastDecisions = data;
  const { decisions } = data;
  const el = $("decisions");
  el.hidden = !decisionsExpanded;
  $("toggleDecisions").setAttribute("aria-expanded", String(decisionsExpanded));
  if (!decisions.length) {
    el.innerHTML = `<p class="empty">No decisions logged yet.</p>`;
    return;
  }
  const icon = { track: "📦", skip: "⏭️", update: "🔄" };
  el.innerHTML = decisions
    .map(
      (d) => `<div class="decision">
        <div class="row">
          <span>${icon[d.action_taken] ?? "•"} <strong>${esc(d.action_taken)}</strong> — ${esc(d.agent_reasoning ?? "")}</span>
          <span class="when">${esc(fmtDate(d.timestamp))}</span>
        </div>
        ${d.outcome ? `<div class="out">→ ${esc(d.outcome)}</div>` : ""}
      </div>`,
    )
    .join("");
}

let editingFoodLogId = null;

function renderFoodLog(entries) {
  const el = $("foodLogTable");
  if (!entries.length) {
    el.innerHTML = `<p class="empty">Nothing logged yet today.</p>`;
    return;
  }
  el.innerHTML = `<table class="data">
    <thead><tr><th>Food</th><th>Weight (g)</th><th>Kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th><th></th></tr></thead>
    <tbody>${entries
      .map((e) => {
        if (editingFoodLogId === e.id) {
          return `<tr>
            <td>${esc(e.original || e.name)}</td>
            <td colspan="5">
              <form class="foodEditForm" data-id="${e.id}">
                <div class="form-grid">
                  <label>Weight (g) <input name="qty" type="number" step="any" value="${e.qty ?? ""}" required /></label>
                </div>
                <div class="form-actions">
                  <button type="submit" class="btn">Save</button>
                  <button type="button" class="btn foodEditCancel">Cancel</button>
                </div>
                <div class="err foodEditErr"></div>
              </form>
            </td>
          </tr>`;
        }
        return `<tr>
          <td>${esc(e.original || e.name)}</td>
          <td>${e.qty != null ? Math.round(e.qty) : "—"}</td>
          <td>${Math.round(e.kcal)}</td>
          <td>${round1(e.protein_g)}</td>
          <td>${round1(e.carbs_g)}</td>
          <td>${round1(e.fat_g)}</td>
          <td>
            <button class="btn foodEditBtn" data-id="${e.id}">Edit</button>
            <button class="btn danger foodDeleteBtn" data-id="${e.id}">Delete</button>
          </td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;

  el.querySelectorAll(".foodEditBtn").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingFoodLogId = Number(btn.dataset.id);
      refreshFoodLog();
    }),
  );
  el.querySelectorAll(".foodDeleteBtn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this food log entry? This cannot be undone.")) return;
      await fetch(`/api/food/${btn.dataset.id}`, { method: "DELETE" });
      refreshFoodLog();
      refreshFoodStats();
    }),
  );
  el.querySelectorAll(".foodEditForm").forEach((form) => {
    form.querySelector(".foodEditCancel").addEventListener("click", () => {
      editingFoodLogId = null;
      refreshFoodLog();
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const errEl = form.querySelector(".foodEditErr");
      errEl.textContent = "";
      const res = await fetch(`/api/food/${form.dataset.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qty: Number(fd.get("qty")) }),
      });
      if (!res.ok) {
        errEl.textContent = (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
        return;
      }
      editingFoodLogId = null;
      refreshFoodLog();
      refreshFoodStats();
    });
  });
}

async function refreshFoodLog() {
  try {
    const { entries } = await getJson("/api/food");
    renderFoodLog(entries);
  } catch (err) {
    console.error(err);
  }
}

function renderFoodStatsPanel(elId, totals) {
  $(elId).innerHTML = `<div class="kcal-big">${Math.round(totals.kcal)} <span class="goal">kcal</span></div>
    <div class="food-macros">${round1(totals.protein_g)} g P · ${round1(totals.carbs_g)} g C · ${round1(totals.fat_g)} g F</div>`;
}

async function refreshFoodStats() {
  try {
    const { lastDay, lastWeekAverage } = await getJson("/api/food/stats");
    renderFoodStatsPanel("lastDaySummary", lastDay);
    renderFoodStatsPanel("lastWeekAverage", lastWeekAverage);
  } catch (err) {
    console.error(err);
  }
}

let presetsCache = [];

// Mirrors matchPreset's exact-alias-match rule (src/nutrition/preset-match.ts): normalized equality
// against the preset's name or one of its aliases, never a substring/fuzzy match.
function clientMatchPreset(name) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) return undefined;
  return presetsCache.find(
    (p) => p.name.trim().toLowerCase() === needle || p.aliases.some((a) => a.trim().toLowerCase() === needle),
  );
}

function updateFoodCreateMacroFields() {
  const form = $("foodCreateForm");
  const name = form.elements.name.value;
  const qty = Number(form.elements.qty.value);
  const macroInputs = ["kcal", "protein_g", "carbs_g", "fat_g"].map((f) => form.elements[f]);
  const preset = clientMatchPreset(name);
  const hint = $("foodCreateMatchHint");

  if (preset) {
    const factor = qty > 0 ? qty / 100 : 0;
    form.elements.kcal.value = round1(preset.kcal * factor);
    form.elements.protein_g.value = round1(preset.protein_g * factor);
    form.elements.carbs_g.value = round1(preset.carbs_g * factor);
    form.elements.fat_g.value = round1(preset.fat_g * factor);
    macroInputs.forEach((el) => (el.disabled = true));
    hint.textContent = `Matches preset "${preset.name}" — macros auto-filled.`;
  } else {
    macroInputs.forEach((el) => (el.disabled = false));
    hint.textContent = name.trim() ? "No matching preset — enter macros for this weight yourself." : "";
  }
}

$("foodCreateForm").elements.name.addEventListener("input", updateFoodCreateMacroFields);
$("foodCreateForm").elements.qty.addEventListener("input", updateFoodCreateMacroFields);

$("foodCreateForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  const errEl = $("foodCreateErr");
  errEl.textContent = "";
  const name = String(fd.get("name") || "").trim();
  const qty = Number(fd.get("qty"));
  const matched = clientMatchPreset(name);
  const payload = matched
    ? { name, qty }
    : {
        name,
        qty,
        kcal: Number(fd.get("kcal")),
        protein_g: Number(fd.get("protein_g")),
        carbs_g: Number(fd.get("carbs_g")),
        fat_g: Number(fd.get("fat_g")),
      };
  const res = await fetch("/api/food", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    errEl.textContent = (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
    return;
  }
  form.reset();
  ["kcal", "protein_g", "carbs_g", "fat_g"].forEach((f) => (form.elements[f].disabled = false));
  $("foodCreateMatchHint").textContent = "";
  refreshFoodLog();
  refreshPresets();
  refreshFoodStats();
});

let editingPreset = null;

function renderPresets(presets) {
  const el = $("presetsTable");
  if (!presets.length) {
    el.innerHTML = `<p class="empty">No presets yet — add one below.</p>`;
    return;
  }
  el.innerHTML = `<table class="data">
    <thead><tr><th>Name</th><th>Aliases</th><th>Kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th><th></th></tr></thead>
    <tbody>${presets
      .map((p) => {
        if (editingPreset === p.name) {
          return `<tr>
            <td>${esc(p.name)}</td>
            <td colspan="6">
              <form class="presetEditForm" data-name="${esc(p.name)}">
                <div class="form-grid">
                  <label>Aliases <input name="aliases" value="${esc(p.aliases.join(", "))}" /></label>
                  <label>Kcal /100g <input name="kcal" type="number" step="any" value="${p.kcal}" required /></label>
                  <label>Protein g /100g <input name="protein_g" type="number" step="any" value="${p.protein_g}" required /></label>
                  <label>Carbs g /100g <input name="carbs_g" type="number" step="any" value="${p.carbs_g}" required /></label>
                  <label>Fat g /100g <input name="fat_g" type="number" step="any" value="${p.fat_g}" required /></label>
                </div>
                <div class="form-actions">
                  <button type="submit" class="btn">Save</button>
                  <button type="button" class="btn presetEditCancel">Cancel</button>
                </div>
                <div class="err presetEditErr"></div>
              </form>
            </td>
          </tr>`;
        }
        return `<tr>
          <td>${esc(p.name)}</td>
          <td>${esc(p.aliases.join(", "))}</td>
          <td>${p.kcal}</td>
          <td>${p.protein_g}</td>
          <td>${p.carbs_g}</td>
          <td>${p.fat_g}</td>
          <td>
            <button class="btn presetEditBtn" data-name="${esc(p.name)}">Edit</button>
            <button class="btn danger presetDeleteBtn" data-name="${esc(p.name)}">Delete</button>
          </td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;

  el.querySelectorAll(".presetEditBtn").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingPreset = btn.dataset.name;
      refreshPresets();
    }),
  );
  el.querySelectorAll(".presetDeleteBtn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete preset "${btn.dataset.name}"? This cannot be undone.`)) return;
      await fetch(`/api/presets/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" });
      refreshPresets();
    }),
  );
  el.querySelectorAll(".presetEditForm").forEach((form) => {
    form.querySelector(".presetEditCancel").addEventListener("click", () => {
      editingPreset = null;
      refreshPresets();
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const errEl = form.querySelector(".presetEditErr");
      errEl.textContent = "";
      const res = await fetch(`/api/presets/${encodeURIComponent(form.dataset.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aliases: String(fd.get("aliases") || "")
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
          kcal: Number(fd.get("kcal")),
          protein_g: Number(fd.get("protein_g")),
          carbs_g: Number(fd.get("carbs_g")),
          fat_g: Number(fd.get("fat_g")),
        }),
      });
      if (!res.ok) {
        errEl.textContent = (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
        return;
      }
      editingPreset = null;
      refreshPresets();
    });
  });
}

async function refreshPresets() {
  try {
    const { presets } = await getJson("/api/presets");
    presetsCache = presets;
    renderPresets(presets);
  } catch (err) {
    console.error(err);
  }
}

$("presetCreateForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  const errEl = $("presetCreateErr");
  errEl.textContent = "";
  const res = await fetch("/api/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: String(fd.get("name") || "").trim(),
      aliases: String(fd.get("aliases") || "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      kcal: Number(fd.get("kcal")),
      protein_g: Number(fd.get("protein_g")),
      carbs_g: Number(fd.get("carbs_g")),
      fat_g: Number(fd.get("fat_g")),
    }),
  });
  if (!res.ok) {
    errEl.textContent = (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
    return;
  }
  form.reset();
  refreshPresets();
});

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $("view-dashboard").hidden = tab.dataset.view !== "dashboard";
    $("view-food-data").hidden = tab.dataset.view !== "food-data";
    if (tab.dataset.view === "food-data") {
      refreshPresets();
      refreshFoodLog();
      refreshFoodStats();
    }
  }),
);

async function refresh() {
  try {
    const [parcels, summary, emails, food, decisions, status, logs] = await Promise.all([
      getJson(`/api/parcels?all=${showAll}`),
      getJson("/api/summary"),
      getJson("/api/emails"),
      getJson("/api/food"),
      getJson("/api/decisions?limit=25"),
      getJson("/api/status"),
      getJson("/api/logs?limit=40"),
    ]);
    renderSummary(summary);
    renderTodayEmails(emails);
    renderLogs(logs);
    renderTodayLine(food);
    renderNutrition(food);
    renderParcels(parcels);
    renderDecisions(decisions);
    $("lastScan").textContent = `Last scan: ${timeAgo(status.lastChecked)}`;
  } catch (err) {
    console.error(err);
  }
}

$("toggleAll").addEventListener("click", () => {
  showAll = !showAll;
  $("toggleAll").textContent = showAll ? "Show active" : "Show all";
  refresh();
});

$("toggleEmails").addEventListener("click", () => {
  emailsExpanded = !emailsExpanded;
  if (lastEmails) renderTodayEmails(lastEmails);
});

// Collapsible sections: the whole header row is the toggle (click or Enter/Space), for both
// opening and closing. The arrow is driven by the row's aria-expanded state (see CSS).
function bindSectionToggle(id, toggle) {
  const el = $(id);
  el.addEventListener("click", toggle);
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle();
    }
  });
}

bindSectionToggle("toggleFoods", () => {
  foodsExpanded = !foodsExpanded;
  if (lastFood) renderNutrition(lastFood);
});

window.addEventListener("resize", sizeFoodsScroll);

bindSectionToggle("toggleActivity", () => {
  activityExpanded = !activityExpanded;
  if (lastLogs) renderLogs(lastLogs);
});

bindSectionToggle("toggleDecisions", () => {
  decisionsExpanded = !decisionsExpanded;
  if (lastDecisions) renderDecisions(lastDecisions);
});

// Live updates: the server pushes `update` whenever the DB changes (external heartbeat/classify).
const stream = new EventSource("/api/stream");
stream.addEventListener("update", () => {
  refresh();
  if (!$("view-food-data").hidden) {
    refreshPresets();
    refreshFoodLog();
    refreshFoodStats();
  }
});
stream.onopen = () => $("liveDot").classList.add("live");
stream.onerror = () => $("liveDot").classList.remove("live");

refresh();
