import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import type { GmailClient } from "../gmail/client.js";
import type { DB } from "../memory/db.js";
import { upsertParcel, listActiveParcels, getParcel, type Parcel } from "../memory/parcels.js";
import { recordDecision } from "../memory/decisions.js";
import { logEvent } from "../memory/logs.js";
import { setMeta } from "../memory/meta.js";
import { listTodaysEmails, listUnread, startOfLocalDayIso } from "../memory/emails.js";
import { getObservation, recordObservation } from "../memory/observations.js";
import { gmailSearch } from "../tools/gmail-search.js";
import { gmailRead, type ReadData } from "../tools/gmail-read.js";
import { ok, fail, type ToolResponse } from "../tools/types.js";

/**
 * Agent 2 — the Tracker. Where the Classifier looks at one fresh email at a time, the Tracker
 * takes a *known* parcel and investigates it harder: it searches the WHOLE mailbox for the
 * tracking number (not just the recent window), reconstructs the timeline, and asks the LLM for
 * the authoritative current status. It also produces the daily summary.
 *
 * Read-only Gmail only — no carrier APIs (locked decision). Uses the same deps-injection and
 * ToolResponse envelope as the Classifier.
 */

// The Tracker may use a deeper model than the Classifier (optional seam). Falls back to the
// Classifier's model, then the project default, so nothing changes cost-wise unless opted in.
function trackerModel(): string {
  return process.env.OPENAI_TRACKER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-nano";
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const TrackerResultSchema = z.object({
  currentStatus: z.enum([
    "ordered",
    "shipped",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "unknown",
  ]),
  estimatedDelivery: z.string().optional(),
  summary: z.string(),
  isDelivered: z.boolean(),
});
export type TrackerResult = z.infer<typeof TrackerResultSchema>;

const TRACKER_SYSTEM = `You are a parcel status tracker. You are given everything known about ONE parcel:
its tracking number, carrier, the status history so far, and the text of the most recent related
emails found in the mailbox. Determine the single most up-to-date status and write a one-sentence
user-facing summary.

Rules:
- currentStatus must be the latest real state: ordered | shipped | in_transit | out_for_delivery | delivered | unknown.
- Never move a parcel backwards (e.g. delivered -> in_transit) unless the newest email clearly states it.
- estimatedDelivery: an ISO date if the emails mention one, otherwise omit it.
- isDelivered: true only if the parcel has actually been delivered or picked up.
- summary: one short, plain-language sentence for the user.`;

export const DailySummarySchema = z.object({ summary: z.string() });

const SUMMARY_SYSTEM = `You write a brief daily digest for the user. You are given the emails that
arrived today (with unread count) and the active parcels. Write 1-3 short, factual sentences in plain
language: how many new emails arrived (and how many are unread), what is arriving, what changed, and
anything needing attention. No fluff.`;

// ---------------------------------------------------------------------------
// Track a single parcel
// ---------------------------------------------------------------------------

export interface TrackerDeps {
  gmail?: GmailClient;
  llm: LLMProvider;
  db: DB;
}

export async function trackParcel(
  parcel: Parcel,
  deps: TrackerDeps,
): Promise<ToolResponse<TrackerResult>> {
  // 1. Find related emails across the whole mailbox by tracking number.
  let messages: Array<{ id: string; threadId: string }> = [];

  const byTracking = await gmailSearch(
    { query: parcel.tracking_number, maxResults: 10 },
    { gmail: deps.gmail },
  );
  if (byTracking.success && byTracking.data) {
    messages = byTracking.data.messages.map((m) => ({ id: m.id, threadId: m.threadId }));
  }

  // Fallback: the original thread that created this parcel.
  if (messages.length === 0 && parcel.thread_id) {
    messages = [{ id: parcel.thread_id, threadId: parcel.thread_id }];
  }

  if (messages.length === 0) {
    return fail(
      `No emails found for tracking number ${parcel.tracking_number}. Nothing new to track.`,
      { tracking_number: parcel.tracking_number },
    );
  }

  // 2. Read each unique thread (full bodies) and collect the text.
  const seenThreads = new Set<string>();
  const bodies: string[] = [];
  for (const m of messages.slice(0, 5)) {
    const tid = m.threadId || m.id;
    if (seenThreads.has(tid)) continue;
    seenThreads.add(tid);

    const read = await gmailRead({ id: tid, detail: "full" }, { gmail: deps.gmail });
    if (read.success && read.data) {
      const thread = read.data as ReadData;
      for (const tm of thread.messages) {
        bodies.push(
          [
            `From: ${tm.from ?? "?"}`,
            `Date: ${tm.date ?? "?"}`,
            `Subject: ${tm.subject ?? "?"}`,
            tm.body ?? tm.snippet ?? "",
          ].join("\n"),
        );
      }
    }
  }

  // 3. Ask the LLM for the authoritative status (deeper model via the optional seam).
  //    Observational Memory: feed the compact prior note so the model has continuity without us
  //    re-sending the full history each time.
  const priorNote = getObservation(deps.db, "parcel_note", parcel.tracking_number)?.content;
  const userText = [
    `Tracking number: ${parcel.tracking_number}`,
    `Carrier: ${parcel.carrier}`,
    `Status so far: ${parcel.status}`,
    `Known history: ${parcel.history.map((h) => `${h.status}@${h.date}`).join(", ") || "(none)"}`,
    priorNote ? `Prior note: ${priorNote}` : "",
    "",
    "Recent related emails:",
    bodies.join("\n---\n").slice(0, 6000),
  ]
    .filter(Boolean)
    .join("\n");

  const result = await deps.llm.extract(TrackerResultSchema, TRACKER_SYSTEM, userText, {
    model: trackerModel(),
  });

  // Store the refreshed compact note for next time (context compression).
  recordObservation(deps.db, {
    kind: "parcel_note",
    key: parcel.tracking_number,
    content: `${result.currentStatus}${result.estimatedDelivery ? ` (ETA ${result.estimatedDelivery})` : ""}: ${result.summary}`,
  });

  // 4. Persist. upsertParcel only appends history / bumps last_update when the status changed,
  //    so re-checking an unchanged parcel is idempotent. Only log a decision on a real change to
  //    keep the decisions log meaningful (the heartbeat re-checks every parcel on every tick).
  const changed = result.currentStatus !== parcel.status;
  const newestEmailId =
    messages[0]?.id ??
    parcel.history[parcel.history.length - 1]?.email_id ??
    parcel.tracking_number;

  upsertParcel(deps.db, {
    tracking_number: parcel.tracking_number,
    carrier: parcel.carrier,
    status: result.currentStatus,
    thread_id: parcel.thread_id,
    email_id: newestEmailId,
  });

  if (changed) {
    recordDecision(deps.db, {
      timestamp: new Date().toISOString(),
      email_id: newestEmailId,
      thread_id: parcel.thread_id,
      action_taken: "update",
      agent_reasoning: result.summary,
      outcome: `${parcel.carrier} ${parcel.tracking_number}: ${parcel.status} -> ${result.currentStatus}`,
    });
  }

  return ok(result, {
    next_action: changed
      ? "Status changed and was saved. Run `npm run try -- parcels` to view it."
      : "No status change since the last check.",
    diagnostics: {
      tracking_number: parcel.tracking_number,
      changed,
      emailsScanned: bodies.length,
      model: trackerModel(),
    },
  });
}

// ---------------------------------------------------------------------------
// Track all active parcels
// ---------------------------------------------------------------------------

export interface RunTrackerOpts {
  /** Track only this one parcel; otherwise every active (non-delivered) parcel. */
  trackingNumber?: string;
}

export interface TrackerSummary {
  checked: number;
  updated: number;
  delivered: number;
  errors: number;
}

export async function runTracker(
  opts: RunTrackerOpts,
  deps: TrackerDeps,
): Promise<ToolResponse<TrackerSummary>> {
  const parcels = opts.trackingNumber
    ? ([getParcel(deps.db, opts.trackingNumber)].filter(Boolean) as Parcel[])
    : listActiveParcels(deps.db);

  const summary: TrackerSummary = { checked: 0, updated: 0, delivered: 0, errors: 0 };

  for (const parcel of parcels) {
    summary.checked++;
    try {
      const r = await trackParcel(parcel, deps);
      if (r.success && r.data) {
        if (r.data.currentStatus !== parcel.status) summary.updated++;
        if (r.data.isDelivered) summary.delivered++;
      }
    } catch (err) {
      summary.errors++;
      // Log the error rather than writing a fake "update → error" decision (keeps the
      // decision history meaningful; the parcel is left unchanged).
      logEvent(deps.db, {
        source: "tracker",
        level: "error",
        message: `Tracking ${parcel.carrier} ${parcel.tracking_number} failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { tracking_number: parcel.tracking_number },
      });
    }
  }

  logEvent(deps.db, {
    source: "tracker",
    level: summary.errors > 0 ? "warn" : "info",
    message: `Tracked ${summary.checked} parcel(s): ${summary.updated} updated, ${summary.delivered} delivered, ${summary.errors} errors`,
    data: { ...summary },
  });

  return ok(summary, {
    next_action: "Run `npm run try -- parcels` to view updated statuses.",
    diagnostics: { parcels: parcels.length, model: trackerModel() },
  });
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

export async function generateDailySummary(
  deps: { llm: LLMProvider; db: DB },
): Promise<ToolResponse<{ summary: string }>> {
  const active = listActiveParcels(deps.db);
  const todays = listTodaysEmails(deps.db, startOfLocalDayIso());
  const unread = listUnread(deps.db);
  const now = new Date().toISOString();

  if (active.length === 0 && todays.length === 0 && unread.length === 0) {
    const text = "Nothing new today.";
    setMeta(deps.db, "daily_summary", text);
    setMeta(deps.db, "daily_summary_at", now);
    logEvent(deps.db, {
      source: "summary",
      message: "Daily summary: nothing new today",
      data: { activeParcels: 0, todaysEmails: 0, unread: 0 },
    });
    return ok({ summary: text }, { diagnostics: { activeParcels: 0, todaysEmails: 0, unread: 0 } });
  }

  const userText = [
    `New emails today: ${todays.length} (${unread.length} unread)`,
    ...todays.slice(0, 20).map((e) => `- ${e.is_unread ? "[unread] " : ""}${e.sender ?? "?"}: ${e.subject ?? "(no subject)"}`),
    "",
    "Active parcels:",
    ...active.map((p) => `- ${p.carrier} ${p.tracking_number}: ${p.status} (updated ${p.last_update})`),
  ].join("\n");

  const result = await deps.llm.extract(DailySummarySchema, SUMMARY_SYSTEM, userText, {
    model: trackerModel(),
  });

  setMeta(deps.db, "daily_summary", result.summary);
  setMeta(deps.db, "daily_summary_at", now);
  logEvent(deps.db, {
    source: "summary",
    message: `Daily summary generated (${active.length} parcels, ${todays.length} new emails, ${unread.length} unread)`,
    data: { activeParcels: active.length, todaysEmails: todays.length, unread: unread.length },
  });

  return ok(result, {
    diagnostics: {
      activeParcels: active.length,
      todaysEmails: todays.length,
      unread: unread.length,
      model: trackerModel(),
    },
  });
}
