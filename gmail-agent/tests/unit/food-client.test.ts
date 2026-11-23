// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/ui/public");
const html = readFileSync(path.join(publicDir, "index.html"), "utf8")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
const app = readFileSync(path.join(publicDir, "app.js"), "utf8");
const macros = { kcal: 100, protein_g: 3, carbs_g: 5, fat_g: 2 };
const food = { id: 42, name: "rice", qty: 100, ...macros };
const preset = { name: "milk / rice", aliases: ["pudding"], ...macros };

const tables = [
  { button: ".foodDeleteBtn", url: "/api/food/42", message: "#foodDeleteMessage", refresh: ["/api/food", "/api/food/stats"] },
  { button: ".presetDeleteBtn", url: "/api/presets/milk%20%2F%20rice", message: "#presetDeleteMessage", refresh: ["/api/presets"] },
];

async function boot(outcome: number | "offline" | "non-json", confirmDelete = true) {
  document.open();
  document.write(html);
  document.close();
  const confirm = vi.fn(() => confirmDelete);
  let foodExists = true;
  let presetExists = true;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "DELETE") {
      if (outcome === "offline") throw new Error("network error");
      if (outcome === "non-json") return new Response("<html/>", { status: 502 });
      if (outcome === 200 || outcome === 404) {
        if (url === tables[0].url) foodExists = false;
        if (url === tables[1].url) presetExists = false;
      }
      return Response.json({ error: "Delete could not be saved." }, { status: outcome });
    }
    if (options?.method === "POST") {
      return Response.json({ error: "Macros are required." }, { status: 400 });
    }
    const data: Record<string, unknown> = {
      "/api/parcels?all=false": { parcels: [] },
      "/api/summary": { summary: null },
      "/api/emails": { recent: [], today: [], unread: [], counts: { unread: 0, today: 0 } },
      "/api/food": { entries: foodExists ? [food] : [], totals: macros, goals: macros },
      "/api/food/stats": { lastDay: macros, lastWeekAverage: macros },
      "/api/decisions?limit=25": { decisions: [] },
      "/api/status": {},
      "/api/logs?limit=40": { logs: [] },
      "/api/presets": { presets: presetExists ? [preset] : [] },
    };
    return Response.json(data[url] ?? {});
  });
  class EventSource {
    addEventListener() {}
  }
  vm.runInContext(app, vm.createContext({
    window, document, fetch, confirm, EventSource, FormData, Date, URL, setTimeout, clearTimeout, console,
  }));
  document.getElementById("tabFoodData")!.click();
  await vi.waitFor(() => expect(document.querySelectorAll(".foodDeleteBtn, .presetDeleteBtn")).toHaveLength(2));
  fetch.mockClear();
  return { fetch, confirm };
}

describe("Food Data deletes", () => {
  describe.each(tables)("$button", ({ button, url, message, refresh }) => {
    it.each([200, 404])("refreshes after %i and keeps the status visible", async (status) => {
      const { fetch, confirm } = await boot(status);
      const announcement = document.querySelector(message)!;
      announcement.textContent = "Old message.";
      document.querySelector<HTMLButtonElement>(button)!.click();
      expect(announcement.textContent).toBe("");
      await vi.waitFor(() => expect(document.querySelector(button)).toBeNull());
      expect(confirm).toHaveBeenCalledOnce();
      expect(fetch.mock.calls).toEqual([[url, { method: "DELETE" }], ...refresh.map((path) => [path])]);
      expect(document.querySelector(message)).toBe(announcement);
      expect(announcement.textContent).toBe(status === 404 ? "Already deleted." : "");
    });

    it.each([
      [500, "Delete could not be saved."],
      ["non-json", "Delete failed (502)."],
      ["offline", "Delete failed. Could not connect to the server."],
    ] as const)("keeps the row and shows the error after %s", async (outcome, error) => {
      const { fetch } = await boot(outcome);
      const rowButton = document.querySelector<HTMLButtonElement>(button)!;
      rowButton.click();
      await vi.waitFor(() => expect(document.querySelector(message)?.textContent).toBe(error));
      expect(document.querySelector(button)).toBe(rowButton);
      expect(fetch.mock.calls).toEqual([[url, { method: "DELETE" }]]);
    });

    it("sends no request when the confirmation is cancelled", async () => {
      const { fetch, confirm } = await boot(200, false);
      document.querySelector<HTMLButtonElement>(button)!.click();
      expect(confirm).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("omits blank Manual Entry macros and sends a typed zero after switching away from a matching Alias", async () => {
    const { fetch } = await boot(200);
    const form = document.querySelector<HTMLFormElement>("#foodCreateForm")!;
    const qty = form.querySelector<HTMLInputElement>('[name="qty"]')!;
    const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
    const kcal = form.querySelector<HTMLInputElement>('[name="kcal"]')!;
    qty.value = "50";
    name.value = "pudding";
    name.dispatchEvent(new Event("input"));
    expect(kcal.disabled).toBe(true);
    expect(kcal.value).toBe("50");

    name.value = "unmatched";
    name.dispatchEvent(new Event("input"));
    expect(kcal.disabled).toBe(false);
    expect(form.querySelector<HTMLInputElement>('[name="protein_g"]')!.value).toBe("");
    kcal.value = "0";
    form.requestSubmit();
    expect(fetch).toHaveBeenCalledWith("/api/food", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "unmatched", qty: 50, kcal: 0 }),
    }));
    await vi.waitFor(() => expect(document.querySelector("#foodCreateErr")?.textContent).toBe("Macros are required."));
  });
});
