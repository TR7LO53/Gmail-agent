# Stage 7 Implementation Guide — Activity logging, email visibility & the auth root cause

**Date:** 2026-07-09
**Status:** ✅ Complete — **133/133** tests, 0 TypeScript errors
**Prompted by:** "the email section isn't working" — turned out to be an expired Gmail token that the app was hiding.

---

## 1. What was actually wrong

The pipeline *was* running (DB had 55 emails, 32 decisions, 2 parcels, a fresh summary). Three issues combined:

1. **No activity log** — Gmail-search activity was only `console.log`'d; nothing persisted or shown.
2. **The email panel showed "today only"** — with no new mail it looked dead (but was accurate).
3. **Root cause (the real one): the Gmail OAuth token expired** — every search fails with `invalid_grant`. The classifier and inbox **early-returned silently**, and the tracker **swallowed** the failure (ran on stale data, reported "0 errors"). So nothing surfaced the auth break. The token died ~7 days after it was minted because the **OAuth consent screen is in "Testing" mode** (refresh tokens expire after 7 days).

## 2. What I built

**Activity log (new)** — `src/memory/logs.ts` (`logEvent`/`listRecentLogs`/`pruneLogs`) + a `logs` table. Instrumented the classifier, tracker, inbox, summary and heartbeat (via direct `deps.db` writes, like `recordDecision`). Every tick now records: Gmail search + result count, classifier/tracker/summary outcomes, and **errors**. `GET /api/logs`, SSE keyed on logs, and a new **"Activity"** panel on the dashboard.

**Auth-error visibility (the fix that matters)**
- `mapError` ([src/tools/errors.ts](gmail-agent/src/tools/errors.ts)) now recognises `invalid_grant` → "Gmail authorization expired… run `npm run auth`…".
- `runClassifier` and `refreshUnread` now **log an error** on search failure instead of returning silently — so an expired token shows as a red row in Activity.

**Tracker reliability** — OpenAI client now uses `maxRetries: 3, timeout: 30000` (the earlier "Connection error." was transient OpenAI network failures). Tracker exceptions now go to the **activity log**, not fake `update → error` **decisions** (decision history stays clean).

**Email section** — `/api/emails` now returns `recent` (last 15) + `lastChecked`; the panel shows recent mail (unread/today flagged) + a "last Gmail check" line, so it's never mysteriously empty.

## 3. Your job — reconnect Gmail (required)

The token is expired right now, so nothing updates until you re-auth:
```
cd gmail-agent
npm run auth        # opens the browser, re-grants read-only Gmail, saves a fresh token
```
Then restart Ggent (desktop button / `npm start`).

**Permanent fix (stop the weekly expiry):** Google Cloud Console → **APIs & Services → OAuth consent screen → Publish app → Production**. In Testing mode, refresh tokens die every 7 days — which is exactly what happened here.

## 4. Verify
- `npm run typecheck` → 0 errors; `npm test` → 133 passed.
- After `npm run auth`: `npm run try -- search --max 1` returns messages (not `invalid_grant`).
- `npm run heartbeat -- --once`* then open the dashboard → the **Activity** panel shows "Inbox scan → N", "Classified …", "Tracked …", "Daily summary …"; the email section lists recent mail. If auth ever breaks again, you'll see a red `gmail_search` error in Activity instead of silence.

> *Windows note: `npm run` swallows a trailing `--once` flag, which starts the 5-min **loop** instead of a single tick. Use `npx tsx src/cli.ts heartbeat --once` for a true one-shot, or just let the launcher run.
