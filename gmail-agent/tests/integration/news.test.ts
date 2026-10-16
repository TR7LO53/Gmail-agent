import { afterEach, describe, expect, it, vi } from "vitest";
import { runNews } from "../../src/agents/news.js";
import { openDb, type DB } from "../../src/memory/db.js";
import { addNewsSender, getNewsSummary, setNewsInterests } from "../../src/memory/news.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { b64url, makeFakeGmail } from "../helpers/fake-gmail.js";

describe("News agent", () => {
  let db: DB;
  afterEach(() => { db?.close(); vi.unstubAllEnvs(); });

  function setup(body: string, opts: { llmError?: boolean; internalDate?: string; isIssue?: boolean } = {}) {
    db = openDb(":memory:");
    addNewsSender(db, "@news.example");
    const id = "news-message";
    const payload = {
      headers: [
        { name: "From", value: "Writer <writer@news.example>" },
        { name: "Subject", value: "AI research update" },
        { name: "Date", value: "Wed, 01 Jul 2026 09:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: { data: b64url(body) },
    };
    const gmail = makeFakeGmail({
      messagesList: async (params: { pageToken?: string }) => ({
        data: { messages: params.pageToken ? [] : [{ id }], resultSizeEstimate: 1 },
      }),
      messagesGet: async (params: { id: string; format: string }) => params.format === "minimal"
        ? ({ data: { id, threadId: "news-thread" } })
        : ({ data: { id, threadId: "news-thread", internalDate: opts.internalDate ?? String(Date.now() + 1000), payload } }),
      threadsGet: async () => ({ data: { messages: [{ id, threadId: "news-thread", payload }] } }),
    });
    const extract = vi.fn(async (_schema: unknown, _system: string, _user: string, _opts?: { model?: string }) => {
      if (opts.llmError) throw new Error("model_not_found: requested model is unavailable");
      return { is_issue: opts.isIssue ?? true, bullets: ["One", "Two", "Three"], score: 8, reason: "Relevant." };
    });
    const llm = { extract } as unknown as LLMProvider;
    return { gmail, extract, deps: { gmail, llm, db } };
  }

  it("searches across senders and categories, passes interests and the configured model, then deduplicates", async () => {
    vi.stubEnv("OPENAI_NEWS_MODEL", "news-model-test");
    vi.stubEnv("GGENT_CATEGORY", "primary");
    const f = setup("A useful AI newsletter. ".repeat(30));
    setNewsInterests(db, "AI evaluation systems");
    const result = await runNews(f.deps);
    expect(result.data?.processed).toBe(1);
    expect(getNewsSummary(db, "news-message")).toMatchObject({ status: "ok", score: 8, attempts: 0 });
    expect(f.extract).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("plain, simple English"), expect.stringContaining("AI evaluation systems"), { model: "news-model-test" });
    expect(f.gmail.users.messages.list).toHaveBeenCalledTimes(1);
    const query = (f.gmail.users.messages.list as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(query.q).toContain("from:@news.example");
    expect(query.q).toContain("after:");
    expect(query.q).not.toContain("category:");
    const second = await runNews(f.deps);
    expect(second.data?.skipped).toBe(1);
    expect(f.extract).toHaveBeenCalledTimes(1);
  });

  it("fails short messages without calling the model", async () => {
    const f = setup("short text");
    const result = await runNews(f.deps);
    expect(result.data?.failed).toBe(1);
    expect(getNewsSummary(db, "news-message")).toMatchObject({ status: "failed", error: "too little text" });
    expect(f.extract).not.toHaveBeenCalled();
  });

  it("accepts exactly 300 cleaned characters", async () => {
    const f = setup("x".repeat(300));
    const result = await runNews(f.deps);
    expect(result.data?.processed).toBe(1);
    expect(f.extract).toHaveBeenCalledTimes(1);
  });

  it("defaults to gpt-6-luna without substituting empty interests", async () => {
    vi.stubEnv("OPENAI_NEWS_MODEL", "");
    vi.stubEnv("OPENAI_MODEL", "classifier-model");
    vi.stubEnv("OPENAI_TRACKER_MODEL", "tracker-model");
    const f = setup("x".repeat(300));
    setNewsInterests(db, "");
    await runNews(f.deps);
    expect(f.extract).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.stringContaining("empty means no stated interests"), { model: "gpt-6-luna" });
  });

  it("does no Gmail work without active senders", async () => {
    db = openDb(":memory:");
    const gmail = makeFakeGmail({});
    const extract = vi.fn();
    const result = await runNews({ gmail, llm: { extract } as unknown as LLMProvider, db });
    expect(result.data?.eligible).toBe(0);
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(listRecentLogs(db, 5).some((entry) => entry.source === "news")).toBe(true);
  });

  it("skips mail received before its sender was added", async () => {
    const f = setup("Long newsletter content. ".repeat(30), { internalDate: "0" });
    const result = await runNews(f.deps);
    expect(result.data?.skipped).toBe(1);
    expect(f.extract).not.toHaveBeenCalled();
    expect(getNewsSummary(db, "news-message")).toBeUndefined();
  });

  it("stores non-news confirmations without putting their score in the feed", async () => {
    const f = setup("A subscription welcome message with enough text. ".repeat(8), { isIssue: false });
    const result = await runNews(f.deps);
    expect(result.data?.notAnIssue).toBe(1);
    expect(getNewsSummary(db, "news-message")).toMatchObject({ status: "not_an_issue", score: undefined, bullets: [] });
    await runNews(f.deps);
    expect(f.extract).toHaveBeenCalledTimes(1);
  });

  it("retries failures over three separate runs and then stops", async () => {
    const f = setup("Long newsletter content. ".repeat(30), { llmError: true });
    for (const attempts of [1, 2, 3]) {
      await runNews(f.deps);
      expect(getNewsSummary(db, "news-message")?.attempts).toBe(attempts);
      expect(getNewsSummary(db, "news-message")?.status).toBe(attempts === 3 ? "failed" : "pending");
    }
    await runNews(f.deps);
    expect(f.extract).toHaveBeenCalledTimes(3);
    expect(listRecentLogs(db, 20).filter((entry) => entry.source === "news").length).toBeGreaterThanOrEqual(4);
  });

  it("retries stored pending work when the next search fails", async () => {
    const f = setup("Long newsletter content. ".repeat(30), { llmError: true });
    await runNews(f.deps);
    (f.gmail.users.messages.list as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("Gmail temporarily unavailable");
    });
    const retry = await runNews(f.deps);
    expect(retry.data?.searchError).toContain("Gmail temporarily unavailable");
    expect(getNewsSummary(db, "news-message")).toMatchObject({ status: "pending", attempts: 2 });
    expect(f.extract).toHaveBeenCalledTimes(2);
  });
});
