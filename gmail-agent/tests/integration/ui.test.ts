import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "../../src/memory/db.js";
import { upsertParcel } from "../../src/memory/parcels.js";
import { recordDecision } from "../../src/memory/decisions.js";
import { setMeta, setLastChecked } from "../../src/memory/meta.js";
import { upsertEmail } from "../../src/memory/emails.js";
import { logFoodItems } from "../../src/memory/food.js";
import { listRecentLogs, logEvent } from "../../src/memory/logs.js";
import { addPreset, listPresets } from "../../src/memory/presets.js";
import { createApp } from "../../src/ui/app.js";
import { SseBroadcaster } from "../../src/ui/sse.js";
import type { DB } from "../../src/memory/db.js";

let db: DB;
let server: Server;
let base: string;

beforeAll(async () => {
  db = openDb(":memory:");

  upsertParcel(db, { tracking_number: "ACTIVE1", carrier: "DHL", status: "in_transit", email_id: "m1" });
  upsertParcel(db, { tracking_number: "DONE1", carrier: "InPost", status: "delivered", email_id: "m2" });
  recordDecision(db, {
    timestamp: "2026-07-01T10:00:00.000Z",
    email_id: "m1",
    action_taken: "track",
    agent_reasoning: "DHL shipment",
    outcome: "DHL ACTIVE1 → in_transit",
  });
  setMeta(db, "daily_summary", "You have 1 parcel in transit.");
  setMeta(db, "daily_summary_at", "2026-07-01T10:05:00.000Z");
  setLastChecked(db, "2026-07-01T10:05:00.000Z");

  upsertEmail(db, { id: "e1", subject: "Unread one", sender: "a@dhl.com", internalDate: String(Date.now()), is_unread: true });
  upsertEmail(db, { id: "e2", subject: "Read one", sender: "b@x.com", internalDate: String(Date.now()), is_unread: false });

  logFoodItems(db, {
    source: "text",
    raw_input: "2 jajka",
    query_en: "2 eggs",
    items: [{ original: "jajko", name: "egg", qty: 100, kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 }],
  });

  logEvent(db, { source: "gmail_search", message: "Inbox scan → 3 message(s)", data: { returned: 3 } });

  addPreset(db, { name: "chicken breast", kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 });

  const app = createApp({ db, broadcaster: new SseBroadcaster() });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

const macros = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };

type InvalidWrite = [method: string, url: string, input: string | undefined, error: string];
const invalidWrites: InvalidWrite[] = [];
const foodPost = "/api/food";
const foodPut = "/api/food/1";
const presetPost = "/api/presets";
const presetPut = "/api/presets/chicken%20breast";
const invalidNumber = "RAW_INFINITY";

function invalid(method: string, url: string, body: unknown, error: string) {
  const json = JSON.stringify(body)?.replace('"RAW_INFINITY"', "1e309");
  invalidWrites.push([method, url, json, error]);
}

for (const qty of [-1, 0, undefined, null, "50", true, invalidNumber]) {
  invalid("POST", foodPost, { name: "chicken breast", qty }, "Weight");
  invalid("PUT", foodPut, { qty }, "Weight");
}
for (const name of [undefined, "", "   ", 123]) {
  invalid("POST", foodPost, { name, qty: 50, ...macros }, "Name");
  invalid("POST", presetPost, { name, ...macros }, "Name");
}
for (const id of ["0", "-1", "1.5", "abc", "9007199254740993"]) {
  invalid("PUT", `/api/food/${id}`, { qty: 50 }, "Food id");
  invalid("DELETE", `/api/food/${id}`, undefined, "Food id");
}
invalid("PUT", "/api/presets/%20", macros, "Name");
invalid("DELETE", "/api/presets/%20", undefined, "Name");

for (const field of Object.keys(macros)) {
  for (const value of [undefined, -1, "1", invalidNumber]) {
    invalid("POST", foodPost, { name: "unmatched", qty: 50, ...macros, [field]: value },
      value === undefined ? "macros are required" : field);
    invalid("POST", presetPost, { name: "unused", ...macros, [field]: value }, field);
    invalid("PUT", presetPut, { ...macros, [field]: value }, field);
  }
}
invalid("POST", foodPost, { name: "chicken breast", qty: 50, kcal: null }, "kcal");
for (const aliases of ["invalid", ["valid", 123], null]) {
  invalid("POST", presetPost, { name: "unused", ...macros, aliases }, "Aliases");
  invalid("PUT", presetPut, { ...macros, aliases }, "Aliases");
}

for (const [method, url, missing] of [
  ["POST", foodPost, "Name"], ["PUT", foodPut, "Weight"],
  ["POST", presetPost, "kcal"], ["PUT", presetPut, "kcal"],
]) {
  invalidWrites.push([method, url, '{"name":', "valid JSON"]);
  invalid(method, url, [], "JSON object");
  invalid(method, url, undefined, missing);
}

function write(method: string, url: string, body?: string, origin = base) {
  return fetch(`${origin}${url}`, {
    method, headers: { "Content-Type": "application/json" }, body,
  });
}

function snapshotFoodData(database = db) {
  return {
    food: database.prepare("SELECT * FROM food_log ORDER BY id").all(),
    presets: listPresets(database),
    logs: listRecentLogs(database),
  };
}

function expectActivity(message: string, data: Record<string, unknown>) {
  expect(listRecentLogs(db, 1)).toEqual([
    expect.objectContaining({ source: "manual-edit", level: "info", message, data }),
  ]);
}

describe("dashboard API", () => {
  it("GET /api/parcels returns only active parcels by default", async () => {
    const res = await fetch(`${base}/api/parcels`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.count).toBe(1);
    expect(body.parcels[0].tracking_number).toBe("ACTIVE1");
  });

  it("GET /api/parcels?all=true includes delivered parcels", async () => {
    const body: any = await (await fetch(`${base}/api/parcels?all=true`)).json();
    expect(body.count).toBe(2);
    expect(body.parcels.map((p: { tracking_number: string }) => p.tracking_number).sort()).toEqual([
      "ACTIVE1",
      "DONE1",
    ]);
  });

  it("GET /api/summary returns the stored digest", async () => {
    const body: any = await (await fetch(`${base}/api/summary`)).json();
    expect(body.summary).toBe("You have 1 parcel in transit.");
    expect(body.generatedAt).toBe("2026-07-01T10:05:00.000Z");
  });

  it("GET /api/decisions honours the limit and returns rows", async () => {
    const body: any = await (await fetch(`${base}/api/decisions?limit=5`)).json();
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].action_taken).toBe("track");
  });

  it("GET /api/emails returns today + unread + counts", async () => {
    const body: any = await (await fetch(`${base}/api/emails`)).json();
    expect(body.counts.today).toBe(2);
    expect(body.counts.unread).toBe(1);
    expect(body.unread[0].id).toBe("e1");
  });

  it("GET /api/emails includes recent emails and lastChecked", async () => {
    const body: any = await (await fetch(`${base}/api/emails`)).json();
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.counts.recent).toBe(body.recent.length);
    expect("lastChecked" in body).toBe(true);
  });

  it("GET /api/logs returns activity entries newest-first", async () => {
    const body: any = await (await fetch(`${base}/api/logs?limit=10`)).json();
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs[0].source).toBe("gmail_search");
    expect(body.logs[0].message).toContain("Inbox scan");
  });

  it("GET /api/food returns entries, totals and goals", async () => {
    const body: any = await (await fetch(`${base}/api/food`)).json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].original).toBe("jajko"); // per-item original name exposed
    expect(body.totals.kcal).toBe(150);
    expect(body.goals.kcal).toBeGreaterThan(0);
  });

  it("GET /api/status returns lastChecked", async () => {
    const body: any = await (await fetch(`${base}/api/status`)).json();
    expect(body.lastChecked).toBe("2026-07-01T10:05:00.000Z");
    expect(body.serverTime).toBeTruthy();
  });

  it("GET / serves the dashboard HTML", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Ggent");
  });

  it("unknown path returns 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("PUT /api/food/:id edits weight and logs a manual-edit entry", async () => {
    const [before] = (await (await fetch(`${base}/api/food`)).json()).entries;
    const res = await fetch(`${base}/api/food/${before.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qty: 200 }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.entry.qty).toBe(200);
    expect(body.entry.kcal).toBe(300); // proportional fallback: 150 kcal @ 100g -> 300 @ 200g

    expectActivity('Updated food "egg" (200 g)', { table: "food_log", id: before.id });
  });

  it("DELETE /api/food/:id removes the row and logs a manual-edit entry", async () => {
    const [row] = (await (await fetch(`${base}/api/food`)).json()).entries;
    const res = await fetch(`${base}/api/food/${row.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const after: any = await (await fetch(`${base}/api/food`)).json();
    expect(after.entries.find((e: { id: number }) => e.id === row.id)).toBeUndefined();

    expectActivity('Deleted food "egg"', { table: "food_log", id: row.id });
  });

  it("GET /api/presets returns every stored preset", async () => {
    const body: any = await (await fetch(`${base}/api/presets`)).json();
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0].name).toBe("chicken breast");
    expect(body.presets[0].kcal).toBe(165);
  });

  it("POST /api/presets creates a preset and logs a manual-edit entry", async () => {
    const res = await fetch(`${base}/api/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "oatmeal", kcal: 389, protein_g: 16.9, carbs_g: 66.3, fat_g: 6.9 }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.preset.name).toBe("oatmeal");

    const list: any = await (await fetch(`${base}/api/presets`)).json();
    expect(list.presets.map((p: { name: string }) => p.name)).toContain("oatmeal");

    expectActivity('Created preset "oatmeal"', { table: "food_presets", name: "oatmeal" });
  });

  it("PUT /api/presets/:name updates macros and logs a manual-edit entry", async () => {
    const res = await fetch(`${base}/api/presets/${encodeURIComponent("chicken breast")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kcal: 170, protein_g: 32, carbs_g: 0, fat_g: 4 }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.preset.kcal).toBe(170);

    expectActivity('Updated preset "chicken breast"', { table: "food_presets", name: "chicken breast" });
  });

  it("DELETE /api/presets/:name removes the preset and logs a manual-edit entry", async () => {
    const res = await fetch(`${base}/api/presets/${encodeURIComponent("oatmeal")}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const list: any = await (await fetch(`${base}/api/presets`)).json();
    expect(list.presets.map((p: { name: string }) => p.name)).not.toContain("oatmeal");

    expectActivity('Deleted preset "oatmeal"', { table: "food_presets", name: "oatmeal" });
  });

  it("POST /api/food with a matching preset auto-fills macros and logs a manual-edit entry", async () => {
    const res = await fetch(`${base}/api/food`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "chicken breast", qty: 200 }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.entry.source).toBe("manual");
    expect(body.entry.provenance).toBe("preset");
    expect(body.entry.kcal).toBe(340); // chicken breast preset was updated to 170 kcal/100g above, scaled to 200g

    expectActivity('Created food "chicken breast" (200 g)', { table: "food_log", id: body.entry.id });
  });

  it("POST /api/food with no matching preset creates one from the typed macros", async () => {
    const res = await fetch(`${base}/api/food`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zzz-new-food", qty: 100, kcal: 250, protein_g: 5, carbs_g: 40, fat_g: 8 }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.entry.kcal).toBe(250);

    const presets: any = await (await fetch(`${base}/api/presets`)).json();
    expect(presets.presets.some((p: { name: string }) => p.name === "zzz-new-food")).toBe(true);
  });

  it("POST /api/food with no matching preset and no macros returns 400", async () => {
    const res = await fetch(`${base}/api/food`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zzz-no-macros", qty: 100 }),
    });
    expect(res.status).toBe(400);
  });

  it.each([
    ["PUT", "/api/food/999999", { qty: 1 }, "edit food #999999", { table: "food_log", id: 999999 }],
    ["DELETE", "/api/food/999999", undefined, "delete food #999999", { table: "food_log", id: 999999 }],
    ["PUT", "/api/presets/missing", macros, 'edit preset "missing"', { table: "food_presets", name: "missing" }],
    ["DELETE", "/api/presets/missing", undefined, 'delete preset "missing"', { table: "food_presets", name: "missing" }],
  ] as const)("%s %s records exactly one Activity entry for a missing record", async (method, url, body, subject, data) => {
    const before = snapshotFoodData();
    const response = await write(method, url, JSON.stringify(body));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.stringContaining("not found") });
    expectActivity(`Attempted to ${subject}, but it no longer exists.`, data);
    const after = snapshotFoodData();
    expect({ ...after, logs: after.logs.slice(1) }).toEqual(before);
  });

  it("returns 409 for a duplicate name and preserves the existing Preset and Activity", async () => {
    const before = snapshotFoodData();
    const response = await write("POST", "/api/presets", JSON.stringify({ name: " chicken breast ", ...macros }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Preset "chicken breast" already exists.' });
    expect(snapshotFoodData()).toEqual(before);
  });

  it("accepts a fractional weight, zero macros, omitted aliases and encoded Preset names", async () => {
    const name = "rice / milk";
    const created = await write("POST", "/api/presets", JSON.stringify({ name: ` ${name} `, ...macros }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ preset: { id: expect.any(Number), name, aliases: [], ...macros } });
    const url = `/api/presets/${encodeURIComponent(name)}`;
    const edited = await write("PUT", url, JSON.stringify({ ...macros, name: "cannot rename" }));
    expect(edited.status).toBe(200);
    expect((await edited.json()).preset.name).toBe(name);
    const food = await write("POST", "/api/food", JSON.stringify({ name: ` ${name} `, qty: 12.5 }));
    expect(food.status).toBe(201);
    expect((await food.json()).entry).toMatchObject({ name, qty: 12.5, ...macros });
    expect(await (await write("DELETE", url)).json()).toEqual({ ok: true });
  });

  it("accepts representable macros at extreme weights without returning null values", async () => {
    const tiny = await write("POST", foodPost, JSON.stringify({ name: "tiny zero", qty: 1e-308, ...macros }));
    expect(tiny.status).toBe(201);
    expect((await tiny.json()).entry).toMatchObject({ qty: 1e-308, ...macros });

    const large = await write("POST", foodPost, JSON.stringify({
      name: "large value", qty: 100, ...macros, protein_g: 1e308,
    }));
    expect(large.status).toBe(201);
    expect((await large.json()).entry.protein_g).toBe(1e308);

    const before = snapshotFoodData();
    const overflow = await write("POST", foodPost, JSON.stringify({
      name: "unrepresentable", qty: 1e-308, ...macros, protein_g: 100,
    }));
    expect(overflow.status).toBe(400);
    expect(await overflow.json()).toEqual({ error: expect.stringContaining("supported number range") });
    expect(snapshotFoodData()).toEqual(before);
  });

  it("uses the exact path name for a legacy Preset stored with spaces", async () => {
    const name = "  legacy rice  ";
    addPreset(db, { name, ...macros });
    const url = `/api/presets/${encodeURIComponent(name)}`;
    const edited = await write("PUT", url, JSON.stringify({ ...macros, kcal: 1 }));
    expect(edited.status).toBe(200);
    expect((await edited.json()).preset).toMatchObject({ name, kcal: 1 });
    expect(await (await write("DELETE", url)).json()).toEqual({ ok: true });
  });

  it.each([
    ["Activity for a saved row", "POST", "/api/presets", "logs"],
    ["Activity for a missing row", "DELETE", "/api/food/123", "logs"],
    ["a data mutation", "POST", "/api/presets", "food_presets"],
  ])("returns a general 500 when %s fails", async (_case, method, url, table) => {
    const isolated = openDb(":memory:");
    const listener = createApp({ db: isolated, broadcaster: new SseBroadcaster() }).listen(0, "127.0.0.1");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await new Promise<void>((resolve, reject) => listener.once("listening", resolve).once("error", reject));
      const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      isolated.exec(`CREATE TRIGGER reject_write BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'private SQLite failure'); END`);
      const before = snapshotFoodData(isolated);
      const response = await write(method, url, method === "POST"
        ? JSON.stringify({ name: "unused", ...macros })
        : undefined, origin);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Food Data write failed." });
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "private SQLite failure" }));
      expect(snapshotFoodData(isolated)).toEqual(before);
    } finally {
      logged.mockRestore();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      isolated.close();
    }
  });

  it.each(invalidWrites)("%s %s rejects invalid input %s without changing Food Data", async (method, url, input, error) => {
    const before = snapshotFoodData();
    const response = await write(method, url, input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining(error) });
    expect(snapshotFoodData()).toEqual(before);
  });

  it("GET /api/food/stats returns lastDay and lastWeekAverage totals", async () => {
    const res = await fetch(`${base}/api/food/stats`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.lastDay).toHaveProperty("kcal");
    expect(body.lastWeekAverage).toHaveProperty("kcal");
  });

  it("serves the Markets tab and its scripts as static files", async () => {
    const page = await fetch(`${base}/`);
    expect(await page.text()).toContain('id="view-markets"');
    const script = await fetch(`${base}/markets.js`);
    expect(script.status).toBe(200);
    const lib = await fetch(`${base}/vendor/lightweight-charts.standalone.production.js`);
    expect(lib.status).toBe(200);
    expect(await lib.text()).toContain("Lightweight Charts");
  });
});
