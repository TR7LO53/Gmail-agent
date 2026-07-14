import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { getLastChecked } from "../../src/memory/meta.js";
import { listActiveParcels } from "../../src/memory/parcels.js";
import { listUnread } from "../../src/memory/emails.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { runHeartbeatTick } from "../../src/core/heartbeat.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { DB } from "../../src/memory/db.js";
import { makeFakeGmail, b64url } from "../helpers/fake-gmail.js";

function memDb(): DB {
  return openDb(":memory:");
}

/**
 * One fake LLM serving all three calls in a tick. It branches on the system prompt so the
 * classifier, tracker, and summary each get a correctly-shaped response.
 */
function fakeLLM(): LLMProvider {
  return {
    async extract<T>(_schema: unknown, system: string): Promise<T> {
      if (system.includes("classifier")) {
        return {
          isParcelRelated: true,
          trackingNumber: "HB1",
          carrier: "DHL",
          status: "shipped",
          confidence: 0.95,
          reasoning: "dhl shipped",
        } as T;
      }
      if (system.includes("tracker")) {
        return { currentStatus: "in_transit", summary: "On its way.", isDelivered: false } as T;
      }
      return { summary: "1 active parcel." } as T; // daily summary
    },
  };
}

function fakeGmail() {
  const email = {
    id: "hb_msg",
    threadId: "hb_thread",
    subject: "DHL shipped HB1",
    from: "noreply@dhl.com",
    body: "Your parcel HB1 has shipped, tracking HB1, now in transit.",
  };
  const payload = {
    headers: [
      { name: "From", value: email.from },
      { name: "Subject", value: email.subject },
      { name: "Date", value: "Wed, 01 Jul 2026 09:00:00 +0000" },
    ],
    mimeType: "text/plain",
    body: { data: b64url(email.body) },
  };
  return makeFakeGmail({
    messagesList: async () => ({
      data: { messages: [{ id: email.id, threadId: email.threadId }], resultSizeEstimate: 1 },
    }),
    messagesGet: async () => ({
      data: { id: email.id, threadId: email.threadId, labelIds: ["INBOX"], internalDate: String(Date.now()), snippet: email.body.slice(0, 80), payload },
    }),
    threadsGet: async () => ({
      data: {
        id: email.threadId,
        messages: [{ id: email.id, threadId: email.threadId, labelIds: ["INBOX"], snippet: email.body.slice(0, 80), payload }],
      },
    }),
  });
}

describe("Heartbeat tick", () => {
  let db: DB;

  beforeEach(() => {
    db = memDb();
  });

  it("classifies, tracks, summarises, and records last_checked", async () => {
    const result = await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });

    expect(result.success).toBe(true);
    expect(result.data?.classifier.tracked).toBe(1);
    // tracker moved the freshly-classified parcel shipped -> in_transit
    expect(result.data?.tracker.updated).toBe(1);
    expect(result.data?.summary).toBeTruthy();
    // refreshUnread saw the (fake) unread email
    expect(result.data?.unread).toBe(1);
    expect(listUnread(db)).toHaveLength(1);

    expect(listActiveParcels(db)).toHaveLength(1);
    expect(listActiveParcels(db)[0].status).toBe("in_transit");
    expect(getLastChecked(db)).toBeTruthy();

    // The tick writes an activity trail.
    const sources = new Set(listRecentLogs(db, 50).map((l) => l.source));
    expect(sources.has("heartbeat")).toBe(true);
    expect(sources.has("gmail_search")).toBe(true);
    expect(sources.has("classifier")).toBe(true);
    expect(sources.has("summary")).toBe(true);
  });

  it("deduplicates the same email on the second tick", async () => {
    await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });
    const second = await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });

    expect(second.data?.classifier.deduped).toBe(1);
    expect(second.data?.classifier.scanned).toBe(0);
    expect(second.data?.classifier.tracked).toBe(0);
  });
});
