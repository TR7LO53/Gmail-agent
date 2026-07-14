# Stage 4 Implementation Guide — Web Dashboard (Express + SSE)

**Date:** 2026-07-01
**Builds on:** Stage 1 (Gmail tools), Stage 2 (Classifier + SQLite), Stage 3 (Heartbeat + Tracker)
**Status:** ✅ Complete — **85/85** unit+integration tests passing · 0 TypeScript errors · server verified live
**Scope locked to:** a read-only browser dashboard. Deferred: ETA persistence, CSV export (a later polish pass).

---

## 1. Why this stage exists

Everything so far was CLI/JSON only. Your original brief (#11) asked for a **simple web interface** showing a summary of incoming mail and parcel statuses. Stage 4 delivers the proposal's wireframe: **active parcels**, a **daily summary**, and **decision history**, updating **live** — with no frontend framework.

Two deliberate design choices (your call):
- **Pure viewer.** The server never scans, never touches Gmail or OpenAI. It only *reads* the SQLite DB. All the actual work stays in the separately-run `npm run heartbeat` (or `classify`/`track`).
- **Live without scanning.** Since the server doesn't run the heartbeat, it can't "know" when new data arrives by doing the work itself. Instead it **polls a cheap change-signature** of the DB every 2.5 s and pushes an SSE `update` only when something actually changed. The browser then refetches. This keeps the server strictly read-only while still auto-refreshing.

---

## 2. What I built (your code)

### New files
| File | What it does |
|---|---|
| `src/ui/sse.ts` | `SseBroadcaster` (fan-out of Server-Sent Events to all open browsers) + `getDashboardSignature(db)` (the cheap change token). |
| `src/ui/app.ts` | `createApp({ db, broadcaster })` — the Express app (DI so tests inject a seeded in-memory DB). All routes are read-only. |
| `src/ui/server.ts` | Standalone entry (like `mcp/server.ts`): opens the DB, starts the change-poller, listens on `127.0.0.1:PORT`. |
| `src/ui/public/index.html` | Dashboard markup + CSS (dark theme, no framework). |
| `src/ui/public/app.js` | Vanilla JS: fetches the API, renders the three sections, re-renders on SSE `update`. |

### Changed
| File | Change |
|---|---|
| `package.json` | Added `express` + `@types/express`; `"serve"` script; bumped to `0.4.0`. |

### HTTP API (all read-only, JSON)
| Route | Returns |
|---|---|
| `GET /api/parcels?all=true\|false` | `{ all, count, parcels }` — active (default) or all, via `listActiveParcels`/`listAllParcels` |
| `GET /api/summary` | `{ summary, generatedAt }` from `meta.daily_summary` |
| `GET /api/decisions?limit=` | `{ decisions }` (limit capped at 200, default 20) |
| `GET /api/status` | `{ lastChecked, serverTime }` |
| `GET /api/stream` | SSE stream; emits `update` on DB change |
| `GET /` (+ static) | the dashboard |

### Design rules kept
- **Read-only end to end** — the web layer touches neither Gmail nor OpenAI, and only reads the DB.
- **Module-anchored paths** — static files served from a path resolved off the module location, never `process.cwd()` (the MCP cwd auth bug), so it runs from any launch directory.
- **`node:sqlite` WAL** already allows a concurrent reader while the heartbeat process writes — no locking issues.
- **DI + testability** — `createApp` takes its DB, so the whole HTTP surface is tested over an in-memory DB with no network to Google/OpenAI.
- No new tools, no new scopes, localhost-only bind.

---

## 3. Your job

1. **Deps are installed** (`express`, `@types/express`) — nothing to do unless you clone fresh (`npm install`).
2. **Seed data first** so the dashboard isn't empty:
   ```powershell
   npm run heartbeat -- --once     # or: npm run classify
   ```
3. **Run the dashboard:**
   ```powershell
   npm run serve                   # http://localhost:3000
   $env:PORT="4000"; npm run serve # custom port
   ```
   Open the URL in your browser.
4. **See it live:** keep the browser open and, in a **second terminal**, run `npm run heartbeat`. The parcels / summary / decisions refresh on their own (watch the green "live" dot top-right).
5. Layout or wording tweaks are easy — everything is in `src/ui/public/index.html` (styles) and `app.js` (rendering). That's styling, not architecture; tell me what you want changed.

> Run the heartbeat as a **separate process** for automation. The dashboard only watches the DB; it will not scan on its own by design.

---

## 4. Testing

### Automated
```powershell
npm run typecheck     # expect: 0 errors
npm test              # expect: 85 passed (unit + integration, no network)
```

New coverage:
| Suite | Tests | Verifies |
|---|---|---|
| `tests/unit/sse.test.ts` | 8 | broadcaster greet/broadcast frame format/remove/drop-dead-client; `getDashboardSignature` changes on new decision, parcel update, and `last_checked` advance |
| `tests/integration/ui.test.ts` | 7 | app on an ephemeral port hit with `fetch`: `/api/parcels` active-vs-`all`, `/api/summary`, `/api/decisions?limit=`, `/api/status`, `/` serves HTML, unknown path → 404 |

### Manual (live)
1. `npm run serve` → console prints the URL; `GET /` renders the dashboard.
2. `curl http://localhost:3000/api/parcels` (etc.) → JSON matching your DB.
3. With the page open, run `npm run heartbeat -- --once` in another terminal → the dashboard updates within ~3 s (SSE), and the "live" dot is green.

Verified during build: server starts, all four `/api/*` endpoints respond, and `/` serves the HTML (checked on a scratch port).

---

## 5. What's next (Stage 5 preview)
Observational Memory + model/prompt optimization (Promptfoo), and the small polish items parked here: persist **estimated delivery** as a `parcels` column so the dashboard can show "Est. delivery", and a **decisions CSV export** endpoint.
