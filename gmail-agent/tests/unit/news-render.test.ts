// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const APP_JS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/ui/public/app.js");

function loadApp(): Record<string, any> {
  document.body.innerHTML = `
    <div id="food"></div><button id="toggleFoods"></button><div id="parcels"></div><div id="summary"></div>
    <div id="decisions"></div><button id="toggleDecisions"></button><div id="logs"></div><button id="toggleActivity"></button>
    <span id="unreadCount"></span><div id="lastScanLine"></div><div id="todayEmails"></div><div id="emailsMoreRow"></div><button id="toggleEmails"></button>
    <div id="newsLeaderboard"></div><div id="newsFeed"></div><div id="newsSenders"></div>
  `;
  const context = vm.createContext(window as any);
  try { vm.runInContext(readFileSync(APP_JS_PATH, "utf-8"), context); } catch { /* DOM wiring follows rendering helpers. */ }
  return context;
}

describe("AI News rendering", () => {
  let app: Record<string, any>;
  beforeEach(() => { app = loadApp(); });

  it("renders leaderboard rank, fallback names, one decimal, and count", () => {
    app.renderNewsLeaderboard([
      { pattern: "writer@example.com", average_score: 8, count: 4 },
      { pattern: "@example.org", display_name: "Editors", average_score: 7.25, count: 2 },
    ]);
    const text = document.getElementById("newsLeaderboard")!.textContent;
    expect(text).toContain("writer@example.com");
    expect(text).toContain("8.0");
    expect(text).toContain("4");
    expect(text).toContain("2Editors");
    expect(text).toContain("7.3");
    app.renderNewsLeaderboard([]);
    expect(document.getElementById("newsLeaderboard")!.textContent).toContain("No AI News issues");
  });

  it("renders successful and failed cards safely and keeps API order", () => {
    app.renderNewsFeed([
      { status: "ok", sender_display_name: "<b>News</b>", received_at: "2026-10-15T10:00:00Z", subject: 'A "story"', bullets: ["<img src=x>", "Second"], score: 8, reason: "Clear & useful", gmail_url: "https://mail.google.com/mail/u/0/#all/a%2Fb" },
      { status: "failed", from_address: "failed@example.com", received_at: "2026-10-14T10:00:00Z", subject: "Failed subject", score: null, reason: null, error: "SECRET FAILURE", gmail_url: "https://mail.google.com/mail/u/0/#all/id" },
    ]);
    const cards = document.querySelectorAll("#newsFeed article");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("score 8/10");
    expect(cards[0].textContent).toContain("Why 8: Clear & useful");
    expect(cards[0].querySelector("a")?.getAttribute("rel")).toContain("noopener");
    expect(cards[0].innerHTML).not.toContain("<img src=x>");
    expect(cards[0].textContent).toContain("<img src=x>");
    expect(cards[1].classList.contains("failed")).toBe(true);
    expect(cards[1].textContent).toContain("Couldn't summarize");
    expect(cards[1].textContent).not.toContain("score null");
    expect(cards[1].textContent).not.toContain("Why");
    expect(cards[1].textContent).not.toContain("SECRET FAILURE");
    expect(document.querySelectorAll("#newsFeed a")).toHaveLength(2);
    app.renderNewsFeed([]);
    expect(document.getElementById("newsFeed")!.textContent).toContain("No AI News summaries");
  });

  it("renders sender fallback and escapes patterns", () => {
    app.renderNewsSenders([{ id: 3, pattern: '" onmouseover="alert(1)', display_name: "<script>bad</script>" }]);
    const el = document.getElementById("newsSenders")!;
    expect(el.innerHTML).not.toContain("<script>");
    expect(el.textContent).toContain("<script>bad</script>");
    app.renderNewsSenders([]);
    expect(el.textContent).toContain("use + AI News on the dashboard");
  });
});
