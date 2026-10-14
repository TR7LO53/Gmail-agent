// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const APP_JS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/ui/public/app.js");

/**
 * app.js is a plain (non-module) script that wires up live refresh() on load. Loading it via
 * `vm.runInContext` reproduces exactly how the browser evaluates it (top-level function
 * declarations become globals) without needing to touch its source. The tail of the script
 * (EventSource, DOM wiring for elements this test doesn't create) throws once execution reaches
 * it — irrelevant here since the render functions are already hoisted onto the context by then.
 */
function loadApp(): Record<string, any> {
  document.body.innerHTML = `
    <div id="food"></div>
    <button id="toggleFoods"></button>
    <div id="parcels"></div>
    <div id="summary"></div>
    <div id="decisions"></div>
    <button id="toggleDecisions"></button>
    <div id="logs"></div>
    <button id="toggleActivity"></button>
    <span id="unreadCount"></span>
    <div id="lastScanLine"></div>
    <div id="todayEmails"></div>
    <div id="emailsMoreRow"></div>
    <button id="toggleEmails"></button>
  `;
  const context = vm.createContext(window as any);
  const source = readFileSync(APP_JS_PATH, "utf-8");
  try {
    vm.runInContext(source, context);
  } catch {
    // Expected: the tail of the script wires up elements/EventSource this harness doesn't provide.
  }
  return context;
}

const makeEmails = (n: number) => ({
  recent: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, subject: `Subject ${i}`, sender: "a@b.c", received_at: null })),
  today: [],
  counts: { unread: 0, today: 0 },
  lastChecked: null,
});

describe("Today emails list", () => {
  it("shows only five emails by default, with a toggle for the rest", () => {
    const app = loadApp();
    app.renderTodayEmails(makeEmails(8));
    expect(document.querySelectorAll("#todayEmails .email").length).toBe(5);
    expect((document.getElementById("emailsMoreRow") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("toggleEmails")!.textContent).toBe("Show 3 more");
  });

  it("hides the toggle when there are five emails or fewer", () => {
    const app = loadApp();
    app.renderTodayEmails(makeEmails(5));
    expect(document.querySelectorAll("#todayEmails .email").length).toBe(5);
    expect((document.getElementById("emailsMoreRow") as HTMLElement).hidden).toBe(true);
  });
});

describe("Activity section", () => {
  it("is collapsed by default — no records visible", () => {
    const app = loadApp();
    app.renderLogs({ logs: [{ ts: "2026-10-14T10:00:00Z", level: "info", source: "heartbeat", message: "tick" }] });
    expect((document.getElementById("logs") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("toggleActivity")!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Decision history section", () => {
  it("is collapsed by default — no records visible", () => {
    const app = loadApp();
    app.renderDecisions({ decisions: [{ action_taken: "track", agent_reasoning: "x", timestamp: "2026-10-14T10:00:00Z" }] });
    expect((document.getElementById("decisions") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("toggleDecisions")!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("renderNutrition provenance tag", () => {
  let app: Record<string, any>;

  beforeEach(() => {
    app = loadApp();
  });

  it("shows a Preset tag for an entry with provenance 'preset'", () => {
    app.renderNutrition({
      entries: [
        { original: "jajko", name: "egg", qty: 100, kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10, provenance: "preset" },
      ],
      totals: { kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 },
      goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 },
    });
    expect(document.getElementById("food")!.innerHTML).toContain("Preset");
  });

  it("shows a Lookup tag for an entry with provenance 'lookup'", () => {
    app.renderNutrition({
      entries: [
        { original: "chleb", name: "bread", qty: 50, kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1, provenance: "lookup" },
      ],
      totals: { kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1 },
      goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 },
    });
    expect(document.getElementById("food")!.innerHTML).toContain("Lookup");
  });

  it("shows no tag for a legacy entry with no provenance", () => {
    app.renderNutrition({
      entries: [{ original: "jajko", name: "egg", qty: 100, kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 }],
      totals: { kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 },
      goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 },
    });
    const html = document.getElementById("food")!.innerHTML;
    expect(html).not.toContain("Preset");
    expect(html).not.toContain("Lookup");
  });

  it("lists each entry's kcal for a mix of preset- and lookup-sourced entries, without a total meter", () => {
    app.renderNutrition({
      entries: [
        { original: "jajko", name: "egg", qty: 100, kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10, provenance: "preset" },
        { original: "chleb", name: "bread", qty: 50, kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1, provenance: "lookup" },
      ],
      totals: { kcal: 230, protein_g: 15, carbs_g: 16, fat_g: 11 },
      goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 },
    });
    const html = document.getElementById("food")!.innerHTML;
    expect(html).toContain("150 kcal");
    expect(html).toContain("80 kcal");
    expect(html).not.toContain("meter");
  });
});
