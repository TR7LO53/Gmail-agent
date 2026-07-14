import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "../../src/memory/db.js";
import { upsertParcel } from "../../src/memory/parcels.js";
import { recordDecision } from "../../src/memory/decisions.js";
import { setMeta, setLastChecked } from "../../src/memory/meta.js";
import { upsertEmail } from "../../src/memory/emails.js";
import { logFoodItems } from "../../src/memory/food.js";
import { logEvent } from "../../src/memory/logs.js";
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

  const app = createApp({ db, broadcaster: new SseBroadcaster() });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

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
});
