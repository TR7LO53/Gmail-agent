import type { LLMProvider } from "../llm/provider.js";
import type { GmailClient } from "../gmail/client.js";
import type { DB } from "../memory/db.js";
import { completeClassifierScan, getClassifierScan, getLastChecked, getMeta, saveClassifierScan } from "../memory/meta.js";
import { getEmailDecisionStates } from "../memory/decisions.js";
import { classifierSearchDate, runClassifier, type ClassifierSummary } from "../agents/classifier.js";
import { runTracker, generateDailySummary, type TrackerSummary } from "../agents/tracker.js";
import { refreshUnread } from "../agents/inbox.js";
import { runNews, newsModel, type NewsRunSummary } from "../agents/news.js";
import { logEvent, pruneLogs, type LogSource } from "../memory/logs.js";
import { fail, ok, type ToolResponse } from "../tools/types.js";

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
  news: NewsRunSummary;
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
function zeroNews(): NewsRunSummary {
  return {
    found: 0,
    eligible: 0,
    skipped: 0,
    processed: 0,
    notAnIssue: 0,
    pending: 0,
    failed: 0,
    errors: 0,
    model: newsModel(),
  };
}

async function runStep<T>(
  db: DB, source: LogSource, run: () => Promise<ToolResponse<T>>,
): Promise<ToolResponse<T>> {
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logEvent(db, { source, level: "error", message: `${source} failed: ${reason}` });
    return fail(reason);
  }
}

export async function runHeartbeatTick(
  deps: HeartbeatDeps,
  opts: { maxEmails?: number } = {},
): Promise<ToolResponse<HeartbeatResult>> {
  const now = new Date();
  const ranAt = now.toISOString();
  let lastChecked: string | undefined;
  let days = 7;
  let after: string | undefined;
  let startedAt = ranAt;
  logEvent(deps.db, { source: "heartbeat", message: "Tick started" });

  const classifier = await runStep(deps.db, "classifier", async () => {
    lastChecked = getLastChecked(deps.db);
    // Overlap the previous scan by one day. The first scan normally looks back seven days.
    if (lastChecked) {
      const elapsedDays = Math.ceil((now.getTime() - Date.parse(lastChecked)) / DAY_MS) + 1;
      days = Math.min(Math.max(elapsedDays, 1), 30);
    }
    const currentAfter = classifierSearchDate(now, days);
    const unfinishedScan = getClassifierScan(deps.db);
    after = unfinishedScan && unfinishedScan.after < currentAfter ? unfinishedScan.after : currentAfter;
    startedAt = unfinishedScan?.startedAt ?? ranAt;
    if (unfinishedScan?.after !== after) saveClassifierScan(deps.db, { after, startedAt });
    return runClassifier({ days, after, maxEmails: opts.maxEmails ?? 25, skipProcessed: true }, deps);
  });
  const tracker = await runStep(deps.db, "tracker", () => runTracker({}, deps));
  // Refresh the current unread set (cheap, metadata-only) before summarising.
  const unread = await runStep(deps.db, "inbox", () => refreshUnread(deps));
  const summary = await runStep(deps.db, "summary", () => generateDailySummary(deps));
  const news = await runStep(deps.db, "news", () => runNews(deps));

  const scanCheckpoint = classifier.success && await runStep(deps.db, "classifier", async () => {
    // Tracker may have resolved an email after its classification failed.
    const retryPending = [...getEmailDecisionStates(deps.db).values()].some(
      (state) => state.retryPending && state.lastClassificationError && state.lastClassificationError >= startedAt,
    );
    if (!retryPending) completeClassifierScan(deps.db, ranAt);
    return ok(undefined);
  });

  const flags = {
    classifierOk: scanCheckpoint !== false && scanCheckpoint.success && (classifier.data?.errors ?? 0) === 0,
    trackerOk: tracker.success && (tracker.data?.errors ?? 0) === 0,
    unreadOk: unread.success,
    summaryOk: summary.success,
    newsOk: news.success && (news.data?.errors ?? 0) === 0 && !news.data?.searchError,
  };
  logEvent(deps.db, {
    source: "heartbeat",
    level: Object.values(flags).every(Boolean) ? "info" : "warn",
    message: `Tick done — ${classifier.data?.tracked ?? 0} new parcels, ${tracker.data?.updated ?? 0} status updates, ${unread.data?.unread ?? 0} unread`,
    data: flags,
  });
  pruneLogs(deps.db);

  return ok<HeartbeatResult>(
    {
      ranAt,
      lastCheckedBefore: lastChecked,
      classifier: classifier.data ?? ZERO_CLASSIFIER,
      tracker: tracker.data ?? ZERO_TRACKER,
      unread: unread.data?.unread ?? 0,
      summary: summary.data?.summary ?? getMeta(deps.db, "daily_summary") ?? "",
      news: news.data ?? { ...zeroNews(), errors: news.success ? 0 : 1 },
    },
    {
      next_action: "Heartbeat tick complete. Open Activity for stage results.",
      diagnostics: {
        days,
        after,
        lastCheckedBefore: lastChecked ?? "(first run)",
        ...flags,
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
