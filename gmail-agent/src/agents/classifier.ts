import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import type { GmailClient } from "../gmail/client.js";
import type { DB } from "../memory/db.js";
import { upsertParcel } from "../memory/parcels.js";
import { recordDecision, getProcessedEmailIds } from "../memory/decisions.js";
import { logEvent } from "../memory/logs.js";
import { upsertEmail } from "../memory/emails.js";
import { getObservation, recordObservation } from "../memory/observations.js";
import { gmailSearch } from "../tools/gmail-search.js";
import { gmailRead, type ReadData } from "../tools/gmail-read.js";
import { ok, type ToolResponse } from "../tools/types.js";
import { trackedCategory } from "../config.js";

// ---------------------------------------------------------------------------
// Classification schema returned by the model
// ---------------------------------------------------------------------------

export const ClassificationSchema = z.object({
  isParcelRelated: z.boolean(),
  trackingNumber: z.string().optional(),
  carrier: z
    .enum(["DHL", "DPD", "InPost", "UPS", "GLS", "FedEx", "Poczta Polska", "Amazon", "Allegro", "other"])
    .optional(),
  status: z
    .enum(["ordered", "shipped", "in_transit", "out_for_delivery", "delivered", "unknown"])
    .optional(),
  estimatedDelivery: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a parcel email classifier. Your only job is to read one email and return a structured JSON object.

Identify emails about:
- Order confirmations (Amazon, Allegro, online shops)
- Courier notifications (DHL, DPD, InPost, UPS, GLS, FedEx, Poczta Polska)
- Shipping updates and delivery notifications

If the email is about a shipment, extract:
- trackingNumber: the parcel tracking/reference number (exact string from the email)
- carrier: one of DHL, DPD, InPost, UPS, GLS, FedEx, Poczta Polska, Amazon, Allegro, other
- status: ordered | shipped | in_transit | out_for_delivery | delivered | unknown
- estimatedDelivery: date string if mentioned (ISO format preferred)

If the email is NOT about a shipment, set isParcelRelated to false.
Always set confidence (0.0–1.0) and a short reasoning (one sentence).`;

// ---------------------------------------------------------------------------
// Single-email classification
// ---------------------------------------------------------------------------

export interface ClassifyEmailInput {
  emailId: string;
  threadId?: string;
  subject?: string;
  from?: string;
  body: string;
  /** Optional prior learning (e.g. "emails from dhl.com are usually DHL") from Observational Memory. */
  hint?: string;
}

export async function classifyEmail(
  input: ClassifyEmailInput,
  deps: { llm: LLMProvider },
): Promise<Classification> {
  const userText = [
    input.hint ? `Prior knowledge: ${input.hint}` : "",
    `From: ${input.from ?? "unknown"}`,
    `Subject: ${input.subject ?? "(no subject)"}`,
    "",
    input.body.slice(0, 3000),
  ]
    .filter(Boolean)
    .join("\n");

  return deps.llm.extract(ClassificationSchema, SYSTEM_PROMPT, userText);
}

/** Extract the lowercase domain from a From header like `DHL <noreply@dhl.com>`. */
export function senderDomain(from?: string): string | undefined {
  if (!from) return undefined;
  const email = from.match(/[^<>\s@]+@[^<>\s]+/)?.[0];
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Full classifier run
// ---------------------------------------------------------------------------

export interface RunClassifierOpts {
  days?: number;
  maxEmails?: number;
  unreadOnly?: boolean;
  /** Skip emails that already have a decision logged (default true). The heartbeat relies on this. */
  skipProcessed?: boolean;
}

export interface ClassifierSummary {
  scanned: number;
  tracked: number;
  updated: number;
  skipped: number;
  /** Emails skipped because they were already processed in an earlier run. */
  deduped: number;
  errors: number;
}

export async function runClassifier(
  opts: RunClassifierOpts = {},
  deps: { gmail?: GmailClient; llm: LLMProvider; db: DB },
): Promise<ToolResponse<ClassifierSummary>> {
  const days = opts.days ?? 7;
  const maxEmails = opts.maxEmails ?? 20;

  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "/");

  const searchResult = await gmailSearch(
    { after, maxResults: maxEmails, isUnread: opts.unreadOnly, category: trackedCategory() },
    { gmail: deps.gmail },
  );

  if (!searchResult.success || !searchResult.data) {
    logEvent(deps.db, {
      source: "gmail_search",
      level: "error",
      message: `Inbox scan failed: ${searchResult.recovery ?? "unknown error"}`,
      data: { ...searchResult.diagnostics },
    });
    return {
      success: false,
      recovery: searchResult.recovery ?? "Gmail search failed.",
      diagnostics: searchResult.diagnostics,
    };
  }

  const messages = searchResult.data.messages;
  logEvent(deps.db, {
    source: "gmail_search",
    message: `Inbox scan → ${messages.length} message(s)`,
    data: { ...searchResult.diagnostics, category: trackedCategory() ?? "all", after },
  });
  const summary: ClassifierSummary = { scanned: 0, tracked: 0, updated: 0, skipped: 0, deduped: 0, errors: 0 };
  const now = new Date().toISOString();

  const skipProcessed = opts.skipProcessed ?? true;
  const processed = skipProcessed ? getProcessedEmailIds(deps.db) : new Set<string>();

  for (const msg of messages) {
    if (processed.has(msg.id)) {
      summary.deduped++;
      continue;
    }
    summary.scanned++;

    let body = "";
    try {
      const readResult = await gmailRead({ id: msg.id, detail: "full" }, { gmail: deps.gmail });
      if (readResult.success && readResult.data) {
        const thread = readResult.data as ReadData;
        body = thread.messages
          .map((m) => m.body ?? m.snippet ?? "")
          .join("\n---\n")
          .slice(0, 3000);
      }
    } catch {
      // fall through with empty body — classifier can still use subject/from
    }

    const domain = senderDomain(msg.from);
    const hint =
      domain && getObservation(deps.db, "sender_carrier", domain)?.content
        ? `emails from ${domain} are usually ${getObservation(deps.db, "sender_carrier", domain)!.content}`
        : undefined;

    try {
      const classification = await classifyEmail(
        {
          emailId: msg.id,
          threadId: msg.threadId,
          subject: msg.subject,
          from: msg.from,
          body,
          hint,
        },
        { llm: deps.llm },
      );

      const isParcel = classification.isParcelRelated && Boolean(classification.trackingNumber);
      upsertEmail(deps.db, {
        id: msg.id,
        thread_id: msg.threadId,
        subject: msg.subject,
        sender: msg.from,
        internalDate: msg.internalDate,
        is_unread: msg.isUnread,
        is_parcel: isParcel,
        tracking_number: classification.trackingNumber,
      });

      // Learn the sender→carrier mapping from confident parcel classifications (Observational Memory).
      if (isParcel && classification.carrier && classification.confidence >= 0.8 && domain) {
        recordObservation(deps.db, {
          kind: "sender_carrier",
          key: domain,
          content: classification.carrier,
        });
      }

      if (classification.isParcelRelated && classification.trackingNumber) {
        const existing = deps.db
          .prepare("SELECT 1 FROM parcels WHERE tracking_number = ?")
          .get(classification.trackingNumber);
        const isNew = !existing;

        upsertParcel(deps.db, {
          tracking_number: classification.trackingNumber,
          carrier: classification.carrier ?? "unknown",
          status: classification.status ?? "unknown",
          thread_id: msg.threadId,
          email_id: msg.id,
        });

        recordDecision(deps.db, {
          timestamp: now,
          email_id: msg.id,
          thread_id: msg.threadId,
          action_taken: "track",
          agent_reasoning: classification.reasoning,
          outcome: `${classification.carrier ?? "?"} ${classification.trackingNumber} → ${classification.status ?? "?"}`,
        });

        if (isNew) summary.tracked++;
        else summary.updated++;
      } else {
        recordDecision(deps.db, {
          timestamp: now,
          email_id: msg.id,
          thread_id: msg.threadId,
          action_taken: "skip",
          agent_reasoning: classification.reasoning,
        });
        summary.skipped++;
      }
    } catch (err) {
      summary.errors++;
      recordDecision(deps.db, {
        timestamp: now,
        email_id: msg.id,
        thread_id: msg.threadId,
        action_taken: "skip",
        agent_reasoning: `Error during classification: ${err instanceof Error ? err.message : String(err)}`,
        outcome: "error",
      });
    }
  }

  logEvent(deps.db, {
    source: "classifier",
    level: summary.errors > 0 ? "warn" : "info",
    message: `Classified ${summary.scanned}: ${summary.tracked} new, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.deduped} deduped, ${summary.errors} errors`,
    data: { ...summary },
  });

  return ok(summary, {
    next_action: 'Run `npm run try -- parcels` to view tracked shipments.',
    diagnostics: {
      days,
      maxEmails,
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-nano",
      llm_calls: summary.scanned - summary.errors,
    },
  });
}
