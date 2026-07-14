# Stage 3 Implementation Guide — Heartbeat + Agent Tracker

**Date:** 2026-06-30
**Builds on:** Stage 1 (Gmail tools + OAuth), Stage 2 (Classifier + SQLite)
**Status:** ✅ Complete — **70/70** unit+integration tests passing · 0 TypeScript errors · CLI loads
**Scope locked to:** Heartbeat loop, Tracker agent, deduplication, daily summary. Web UI is Stage 4.

---

## 1. Why this stage exists

After Stage 2 the agent was **passive**: it scanned email only when you ran `npm run classify`, it knew each parcel only from the single email that created it, and re-running `classify` re-processed the same messages. Stage 3 closes three gaps:

1. **Proactivity** — a heartbeat re-runs the pipeline automatically on a cadence (the original goal: "co kilka minut sprawdza pocztę").
2. **Depth** — a second agent (the Tracker) investigates a *known* parcel across the whole mailbox, not just the recent window, and decides its authoritative status.
3. **No wasted work** — emails already processed are skipped via the `decisions` table; progress is remembered in the `meta` table.

It also produces the first automatic **daily summary** — the text Stage 4's dashboard will display.

---

## 2. What I built (your code)

### New files
| File | What it does |
|---|---|
| `src/memory/meta.ts` | `getMeta` / `setMeta` + `getLastChecked` / `setLastChecked` over the existing `meta` table. No schema change. |
| `src/agents/tracker.ts` | **Agent 2.** `trackParcel`, `runTracker`, `generateDailySummary`, `TrackerResultSchema`. |
| `src/core/heartbeat.ts` | `runHeartbeatTick` (one cycle) + `startHeartbeat` (the loop with overlap guard). |

### Changed files
| File | Change |
|---|---|
| `src/memory/decisions.ts` | Added `getProcessedEmailIds(db)` (the dedup source); widened `action_taken` to `"track" \| "skip" \| "update"`. |
| `src/agents/classifier.ts` | Added `skipProcessed` option (default **on**) + a `deduped` counter; skips already-seen emails before any LLM/read call. |
| `src/llm/provider.ts` | `extract()` gained an optional 4th arg `{ model? }` — the seam that lets the Tracker use a deeper model. Backward compatible. |
| `src/cli.ts` | New commands: `track`, `summary`, `heartbeat`. |
| `package.json` | Scripts `track`, `heartbeat`; bumped to `0.3.0`. |
| `.env.example` | Documents `OPENAI_API_KEY`, `OPENAI_MODEL`, and the optional `OPENAI_TRACKER_MODEL`. |

### How the two agents differ
- **Classifier (Agent 1):** reads each *fresh* email once → "is this a parcel? what's the tracking number/status?" → creates/updates a parcel row. One LLM call per email.
- **Tracker (Agent 2):** takes a *known* parcel → searches the **whole mailbox** for its tracking number → reads the related thread(s) → reconstructs the timeline → returns the single authoritative status + a one-sentence summary + an `isDelivered` flag. It never moves a parcel backwards and only logs a `decision` when the status actually changes (so the heartbeat doesn't spam the log).

### How the heartbeat works
`runHeartbeatTick` runs, in order: **classify** new mail (deduped) → **track** every active parcel → **generate** the daily summary → write `meta.last_checked`. `startHeartbeat` calls it once immediately, then every N minutes, with an `isRunning` flag so a slow tick never overlaps the next (per course S05E04). `Ctrl+C` stops it cleanly.

### Design rules kept (from the locked decisions)
- Still **read-only** Gmail — Tracker uses only `gmail_search` / `gmail_read`, **no carrier APIs**, no new scopes, no new runtime deps.
- Same `deps`-injection and `ToolResponse` envelope everywhere.
- `node:sqlite` untouched; the `meta` table was already provisioned for exactly this.
- Secrets stay in `.env`. No write tools added.

---

## 3. Your job

### One-time / config
1. **`.env`** (in `gmail-agent/`): confirm `OPENAI_API_KEY` and `OPENAI_MODEL` are set. *Optional:* add `OPENAI_TRACKER_MODEL=gpt-4.1` (or another stronger model) to give the Tracker deeper reasoning. Leave it out to keep one model — nothing breaks. See `.env.example`.
2. You already ran `npm run auth` in Stage 1; the token is reused. No re-auth needed.

### Decide the cadence
- Default heartbeat interval is **5 minutes**. Override with `--interval <minutes>`.
- `--max <n>` caps how many emails each tick classifies (default 25).

### Run it
```powershell
npm run classify                 # (if needed) seed parcels first
npm run track                    # deeper status refresh of active parcels
npm run try -- summary           # read the generated daily digest
npm run heartbeat -- --once      # one full automatic tick, then exit
npm run heartbeat                # start the 5-min loop; Ctrl+C to stop
npm run heartbeat -- --interval 10   # custom cadence
```

### Watch for / tell me
- If a parcel's **status looks wrong** or the **summary reads oddly** → that's prompt tuning (the `TRACKER_SYSTEM` / `SUMMARY_SYSTEM` strings in `src/agents/tracker.ts`), not architecture. Tell me and I'll adjust.
- If the Tracker is **too chatty/expensive**, lower the cadence or set a cheaper `OPENAI_TRACKER_MODEL`.

---

## 4. Testing

### Automated (run these)
```powershell
npm run typecheck     # expect: 0 errors
npm test              # expect: 70 passed (unit + integration, no network, free)
npm run test:e2e      # optional: real OpenAI + inbox (auto-skips without key/token)
```

What the new tests cover:
| Suite | Tests | Verifies |
|---|---|---|
| `tests/unit/meta.test.ts` | 4 | get/set, overwrite, missing key, `last_checked` round-trip |
| `tests/unit/tracker-schema.test.ts` | 5 | `TrackerResultSchema` / `DailySummarySchema` validation + enum rejection |
| `tests/unit/decisions.test.ts` (+2) | 6 | `getProcessedEmailIds` distinct set; `update` action accepted |
| `tests/integration/tracker.test.ts` | 5 | status advance + history append + `update` decision; no-change is idempotent (no decision, no history growth); no-emails fails gracefully; LLM error counted; single-parcel mode |
| `tests/integration/classifier.test.ts` (+2) | 7 | dedup skips a re-seen email with **zero** LLM calls; `skipProcessed:false` re-processes |
| `tests/integration/heartbeat.test.ts` | 2 | one tick classifies→tracks→summarises→writes `last_checked`; second tick deduplicates |
| `tests/e2e/heartbeat.e2e.test.ts` | 1 | real single tick completes + records `last_checked` (skipped without creds) |

### Manual end-to-end (live mailbox)
1. `npm run heartbeat -- --once` → returns a combined `ToolResponse` with `classifier`, `tracker`, and `summary` sections.
2. Run `npm run heartbeat -- --once` **again** → the `classifier.deduped` count should be > 0 and `scanned` near 0 (no re-processing); `meta.last_checked` advances.
3. `npm run try -- parcels` → tracker-driven status changes show up in each parcel's `history` line.
4. `npm run try -- decisions` → look for `update` rows where a status actually changed.
5. `npm run heartbeat` → confirm it ticks on the interval, then `Ctrl+C` stops it cleanly.

### Known limitation (by design, for Stage 4)
`estimatedDelivery` is produced by the Tracker and used in the summary, but **not persisted** as a parcel column (no schema migration this stage). Add the column with the Web UI in Stage 4 if you want it on the dashboard.

---

## 5. What's next (Stage 4 preview)
Express + SSE dashboard rendering: active parcels, the `meta.daily_summary`, and the decision history — all of which Stage 3 now produces and stores.
