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
    <div id="parcels"></div>
    <div id="summary"></div>
    <div id="decisions"></div>
    <div id="logs"></div>
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

  it("keeps the kcal total meter correct for a mix of preset- and lookup-sourced entries", () => {
    app.renderNutrition({
      entries: [
        { original: "jajko", name: "egg", qty: 100, kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10, provenance: "preset" },
        { original: "chleb", name: "bread", qty: 50, kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1, provenance: "lookup" },
      ],
      totals: { kcal: 230, protein_g: 15, carbs_g: 16, fat_g: 11 },
      goals: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 },
    });
    expect(document.getElementById("food")!.innerHTML).toContain("230");
  });
});
