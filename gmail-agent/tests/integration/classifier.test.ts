import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { getParcel, listActiveParcels } from "../../src/memory/parcels.js";
import { listDecisions } from "../../src/memory/decisions.js";
import { listTodaysEmails, startOfLocalDayIso } from "../../src/memory/emails.js";
import { getObservation } from "../../src/memory/observations.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { runClassifier } from "../../src/agents/classifier.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { DB } from "../../src/memory/db.js";
import { makeFakeGmail } from "../helpers/fake-gmail.js";
import { b64url } from "../helpers/fake-gmail.js";
import type { Classification } from "../../src/agents/classifier.js";

function memDb(): DB {
  return openDb(":memory:");
}

function makeFakeLLM(response: Classification): LLMProvider {
  return {
    async extract<T>(_schema: unknown, _system: string, _user: string): Promise<T> {
      return response as T;
    },
  };
}

function makeFakeGmailWithMessages(messages: Array<{ id: string; threadId: string; subject: string; from: string; body: string }>) {
  const messageList = messages.map((m) => ({ id: m.id, threadId: m.threadId }));

  return makeFakeGmail({
    messagesList: async () => ({
      data: { messages: messageList, resultSizeEstimate: messageList.length },
    }),
    messagesGet: async (params: { id: string }) => {
      const msg = messages.find((m) => m.id === params.id);
      if (!msg) return { data: {} };
      return {
        data: {
          id: msg.id,
          threadId: msg.threadId,
          labelIds: ["INBOX"],
          internalDate: String(Date.now()),
          snippet: msg.body.slice(0, 100),
          payload: {
            headers: [
              { name: "From", value: msg.from },
              { name: "Subject", value: msg.subject },
              { name: "Date", value: "Mon, 30 Jun 2026 10:00:00 +0000" },
            ],
            mimeType: "text/plain",
            body: { data: b64url(msg.body) },
          },
        },
      };
    },
    threadsGet: async (params: { id: string }) => {
      const msg = messages.find((m) => m.threadId === params.id || m.id === params.id);
      if (!msg) return { data: {} };
      return {
        data: {
          id: msg.threadId,
          messages: [
            {
              id: msg.id,
              threadId: msg.threadId,
              labelIds: ["INBOX"],
              snippet: msg.body.slice(0, 100),
              payload: {
                headers: [
                  { name: "From", value: msg.from },
                  { name: "Subject", value: msg.subject },
                  { name: "Date", value: "Mon, 30 Jun 2026 10:00:00 +0000" },
                ],
                mimeType: "text/plain",
                body: { data: b64url(msg.body) },
              },
            },
          ],
        },
      };
    },
  });
}

const DHL_EMAIL = {
  id: "msg_dhl_001",
  threadId: "thread_dhl_001",
  subject: "Your DHL package is on its way",
  from: "noreply@dhl.com",
  body: "Your shipment 1234567890 is now in transit. Expected delivery: July 2nd.",
};

const NEWSLETTER_EMAIL = {
  id: "msg_news_001",
  threadId: "thread_news_001",
  subject: "Summer sale! 50% off everything",
  from: "promo@shop.example.com",
  body: "Check out our summer deals. Use code SUMMER50 at checkout.",
};

describe("Classifier integration", () => {
  let db: DB;

  beforeEach(() => {
    db = memDb();
  });

  it("tracks a parcel from a courier email", async () => {
    const gmail = makeFakeGmailWithMessages([DHL_EMAIL]);
    const llm = makeFakeLLM({
      isParcelRelated: true,
      trackingNumber: "1234567890",
      carrier: "DHL",
      status: "in_transit",
      confidence: 0.97,
      reasoning: "DHL shipment notification with tracking number",
    });

    const result = await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    expect(result.success).toBe(true);
    expect(result.data?.tracked).toBe(1);
    expect(result.data?.skipped).toBe(0);

    const parcel = getParcel(db, "1234567890");
    expect(parcel).toBeDefined();
    expect(parcel?.carrier).toBe("DHL");
    expect(parcel?.status).toBe("in_transit");

    const decisions = listDecisions(db, 10);
    expect(decisions[0].action_taken).toBe("track");
  });

  it("skips a non-parcel email (newsletter)", async () => {
    const gmail = makeFakeGmailWithMessages([NEWSLETTER_EMAIL]);
    const llm = makeFakeLLM({
      isParcelRelated: false,
      confidence: 0.99,
      reasoning: "Promotional email, no shipment",
    });

    const result = await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    expect(result.success).toBe(true);
    expect(result.data?.skipped).toBe(1);
    expect(result.data?.tracked).toBe(0);

    expect(listActiveParcels(db)).toHaveLength(0);

    const decisions = listDecisions(db, 10);
    expect(decisions[0].action_taken).toBe("skip");
  });

  it("appends history when a known parcel receives a status update", async () => {
    const email1 = { ...DHL_EMAIL, id: "msg_dhl_001", subject: "Your DHL package shipped" };
    const email2 = { ...DHL_EMAIL, id: "msg_dhl_002", subject: "Your DHL package is out for delivery" };

    const gmail1 = makeFakeGmailWithMessages([email1]);
    const llm1 = makeFakeLLM({ isParcelRelated: true, trackingNumber: "TRK_HISTORY", carrier: "DHL", status: "shipped", confidence: 0.9, reasoning: "shipped" });
    await runClassifier({ days: 7, maxEmails: 5 }, { gmail: gmail1, llm: llm1, db });

    const gmail2 = makeFakeGmailWithMessages([email2]);
    const llm2 = makeFakeLLM({ isParcelRelated: true, trackingNumber: "TRK_HISTORY", carrier: "DHL", status: "out_for_delivery", confidence: 0.95, reasoning: "out for delivery" });
    const result2 = await runClassifier({ days: 7, maxEmails: 5 }, { gmail: gmail2, llm: llm2, db });

    expect(result2.data?.updated).toBe(1);
    const parcel = getParcel(db, "TRK_HISTORY");
    expect(parcel?.status).toBe("out_for_delivery");
    expect(parcel?.history).toHaveLength(2);
    expect(parcel?.history.map((h) => h.status)).toEqual(["shipped", "out_for_delivery"]);
  });

  it("handles an LLM error gracefully — skips email, continues", async () => {
    const gmail = makeFakeGmailWithMessages([DHL_EMAIL, NEWSLETTER_EMAIL]);
    let callCount = 0;
    const llm: LLMProvider = {
      async extract<T>(): Promise<T> {
        callCount++;
        if (callCount === 1) throw new Error("Rate limit exceeded");
        return { isParcelRelated: false, confidence: 0.9, reasoning: "newsletter" } as T;
      },
    };

    const result = await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    expect(result.success).toBe(true);
    expect(result.data?.errors).toBe(1);
    expect(result.data?.scanned).toBe(2);
    // second email should still be processed
    expect(result.data?.skipped).toBe(1);
  });

  it("deduplicates an email already processed in a previous run", async () => {
    const llm = makeFakeLLM({
      isParcelRelated: true,
      trackingNumber: "1234567890",
      carrier: "DHL",
      status: "in_transit",
      confidence: 0.9,
      reasoning: "dhl",
    });

    const first = await runClassifier({ days: 7, maxEmails: 5 }, { gmail: makeFakeGmailWithMessages([DHL_EMAIL]), llm, db });
    expect(first.data?.scanned).toBe(1);
    expect(first.data?.tracked).toBe(1);
    expect(first.data?.deduped).toBe(0);

    // Second run, same email id, shared db — must be skipped before any LLM call.
    let calls = 0;
    const llm2: LLMProvider = {
      async extract<T>(): Promise<T> {
        calls++;
        return { isParcelRelated: false, confidence: 0.5, reasoning: "should not be called" } as T;
      },
    };
    const second = await runClassifier({ days: 7, maxEmails: 5 }, { gmail: makeFakeGmailWithMessages([DHL_EMAIL]), llm: llm2, db });

    expect(second.data?.deduped).toBe(1);
    expect(second.data?.scanned).toBe(0);
    expect(calls).toBe(0);
  });

  it("re-processes a known email when skipProcessed is false", async () => {
    const llm = makeFakeLLM({
      isParcelRelated: true,
      trackingNumber: "1234567890",
      carrier: "DHL",
      status: "in_transit",
      confidence: 0.9,
      reasoning: "dhl",
    });
    await runClassifier({ days: 7, maxEmails: 5 }, { gmail: makeFakeGmailWithMessages([DHL_EMAIL]), llm, db });

    const again = await runClassifier(
      { days: 7, maxEmails: 5, skipProcessed: false },
      { gmail: makeFakeGmailWithMessages([DHL_EMAIL]), llm, db },
    );
    expect(again.data?.deduped).toBe(0);
    expect(again.data?.scanned).toBe(1);
  });

  it("logs a gmail_search error (and fails) when the Gmail search throws", async () => {
    const gmail = makeFakeGmail({
      messagesList: async () => {
        throw new Error("invalid_grant");
      },
    });
    const llm = makeFakeLLM({ isParcelRelated: false, confidence: 0.5, reasoning: "x" });

    const result = await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    expect(result.success).toBe(false);
    const logs = listRecentLogs(db, 10);
    expect(logs.some((l) => l.source === "gmail_search" && l.level === "error")).toBe(true);
  });

  it("scopes the scan to the Primary category by default", async () => {
    let seenQuery = "";
    const gmail = makeFakeGmail({
      messagesList: async (params: { q?: string }) => {
        seenQuery = params.q ?? "";
        return { data: { messages: [] } };
      },
    });
    const llm = makeFakeLLM({ isParcelRelated: false, confidence: 0.9, reasoning: "x" });

    await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    expect(seenQuery).toContain("category:primary");
  });

  it("records every scanned email (parcel and non-parcel) and learns sender→carrier", async () => {
    const gmail = makeFakeGmailWithMessages([DHL_EMAIL, NEWSLETTER_EMAIL]);
    let call = 0;
    const llm: LLMProvider = {
      async extract<T>(): Promise<T> {
        call++;
        return (call === 1
          ? { isParcelRelated: true, trackingNumber: "1234567890", carrier: "DHL", status: "in_transit", confidence: 0.97, reasoning: "dhl" }
          : { isParcelRelated: false, confidence: 0.9, reasoning: "newsletter" }) as T;
      },
    };

    await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    const todays = listTodaysEmails(db, startOfLocalDayIso());
    expect(todays).toHaveLength(2); // both the parcel AND the newsletter are recorded
    expect(getObservation(db, "sender_carrier", "dhl.com")?.content).toBe("DHL");
    expect(getObservation(db, "sender_carrier", "shop.example.com")).toBeUndefined();
  });

  it("does not create parcel row when email is parcel-related but has no tracking number", async () => {
    const gmail = makeFakeGmailWithMessages([DHL_EMAIL]);
    const llm = makeFakeLLM({
      isParcelRelated: true,
      carrier: "DHL",
      status: "unknown",
      confidence: 0.4,
      reasoning: "Mentions DHL but no tracking number found",
    });

    const result = await runClassifier({ days: 7, maxEmails: 5 }, { gmail, llm, db });

    expect(result.success).toBe(true);
    expect(listActiveParcels(db)).toHaveLength(0);
    // Decision should still be logged (as skip since no tracking number)
    const decisions = listDecisions(db, 10);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action_taken).toBe("skip");
  });
});
