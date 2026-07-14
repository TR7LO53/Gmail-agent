import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { upsertParcel, getParcel } from "../../src/memory/parcels.js";
import { listDecisions } from "../../src/memory/decisions.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { recordObservation, getObservation } from "../../src/memory/observations.js";
import { runTracker, trackParcel, type TrackerResult } from "../../src/agents/tracker.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { DB } from "../../src/memory/db.js";
import { makeFakeGmail, b64url } from "../helpers/fake-gmail.js";

function memDb(): DB {
  return openDb(":memory:");
}

function fakeLLM(result: TrackerResult): LLMProvider {
  return {
    async extract<T>(): Promise<T> {
      return result as T;
    },
  };
}

function gmailWith(email: { id: string; threadId: string; subject: string; from: string; body: string }) {
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
      data: { id: email.id, threadId: email.threadId, labelIds: ["INBOX"], snippet: email.body.slice(0, 80), payload },
    }),
    threadsGet: async () => ({
      data: {
        id: email.threadId,
        messages: [{ id: email.id, threadId: email.threadId, labelIds: ["INBOX"], snippet: email.body.slice(0, 80), payload }],
      },
    }),
  });
}

function emptyGmail() {
  return makeFakeGmail({ messagesList: async () => ({ data: { messages: [] } }) });
}

describe("Tracker integration", () => {
  let db: DB;

  beforeEach(() => {
    db = memDb();
    upsertParcel(db, {
      tracking_number: "TRK1",
      carrier: "DHL",
      status: "in_transit",
      thread_id: "thread_trk1",
      email_id: "seed_msg",
    });
  });

  it("advances a parcel to delivered and logs an update decision", async () => {
    const gmail = gmailWith({
      id: "m2",
      threadId: "thread_trk1",
      subject: "Delivered",
      from: "noreply@dhl.com",
      body: "Your parcel TRK1 was delivered today.",
    });
    const llm = fakeLLM({ currentStatus: "delivered", summary: "Delivered today.", isDelivered: true });

    const result = await runTracker({}, { gmail, llm, db });

    expect(result.success).toBe(true);
    expect(result.data?.checked).toBe(1);
    expect(result.data?.updated).toBe(1);
    expect(result.data?.delivered).toBe(1);

    const parcel = getParcel(db, "TRK1");
    expect(parcel?.status).toBe("delivered");
    expect(parcel?.history.map((h) => h.status)).toEqual(["in_transit", "delivered"]);

    const decisions = listDecisions(db, 5);
    expect(decisions[0].action_taken).toBe("update");
    expect(decisions[0].outcome).toContain("in_transit -> delivered");
  });

  it("does not log a decision or grow history when the status is unchanged", async () => {
    const gmail = gmailWith({
      id: "m2",
      threadId: "thread_trk1",
      subject: "Still moving",
      from: "noreply@dhl.com",
      body: "Your parcel TRK1 is still in transit.",
    });
    const llm = fakeLLM({ currentStatus: "in_transit", summary: "Still in transit.", isDelivered: false });

    const result = await runTracker({}, { gmail, llm, db });

    expect(result.data?.checked).toBe(1);
    expect(result.data?.updated).toBe(0);
    expect(getParcel(db, "TRK1")?.history).toHaveLength(1);
    expect(listDecisions(db, 5)).toHaveLength(0);
  });

  it("fails gracefully (no update) when no related emails are found", async () => {
    const parcel = getParcel(db, "TRK1")!;
    const r = await trackParcel(
      { ...parcel, thread_id: undefined },
      { gmail: emptyGmail(), llm: fakeLLM({ currentStatus: "in_transit", summary: "n/a", isDelivered: false }), db },
    );
    expect(r.success).toBe(false);
    expect(r.recovery).toContain("No emails found");
  });

  it("counts an LLM error and keeps going", async () => {
    const gmail = gmailWith({
      id: "m2",
      threadId: "thread_trk1",
      subject: "x",
      from: "noreply@dhl.com",
      body: "TRK1 update",
    });
    const llm: LLMProvider = {
      async extract<T>(): Promise<T> {
        throw new Error("rate limited");
      },
    };

    const result = await runTracker({}, { gmail, llm, db });
    expect(result.success).toBe(true);
    expect(result.data?.errors).toBe(1);
    expect(result.data?.updated).toBe(0);

    // The error is logged, NOT written as a fake "error" decision.
    const logs = listRecentLogs(db, 20);
    expect(logs.some((l) => l.source === "tracker" && l.level === "error")).toBe(true);
    expect(listDecisions(db, 20).some((d) => d.outcome === "error")).toBe(false);
  });

  it("reuses a stored parcel note (Observational Memory) and refreshes it", async () => {
    recordObservation(db, { kind: "parcel_note", key: "TRK1", content: "earlier: shipped from warehouse" });

    let seenUser = "";
    const llm: LLMProvider = {
      async extract<T>(_schema: unknown, _system: string, user: string): Promise<T> {
        seenUser = user;
        return { currentStatus: "delivered", summary: "Delivered today.", isDelivered: true } as T;
      },
    };
    const gmail = gmailWith({ id: "m2", threadId: "thread_trk1", subject: "Delivered", from: "noreply@dhl.com", body: "TRK1 delivered." });

    await runTracker({}, { gmail, llm, db });

    expect(seenUser).toContain("Prior note: earlier: shipped from warehouse");
    expect(getObservation(db, "parcel_note", "TRK1")?.content).toContain("delivered");
  });

  it("can track a single parcel by tracking number", async () => {
    upsertParcel(db, {
      tracking_number: "TRK2",
      carrier: "InPost",
      status: "shipped",
      thread_id: "thread_trk2",
      email_id: "seed2",
    });
    const gmail = gmailWith({
      id: "m3",
      threadId: "thread_trk2",
      subject: "Ready for pickup",
      from: "noreply@inpost.pl",
      body: "Parcel TRK2 is ready in the locker.",
    });
    const llm = fakeLLM({ currentStatus: "out_for_delivery", summary: "Ready for pickup.", isDelivered: false });

    const result = await runTracker({ trackingNumber: "TRK2" }, { gmail, llm, db });
    expect(result.data?.checked).toBe(1);
    expect(getParcel(db, "TRK2")?.status).toBe("out_for_delivery");
    // TRK1 untouched
    expect(getParcel(db, "TRK1")?.status).toBe("in_transit");
  });
});
