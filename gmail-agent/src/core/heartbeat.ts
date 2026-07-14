import type { LLMProvider } from "../llm/provider.js";
import type { GmailClient } from "../gmail/client.js";
import type { DB } from "../memory/db.js";
import { getLastChecked, setLastChecked } from "../memory/meta.js";
import { runClassifier, type ClassifierSummary } from "../agents/classifier.js";
import { runTracker, generateDailySummary, type TrackerSummary } from "../agents/tracker.js";
import { refreshUnread } from "../agents/inbox.js";
import { logEvent, pruneLogs } from "../memory/logs.js";
import { ok, type ToolResponse } from "../tools/types.js";

/**
 * Stage 3 heartbeat — the proactivity loop. One tick runs the whole pipeline:
 *   classify new mail (deduped) -> track active parcels -> generate the daily summary
 * and records `last_checked` so the next tick only looks at mail since then.
 *
 * `startHeartbeat` adds the cadence with an `isRunning` flag so a slow tick never overlaps
 * the next one (course S05E04 / proposal section "Petla Heartbeat").
 */

export interface HeartbeatDeps {
  gmail?: GmailClient;
  llm: LLMProvider;
  db: DB;
}

export interface HeartbeatResult {
  ranAt: string;
  lastCheckedBefore?: string;
  classifier: ClassifierSummary;
  tracker: TrackerSummary;
  unread: number;
  summary: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO_CLASSIFIER: ClassifierSummary = {
  scanned: 0,
  tracked: 0,
  updated: 0,
  skipped: 0,
  deduped: 0,
  errors: 0,
};
const ZERO_TRACKER: TrackerSummary = { checked: 0, updated: 0, delivered: 0, errors: 0 };

export async function runHeartbeatTick(
  deps: HeartbeatDeps,
  opts: { maxEmails?: number } = {},
): Promise<ToolResponse<HeartbeatResult>> {
  const now = new Date();
  const lastChecked = getLastChecked(deps.db);

  // Look back to just before the previous run (with a one-day overlap for safety), or default to a
  // 7-day window on the very first run. Dedup-by-decisions handles any overlap cheaply.
  let days = 7;
  if (lastChecked) {
    const elapsedDays = Math.ceil((now.getTime() - new Date(lastChecked).getTime()) / DAY_MS) + 1;
    days = Math.min(Math.max(elapsedDays, 1), 30);
  }

  logEvent(deps.db, {
    source: "heartbeat",
    message: `Tick started (looking back ${days}d)`,
    data: { days, lastChecked: lastChecked ?? "(first run)" },
  });

  const classifier = await runClassifier(
    { days, maxEmails: opts.maxEmails ?? 25, skipProcessed: true },
    deps,
  );

  const tracker = await runTracker({}, deps);
  // Refresh the current unread set (cheap, metadata-only) before summarising.
  const unread = await refreshUnread({ gmail: deps.gmail, db: deps.db });
  const summary = await generateDailySummary({ llm: deps.llm, db: deps.db });

  setLastChecked(deps.db, now.toISOString());

  logEvent(deps.db, {
    source: "heartbeat",
    message: `Tick done — ${classifier.data?.tracked ?? 0} new parcels, ${tracker.data?.updated ?? 0} status updates, ${unread.data?.unread ?? 0} unread`,
    data: {
      classifierOk: classifier.success,
      trackerOk: tracker.success,
      unreadOk: unread.success,
    },
  });
  pruneLogs(deps.db);

  return ok<HeartbeatResult>(
    {
      ranAt: now.toISOString(),
      lastCheckedBefore: lastChecked,
      classifier: classifier.data ?? ZERO_CLASSIFIER,
      tracker: tracker.data ?? ZERO_TRACKER,
      unread: unread.data?.unread ?? 0,
      summary: summary.data?.summary ?? "",
    },
    {
      next_action: "Heartbeat tick complete. Parcels, unread and daily summary updated.",
      diagnostics: {
        days,
        lastCheckedBefore: lastChecked ?? "(first run)",
        classifierOk: classifier.success,
        trackerOk: tracker.success,
        unreadOk: unread.success,
      },
    },
  );
}

export interface HeartbeatHandle {
  stop: () => void;
}

export interface StartHeartbeatOpts {
  intervalMs?: number;
  maxEmails?: number;
  onTick?: (result: ToolResponse<HeartbeatResult>) => void;
  onError?: (err: unknown) => void;
}

export function startHeartbeat(deps: HeartbeatDeps, opts: StartHeartbeatOpts = {}): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  let isRunning = false;

  const tick = async (): Promise<void> => {
    if (isRunning) return; // never overlap a still-running tick
    isRunning = true;
    try {
      const result = await runHeartbeatTick(deps, { maxEmails: opts.maxEmails });
      opts.onTick?.(result);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      isRunning = false;
    }
  };

  void tick(); // run once immediately, then on the interval
  const handle = setInterval(() => void tick(), intervalMs);

  return { stop: () => clearInterval(handle) };
}
