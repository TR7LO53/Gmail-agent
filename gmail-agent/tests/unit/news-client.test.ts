// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/ui/public");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function boot() {
  const html = readFileSync(path.join(ROOT, "index.html"), "utf-8").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.open(); document.write(html); document.close();
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let currentSender: any = { id: 7, pattern: "author@example.com", display_name: "Author" };
  let interests = "AI and climate";
  const email = { id: "message / 1", subject: "Story", sender: "author@example.com", received_at: "2026-10-15T10:00:00Z", in_ai_news: false };
  const data = {
    "/api/parcels?all=false": { parcels: [] }, "/api/summary": { summary: null, generatedAt: null },
    "/api/emails": { recent: [email], today: [email], unread: [], counts: { unread: 0, today: 1 }, lastChecked: null },
    "/api/food": { entries: [], totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 } },
    "/api/decisions?limit=25": { decisions: [] }, "/api/status": { lastChecked: null }, "/api/logs?limit=40": { logs: [] },
    "/api/food/stats": { lastDay: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, lastWeekAverage: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } },
    "/api/presets": { presets: [] },
    "/api/news": { leaderboard: [], feed: [] }, "/api/news/senders": { senders: currentSender ? [currentSender] : [] },
    "/api/news/interests": { interests },
  } as Record<string, any>;
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    if (url === "/api/news/senders/from-email") { email.in_ai_news = true; return response({ sender: currentSender }, 201); }
    if (url === "/api/news/interests" && options?.method === "PUT") { interests = JSON.parse(String(options.body)).interests; return response({ interests }); }
    if (url === "/api/news/senders" && options?.method === "POST") { currentSender = { id: 8, ...JSON.parse(String(options.body)) }; return response({ sender: currentSender }, 201); }
    if (url === "/api/news/senders/7" && options?.method === "PUT") { currentSender.display_name = JSON.parse(String(options.body)).display_name; return response({ sender: currentSender }); }
    if (url === "/api/news/senders/7" && options?.method === "DELETE") { currentSender = null; return response({ ok: true }); }
    return response(data[url] || {});
  });
  (window as any).fetch = fetchMock;
  class EventSourceMock {
    static latest: EventSourceMock;
    handlers = new Map<string, Function[]>();
    constructor() { EventSourceMock.latest = this; }
    addEventListener(name: string, fn: Function) { this.handlers.set(name, [...(this.handlers.get(name) || []), fn]); }
    emit(name: string) { (this.handlers.get(name) || []).forEach((fn) => fn({ data: "{}" })); }
    close() {}
  }
  (window as any).EventSource = EventSourceMock;
  const context = vm.createContext({
    document,
    window,
    fetch: fetchMock,
    EventSource: EventSourceMock,
    setTimeout,
    clearTimeout,
    Date,
    URL,
    FormData,
    console,
  });
  vm.runInContext(readFileSync(path.join(ROOT, "app.js"), "utf-8"), context);
  return { calls, context, fetchMock, EventSourceMock };
}

afterEach(() => { vi.useRealTimers(); });

describe("AI News browser client", () => {
  it("loads all news resources on tab entry, keeps fields during SSE, and toggles all tabs", async () => {
    const { calls, context } = boot();
    await flush();
    document.getElementById("tabAiNews")!.click();
    await flush();
    expect(calls.some((call) => call.url === "/api/news")).toBe(true);
    expect(calls.some((call) => call.url === "/api/news/senders")).toBe(true);
    expect(calls.some((call) => call.url === "/api/news/interests")).toBe(true);
    const interests = document.querySelector<HTMLTextAreaElement>('[name="interests"]')!;
    interests.value = "Local draft\nsecond line";
    interests.dispatchEvent(new Event("input", { bubbles: true }));
    (window as any).EventSource.latest.emit("update");
    await flush();
    expect(interests.value).toBe("Local draft\nsecond line");
    document.getElementById("tabDashboard")!.click();
    expect((document.getElementById("view-dashboard") as HTMLElement).hidden).toBe(false);
    document.getElementById("tabFoodData")!.click();
    expect((document.getElementById("view-food-data") as HTMLElement).hidden).toBe(false);
    document.getElementById("tabAiNews")!.click();
    expect((document.getElementById("view-ai-news") as HTMLElement).hidden).toBe(false);
    expect(interests.value).toBe("Local draft\nsecond line");
  });

  it("posts the email id once and keeps the success green across rerenders for exactly ten seconds", async () => {
    vi.useFakeTimers();
    const { calls } = boot();
    await flush();
    const button = document.querySelector<HTMLButtonElement>(".news-add-email")!;
    button.click(); button.click();
    await flush();
    const action = calls.find((call) => call.url === "/api/news/senders/from-email")!;
    expect(action.options?.method).toBe("POST");
    expect(JSON.parse(String(action.options?.body))).toEqual({ emailId: "message / 1" });
    expect(calls.filter((call) => call.url === "/api/news/senders/from-email")).toHaveLength(1);
    expect(document.querySelector(".news-confirmed")?.textContent).toContain("AI News");
    vi.advanceTimersByTime(5000);
    (document.getElementById("tabAiNews") as HTMLButtonElement).click();
    await flush();
    (document.getElementById("tabDashboard") as HTMLButtonElement).click();
    expect(document.querySelector(".news-confirmed")).not.toBeNull();
    vi.advanceTimersByTime(4999);
    expect(document.querySelector(".news-confirmed")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector(".news-confirmed")).toBeNull();
    expect(document.querySelector(".news-added") || document.querySelector(".news-add-email")).not.toBeNull();
  });

  it("uses the sender and interests mutation routes with raw multiline values", async () => {
    const { calls } = boot();
    await flush();
    document.getElementById("tabAiNews")!.click(); await flush();
    document.querySelector<HTMLButtonElement>(".newsRename")!.click();
    const rename = document.querySelector<HTMLFormElement>(".newsRenameForm")!;
    (rename.elements.namedItem("display_name") as HTMLInputElement).value = "Renamed";
    rename.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.some((call) => call.url === "/api/news/senders/7" && call.options?.method === "PUT" && JSON.parse(String(call.options.body)).display_name === "Renamed")).toBe(true);
    const textarea = document.querySelector<HTMLTextAreaElement>('[name="interests"]')!;
    textarea.value = "one\ntwo"; textarea.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("newsInterestsForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.some((call) => call.url === "/api/news/interests" && call.options?.method === "PUT" && JSON.parse(String(call.options.body)).interests === "one\ntwo")).toBe(true);
    const addForm = document.getElementById("newsSenderCreateForm") as HTMLFormElement;
    (addForm.elements.namedItem("pattern") as HTMLInputElement).value = "@example.org";
    addForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(calls.some((call) => call.url === "/api/news/senders" && call.options?.method === "POST" && JSON.parse(String(call.options.body)).pattern === "@example.org")).toBe(true);
    document.querySelector<HTMLButtonElement>(".newsRemove")!.click(); await flush();
    expect(calls.some((call) => call.url === "/api/news/senders/7" && call.options?.method === "DELETE")).toBe(true);
  });
});
