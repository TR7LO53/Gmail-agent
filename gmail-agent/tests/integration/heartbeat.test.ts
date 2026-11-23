import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import OpenAI from "openai";
import { openDb } from "../../src/memory/db.js";
import { getLastChecked, getMeta, setLastChecked, setMeta } from "../../src/memory/meta.js";
import { listActiveParcels, upsertParcel } from "../../src/memory/parcels.js";
import { listDecisions } from "../../src/memory/decisions.js";
import { addNewsSender, getNewsSummary } from "../../src/memory/news.js";
import { listUnread } from "../../src/memory/emails.js";
import { listRecentLogs, logEvent } from "../../src/memory/logs.js";
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
      if (system.includes("newsletter issue")) {
        return { is_issue: true, bullets: ["First story.", "Second story.", "Third story."], score: 8, reason: "Relevant stories." } as T;
      }
      return { summary: "1 active parcel." } as T; // daily summary
    },
  };
}

function fakeGmail(opts: { listIds?: (query: string) => string[]; receivedAt?: string } = {}) {
  const email = {
    id: "hb_msg",
    threadId: "hb_thread",
    subject: "DHL shipped HB1",
    from: "noreply@dhl.com",
    body: "Your parcel HB1 has shipped, tracking HB1, now in transit. ".repeat(8),
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
    messagesList: async ({ q }: { q?: string }) => {
      const ids = opts.listIds?.(q ?? "") ?? [email.id];
      return { data: { messages: ids.map((id) => ({ id, threadId: email.threadId })), resultSizeEstimate: ids.length } };
    },
    messagesGet: async ({ id }: { id: string }) => ({
      data: { id, threadId: email.threadId, labelIds: ["INBOX"], internalDate: String(opts.receivedAt ? Date.parse(opts.receivedAt) : Date.now()), snippet: email.body.slice(0, 80), payload },
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
  afterEach(() => vi.useRealTimers());

  it("classifies, tracks, summarises, and records last_checked", async () => {
    const result = await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });

    expect(result.success).toBe(true);
    expect(result.data?.classifier.tracked).toBe(1);
    // tracker moved the freshly-classified parcel shipped -> in_transit
    expect(result.data?.tracker.updated).toBe(1);
    expect(result.data?.summary).toBeTruthy();
    expect(result.data?.news).toMatchObject({ eligible: 0, pending: 0 });
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
    expect(sources.has("news")).toBe(true);
    expect(listRecentLogs(db).filter((log) => log.message.startsWith("Tick done"))).toEqual([
      expect.objectContaining({ level: "info", data: { classifierOk: true, trackerOk: true, unreadOk: true, summaryOk: true, newsOk: true } }),
    ]);
  });

  it("deduplicates the same email on the second tick", async () => {
    await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });
    const second = await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });

    expect(second.data?.classifier.deduped).toBe(1);
    expect(second.data?.classifier.scanned).toBe(0);
    expect(second.data?.classifier.tracked).toBe(0);
  });

  it.each([
    ["classifier", "classifierOk", "logs", "NEW.source = 'classifier' AND NEW.level = 'info'"],
    ["classifier", "classifierOk", "meta", "NEW.key = 'unfinished_classifier_scan'"],
    ["classifier", "classifierOk", "meta", "NEW.key = 'last_checked'"],
    ["tracker", "trackerOk", "logs", "NEW.source = 'tracker' AND NEW.level = 'info'"],
    ["inbox", "unreadOk", "emails", "NEW.is_unread = 1"],
    ["summary", "summaryOk", "logs", "NEW.source = 'summary' AND NEW.level = 'info'"],
    ["news", "newsOk", "logs", "NEW.source = 'news' AND NEW.level = 'info'"],
  ] as const)("continues after %s fails (%s) writing %s where %s", async (source, flag, table, condition) => {
    addNewsSender(db, "noreply@dhl.com", undefined, "2026-01-01T00:00:00.000Z");
    setMeta(db, "daily_summary", "Previous digest.");
    setMeta(db, "daily_summary_at", "2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 505; i++) logEvent(db, { source: "heartbeat", message: "Old activity" });
    db.exec(`CREATE TEMP TRIGGER fail_stage BEFORE INSERT ON ${table}
      WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'stage write failed'); END;`);

    const result = await runHeartbeatTick({ gmail: fakeGmail(), llm: fakeLLM(), db });
    expect(result).toMatchObject({ success: true, diagnostics: { [flag]: false } });
    const logs = listRecentLogs(db, 1000);
    expect(logs.filter((log) => log.source === source && log.level === "error")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("stage write failed") }),
    ]);
    expect(logs.filter((log) => log.message.startsWith("Tick done"))).toEqual([
      expect.objectContaining({ level: "warn", data: expect.objectContaining({ [flag]: false }) }),
    ]);
    expect(logs).toHaveLength(500);
    expect(getNewsSummary(db, "hb_msg")?.status).toBe("ok");
    if (source === "classifier") expect(getLastChecked(db)).toBeUndefined();
    else expect(getLastChecked(db)).toBe(result.data?.ranAt);
    if (source === "summary") {
      expect(result.data?.summary).toBe("Previous digest.");
      expect(getMeta(db, "daily_summary")).toBe("Previous digest.");
      expect(getMeta(db, "daily_summary_at")).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("keeps the previous digest and generates News when the summary model throws", async () => {
    setMeta(db, "daily_summary", "Previous digest.");
    setMeta(db, "daily_summary_at", "2026-01-01T00:00:00.000Z");
    addNewsSender(db, "noreply@dhl.com", undefined, "2026-01-01T00:00:00.000Z");
    const llm = fakeLLM();
    const extract = llm.extract;
    llm.extract = async (...args) => {
      if (args[1].includes("daily digest")) throw new Error("Digest unavailable");
      return extract(...args);
    };

    const result = await runHeartbeatTick({ gmail: fakeGmail(), llm, db });
    expect(result).toMatchObject({ data: { summary: "Previous digest." }, diagnostics: { summaryOk: false, newsOk: true } });
    expect(getMeta(db, "daily_summary")).toBe("Previous digest.");
    expect(getMeta(db, "daily_summary_at")).toBe("2026-01-01T00:00:00.000Z");
    expect(getNewsSummary(db, "hb_msg")?.status).toBe("ok");
    expect(listRecentLogs(db)[0]).toMatchObject({ level: "warn", data: { summaryOk: false } });
  });

  it.each([
    ["after:", "classifierOk", "gmail_search"],
    ["is:unread", "unreadOk", "inbox"],
  ])("handles an already logged Gmail search failure for %s", async (queryPart, flag, source) => {
    const gmail = fakeGmail({ listIds: (query) => {
      if (query.includes(queryPart)) throw new Error("Gmail offline");
      return ["hb_msg"];
    } });
    const result = await runHeartbeatTick({ gmail, llm: fakeLLM(), db });
    expect(result.diagnostics?.[flag]).toBe(false);
    expect(listRecentLogs(db).filter((log) => log.level === "error").map((log) => log.source)).toEqual([source]);
    expect(getLastChecked(db)).toBe(source === "gmail_search" ? undefined : result.data?.ranAt);
  });

  it("advances last_checked when tracking reports a parcel error", async () => {
    const llm = fakeLLM();
    const extract = llm.extract;
    llm.extract = async (...args) => {
      if (args[1].includes("status tracker")) throw new Error("Tracker unavailable");
      return extract(...args);
    };
    const result = await runHeartbeatTick({ gmail: fakeGmail(), llm, db });
    expect(result.diagnostics).toMatchObject({ trackerOk: false, classifierOk: true });
    expect(result.data?.tracker.errors).toBe(1);
    expect(getLastChecked(db)).toBe(result.data?.ranAt);
  });

  it("advances last_checked when tracking resolves the failed classification in the same tick", async () => {
    upsertParcel(db, { tracking_number: "HB1", carrier: "DHL", status: "shipped", email_id: "original" });
    const llm = fakeLLM();
    vi.spyOn(llm, "extract").mockRejectedValueOnce(new Error("Bad response"));

    const result = await runHeartbeatTick({ gmail: fakeGmail(), llm, db });

    expect(result.data?.classifier.errors).toBe(1);
    expect(result.data?.tracker.updated).toBe(1);
    expect(getLastChecked(db)).toBe(result.data?.ranAt);
  });

  it("keeps the first scan window through a missing result and retries when the mail returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
    const receivedAt = "2026-07-02T12:00:00Z";
    const scanQueries: string[] = [];
    let visible = true;
    const gmail = fakeGmail({ receivedAt, listIds: (query) => {
      const after = query.match(/after:(\d{4}\/\d{2}\/\d{2})/)?.[1];
      if (!after) return [];
      scanQueries.push(after);
      return visible && after <= "2026/07/02" ? ["hb_msg"] : [];
    } });
    const llm = fakeLLM();
    const extract = vi.spyOn(llm, "extract").mockRejectedValueOnce(new Error("Bad response"));

    await runHeartbeatTick({ gmail, llm, db });
    expect(getLastChecked(db)).toBeUndefined();
    visible = false;
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await runHeartbeatTick({ gmail, llm, db });
    expect(getLastChecked(db)).toBeUndefined();
    visible = true;
    const retry = await runHeartbeatTick({ gmail, llm, db });
    expect(retry.data?.classifier.tracked).toBe(1);
    expect(getLastChecked(db)).toBe(retry.data?.ranAt);
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    await runHeartbeatTick({ gmail, llm, db });
    expect(scanQueries).toEqual(["2026/07/01", "2026/07/01", "2026/07/01", "2026/08/11"]);
    expect(extract.mock.calls.filter(([, system]) => system.includes("classifier"))).toHaveLength(2);
  });

  it("retries on the next tick and deduplicates after the third error", async () => {
    const llm = fakeLLM();
    const extract = llm.extract;
    const classify = vi.fn(async () => { throw new Error("Bad response"); });
    llm.extract = async (...args) => args[1].includes("classifier") ? classify() : extract(...args);
    const gmail = fakeGmail();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await runHeartbeatTick({ gmail, llm, db });
      expect(result.data?.classifier.errors).toBe(1);
      expect(getLastChecked(db)).toBe(attempt === 3 ? result.data?.ranAt : undefined);
    }
    const fourth = await runHeartbeatTick({ gmail, llm, db });
    expect(fourth.data?.classifier.deduped).toBe(1);
    expect(classify).toHaveBeenCalledTimes(3);
    expect(listDecisions(db)).toHaveLength(3);
  });

  it("runs News during a model outage and classifies all candidates after recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
    const previous = "2026-07-07T12:00:00.000Z";
    setLastChecked(db, previous);
    addNewsSender(db, "noreply@dhl.com", undefined, "2026-07-01T00:00:00.000Z");
    const scanQueries: string[] = [];
    const gmail = fakeGmail({ listIds: (query) => {
      const after = query.match(/after:(\d{4}\/\d{2}\/\d{2})/)?.[1];
      if (!after) return query.includes("from:") ? ["hb_msg"] : [];
      scanQueries.push(after);
      return ["hb_msg", "hb_second"];
    } });
    const llm = fakeLLM();
    const extract = llm.extract;
    const classify = vi.fn()
      .mockRejectedValueOnce(new OpenAI.NotFoundError(404, { code: "model_not_found" }, "Deprecated model", {}))
      .mockResolvedValue({ isParcelRelated: false, confidence: 1, reasoning: "No parcel" });
    llm.extract = async (...args) => args[1].includes("classifier") ? classify() : extract(...args);

    const failed = await runHeartbeatTick({ gmail, llm, db });
    expect(failed.diagnostics).toMatchObject({ classifierOk: false, newsOk: true });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(listDecisions(db)).toEqual([]);
    expect(getLastChecked(db)).toBe(previous);
    expect(getNewsSummary(db, "hb_msg")?.status).toBe("ok");

    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    const recovered = await runHeartbeatTick({ gmail, llm, db });
    expect(recovered.data?.classifier.skipped).toBe(2);
    expect(scanQueries).toEqual(["2026/07/06", "2026/07/06"]);
    expect(listDecisions(db).map((decision) => decision.email_id).sort()).toEqual(["hb_msg", "hb_second"]);
    expect(getLastChecked(db)).toBe(recovered.data?.ranAt);
  });
});
