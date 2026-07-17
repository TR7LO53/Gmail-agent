// Vanilla dashboard client. Fetches the read-only API and re-renders on SSE `update` events.
// No framework, no build step.

let showAll = false;

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

function meter(label, val, goal, unit) {
  const pct = goal > 0 ? Math.min(val / goal, 1) * 100 : 0;
  const over = val > goal;
  return `<div class="meter ${over ? "over" : ""}">
    <div class="lab"><span>${label}</span><span class="val">${val}/${goal} ${unit}${over ? " · over" : ""}</span></div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div>
  </div>`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

function renderNutrition({ entries, totals, goals }) {
  const el = $("food");
  const kover = totals.kcal > goals.kcal;
  const kpct = goals.kcal > 0 ? Math.min(totals.kcal / goals.kcal, 1) * 100 : 0;
  const kcalMeter = `<div class="meter ${kover ? "over" : ""}">
    <div class="lab">
      <span class="kcal-big">${Math.round(totals.kcal)} <span class="goal">/ ${goals.kcal} kcal</span></span>
      <span class="val">${kover ? "over goal" : ""}</span>
    </div>
    <div class="track"><div class="fill" style="width:${kpct}%"></div></div>
  </div>`;

  const macros =
    meter("Protein", round1(totals.protein_g), goals.protein_g, "g") +
    meter("Carbs", round1(totals.carbs_g), goals.carbs_g, "g") +
    meter("Fat", round1(totals.fat_g), goals.fat_g, "g");

  const foods = entries.length
    ? `<div class="foods">${entries
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

  el.innerHTML =
    kcalMeter + macros + `<h3 class="sub-h" style="margin:18px 0 8px">Foods</h3>` + foods;
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

function renderTodayEmails({ recent, today, counts, lastChecked }) {
  $("unreadCount").textContent = `${counts.unread} unread`;
  $("unreadCount").className = "badge" + (counts.unread > 0 ? " unread" : "");
  $("lastScanLine").textContent = `Last Gmail check: ${timeAgo(lastChecked)} · ${counts.today} new today · ${counts.unread} unread`;

  const list = recent && recent.length ? recent : today || [];
  const el = $("todayEmails");
  if (!list.length) {
    el.innerHTML = `<p class="empty">No emails seen yet — run a heartbeat scan to populate.</p>`;
    return;
  }
  const todayIds = new Set((today || []).map((e) => e.id));
  el.innerHTML = list
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

function renderLogs({ logs }) {
  const el = $("logs");
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

function renderDecisions({ decisions }) {
  const el = $("decisions");
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

// Live updates: the server pushes `update` whenever the DB changes (external heartbeat/classify).
const stream = new EventSource("/api/stream");
stream.addEventListener("update", refresh);
stream.onopen = () => $("liveDot").classList.add("live");
stream.onerror = () => $("liveDot").classList.remove("live");

refresh();
