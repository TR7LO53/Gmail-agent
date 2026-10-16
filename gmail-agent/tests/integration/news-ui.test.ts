import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "../../src/memory/db.js";
import { upsertEmail } from "../../src/memory/emails.js";
import { addNewsSender, removeNewsSender, saveNewsSummary } from "../../src/memory/news.js";
import { createApp } from "../../src/ui/app.js";
import { SseBroadcaster } from "../../src/ui/sse.js";
import type { DB } from "../../src/memory/db.js";

describe("AI News API", () => {
  let db: DB;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp({ db, broadcaster: new SseBroadcaster() }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  async function json(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: await response.json() as any };
  }

  it("supports sender CRUD, rejects bad patterns, and round-trips interests", async () => {
    expect((await json("/api/news/senders")).body.senders).toEqual([]);
    expect((await json("/api/news/senders", "POST", { pattern: "*.example.com" })).response.status).toBe(400);
    const created = await json("/api/news/senders", "POST", { pattern: " Person@Example.com ", display_name: "Person" });
    expect(created.response.status).toBe(201);
    const id = created.body.sender.id;
    expect(created.body.sender.pattern).toBe("person@example.com");
    expect((await json(`/api/news/senders/${id}`, "PUT", { display_name: "Renamed" })).body.sender.display_name).toBe("Renamed");
    expect((await json(`/api/news/senders/${id}`, "DELETE")).response.status).toBe(200);
    expect((await json("/api/news/senders")).body.senders).toEqual([]);
    expect((await json("/api/news/interests", "PUT", { interests: "Line one\nLine two" })).body.interests).toBe("Line one\nLine two");
    expect((await json("/api/news/interests", "PUT", { interests: "" })).body.interests).toBe("");
  });

  it("adds an exact sender from an email just before its received time and avoids duplicates", async () => {
    upsertEmail(db, { id: "msg/from", subject: "Update", sender: '"News Team" <News@Example.com>', internalDate: String(Date.parse("2026-10-16T08:00:00.000Z")), is_unread: true });
    const first = await json("/api/news/senders/from-email", "POST", { emailId: "msg/from" });
    expect(first.response.status).toBe(201);
    expect(first.body.sender).toMatchObject({ pattern: "news@example.com", display_name: "News Team", added_at: "2026-10-16T07:59:59.999Z" });
    expect((await json("/api/news/senders/from-email", "POST", { emailId: "msg/from" })).response.status).toBe(200);
    expect((await json("/api/news/senders")).body.senders).toHaveLength(1);
    expect((await json("/api/news/senders/from-email", "POST", { emailId: "missing" })).response.status).toBe(404);
  });

  it("restarts a removed sender at the clicked email instead of its old start date", async () => {
    const old = addNewsSender(db, "news@example.com", "News", "2026-01-01T00:00:00.000Z");
    removeNewsSender(db, old.id);
    upsertEmail(db, { id: "msg/again", subject: "Back", sender: "News <news@example.com>", internalDate: String(Date.parse("2026-10-16T08:00:00.000Z")), is_unread: true });
    const again = await json("/api/news/senders/from-email", "POST", { emailId: "msg/again" });
    expect(again.response.status).toBe(201);
    expect(again.body.sender).toMatchObject({ id: old.id, added_at: "2026-10-16T07:59:59.999Z" });
  });

  it("logs every sender and interests edit as a manual edit", async () => {
    const created = await json("/api/news/senders", "POST", { pattern: "@example.com", display_name: "Ex" });
    const id = created.body.sender.id;
    await json(`/api/news/senders/${id}`, "PUT", { display_name: "Example" });
    await json(`/api/news/senders/${id}`, "DELETE");
    await json("/api/news/interests", "PUT", { interests: "Agents" });
    upsertEmail(db, { id: "msg/log", subject: "Hi", sender: "A <a@other.com>", internalDate: String(Date.parse("2026-10-16T08:00:00.000Z")), is_unread: true });
    await json("/api/news/senders/from-email", "POST", { emailId: "msg/log" });
    await json("/api/news/senders/from-email", "POST", { emailId: "msg/log" }); // already matched: no second log
    const logs = db.prepare("SELECT message FROM logs WHERE source = 'manual-edit' ORDER BY id").all() as { message: string }[];
    expect(logs.map((row) => row.message)).toEqual([
      "Added AI News sender @example.com",
      'Renamed AI News sender #1 to "Example"',
      "Removed AI News sender #1",
      "Updated AI News interests",
      "Added AI News sender a@other.com from an email",
    ]);
  });

  it("returns feed shape, exact/domain email flags, and sender soft removal", async () => {
    const domain = addNewsSender(db, "@example.com", "Example News");
    addNewsSender(db, "person@exact.com");
    const stamp = new Date().toISOString();
    upsertEmail(db, { id: "exact", sender: "person@exact.com", internalDate: String(Date.now()), is_unread: true });
    upsertEmail(db, { id: "domain", sender: "Other <writer@example.com>", internalDate: String(Date.now()), is_unread: true });
    upsertEmail(db, { id: "outsider", sender: "writer@evil-example.com", internalDate: String(Date.now()), is_unread: true });
    saveNewsSummary(db, { message_id: "id/with space", sender_id: domain.id, from_address: "writer@example.com", subject: "Brief", received_at: stamp, status: "failed", bullets: ["One"], error: "retry" });

    const emails = (await json("/api/emails")).body;
    for (const list of [emails.today, emails.unread, emails.recent]) {
      expect(list.find((item: any) => item.id === "exact")?.in_ai_news).toBe(true);
      expect(list.find((item: any) => item.id === "domain")?.in_ai_news).toBe(true);
      expect(list.find((item: any) => item.id === "outsider")?.in_ai_news).toBe(false);
    }
    const news = (await json("/api/news")).body;
    expect(news.leaderboard).toEqual([]);
    expect(news.feed[0]).toMatchObject({
      message_id: "id/with space", score: null, reason: null, status: "failed", bullets: ["One"], error: "retry",
      sender_display_name: "Example News", gmail_url: "https://mail.google.com/mail/u/0/#all/id%2Fwith%20space",
    });
    removeNewsSender(db, domain.id);
    expect((await json("/api/news")).body.feed).toEqual([]);
  });
});
