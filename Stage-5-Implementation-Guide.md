# Stage 5 Implementation Guide — Ggent: inbox awareness, Observational Memory & eval

**Date:** 2026-07-01
**Builds on:** Stages 1–4
**Status:** ✅ Complete — **96/96** unit+integration tests passing · 0 TypeScript errors · dashboard + endpoints verified live
**New dev dep:** `promptfoo` (eval only). No new runtime deps.

---

## 1. Why this stage exists

Four things you asked for, plus the roadmap's Observational Memory + evaluation:

1. **Rename** to **Ggent** in the web UI.
2. **"Today" is now the hero section** at the top: a factual list of today's emails (unread flagged) **and** parcels, with a short LLM narrative on top.
3. **Time was wrong** (showed 15:44 while your clock said 17:52). That was a **display** bug — timestamps are stored as UTC and were rendered raw. Now rendered in your **local** timezone. Stored data was always correct.
4. **Unread emails were invisible.** Ggent ignored non-parcel mail. It now records every email it sees and takes a **fresh unread snapshot every heartbeat tick**, so your 2 unread emails show up (and disappear once you read them).
5. **Observational Memory** — the agents now accumulate durable, compressed learnings.
6. **Promptfoo eval** — labeled cases + `npm run eval` to compare prompts/models.

---

## 2. What I built

### New files
| File | Purpose |
|---|---|
| `src/memory/emails.ts` | Records every observed email; `listTodaysEmails`, `listUnread`, `applyUnreadSnapshot`, `startOfLocalDayIso`. |
| `src/memory/observations.ts` | Observational Memory store: `recordObservation`/`getObservation`/`listRecentObservations` (`sender_carrier`, `parcel_note`). |
| `src/agents/inbox.ts` | `refreshUnread` — cheap metadata-only `is:unread` search → snapshot (no LLM). |
| `eval/promptfooconfig.yaml`, `eval/classifier.prompt.json`, `eval/cases.csv` | The evaluation harness. |

### Changed
| File | Change |
|---|---|
| `src/memory/db.ts` | Two additive tables: `emails`, `observations`. |
| `src/tools/gmail-search.ts` | Row now includes `internalDate` (clean received timestamp). |
| `src/agents/classifier.ts` | Records **every** scanned email (parcel or not); reads a sender→carrier hint into the prompt; learns the mapping from confident results. |
| `src/agents/tracker.ts` | Daily summary now covers **today's emails + parcels**; keeps a per-parcel `parcel_note` and feeds it back next time (context compression). |
| `src/core/heartbeat.ts` | Tick now also runs `refreshUnread`; result carries `unread`. |
| `src/ui/app.ts` | New `GET /api/emails` and `GET /api/observations`. |
| `src/ui/sse.ts` | Change-signature also keys on emails (so unread/today changes push SSE). |
| `src/ui/public/*` | Renamed to Ggent; **Today** moved to top with unread badges; timestamps rendered local. |
| `src/cli.ts` | Local-time formatting; new `inbox` command. |
| `package.json` | `eval` script; `promptfoo` dev dep; still `0.4.0` line bumped as needed. |

### How Observational Memory works here
- **sender_carrier**: after a confident parcel classification, Ggent stores "emails from `<domain>` are usually `<carrier>`" and feeds it as a hint next time — helps a cheap model and speeds convergence.
- **parcel_note**: the Tracker stores a one-line compressed understanding per parcel and passes it back on the next check instead of re-sending full history — smaller prompts, the real point of the technique.

### Design rules kept
Read-only Gmail (unread snapshot is a metadata-only search); server stays a **pure viewer** (all new data gathered by the heartbeat, stored in SQLite, only read by the web layer); additive schema; module-anchored paths; DI + `ToolResponse`.

---

## 3. Your job

1. Deps are installed (`promptfoo`). Nothing to do unless cloning fresh (`npm install`).
2. Populate data: `npm run heartbeat -- --once` (or run `npm run heartbeat`).
3. `npm run serve` → open the dashboard. Verify:
   - Header says **Ggent**.
   - **Today** is the top section; your **2 unread** emails appear with red "unread" badges; the unread count shows.
   - Timestamps are **local** (17:xx, not 15:xx).
4. CLI check: `npm run try -- inbox` lists today's + unread mail.
5. Optional model tuning: `npm run eval` (needs `OPENAI_API_KEY`) → prints a pass/score table comparing `gpt-4.1-nano` vs `gpt-4o-mini` on the labeled cases. If a model does well, set `OPENAI_MODEL` accordingly. Add rows to `eval/cases.csv` from your real mail to grow the test set.
6. Tell me if the "Today" wording/order wants tweaks — styling, not architecture.

---

## 4. Testing

### Automated
```powershell
npm run typecheck     # 0 errors
npm test              # 96 passed (unit + integration, no network)
```

New/updated coverage:
| Suite | Verifies |
|---|---|
| `tests/unit/emails.test.ts` | upsert (first_seen preserved), today filter by local day, unread list, `applyUnreadSnapshot` clears stale flags, `is_parcel` sticky |
| `tests/unit/observations.test.ts` | upsert-by-(kind,key), no duplicates, kinds kept separate |
| `tests/integration/classifier.test.ts` | records parcel **and** non-parcel emails; learns `sender_carrier` |
| `tests/integration/tracker.test.ts` | reuses a stored `parcel_note` and refreshes it |
| `tests/integration/heartbeat.test.ts` | tick runs `refreshUnread`; `unread` reflected |
| `tests/integration/ui.test.ts` | `/api/emails` today/unread/counts; title is "Ggent" |

### Manual
- `npm run heartbeat -- --once` then `curl http://localhost:3000/api/emails` → `counts.unread` matches your inbox.
- `npm run eval` → model-comparison table (real API).

Verified during build: dashboard serves with the Ggent name + Today section; `/api/emails` and `/api/observations` respond; `promptfoo` CLI runs (v0.121.17).

---

## 5. Notes / still deferred
- **ETA & CSV export** (parked since Stage 4) are still not done — `parcel_note` now surfaces ETA in the note text, but there is no dedicated `estimated_delivery` parcels column yet.
- Unread accuracy depends on the heartbeat running; the pure-viewer dashboard reflects the last snapshot.
