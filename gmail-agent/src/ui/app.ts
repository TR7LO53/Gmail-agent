import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { DB } from "../memory/db.js";
import { listActiveParcels, listAllParcels } from "../memory/parcels.js";
import { listDecisions } from "../memory/decisions.js";
import { getMeta, getLastChecked } from "../memory/meta.js";
import {
  getEmail,
  listTodaysEmails,
  listUnread,
  listRecentEmails,
  startOfLocalDayIso,
  startOfLocalDayNDaysAgoIso,
} from "../memory/emails.js";
import {
  addNewsSender,
  addNewsSenderFromEmail,
  getNewsInterests,
  listNewsFeed,
  listNewsSenders,
  matchSender,
  newsLeaderboard,
  removeNewsSender,
  renameNewsSender,
  setNewsInterests,
} from "../memory/news.js";
import { listRecentObservations } from "../memory/observations.js";
import { listRecentLogs } from "../memory/logs.js";
import {
  listTodaysFood,
  todaysTotals,
  updateFoodLogWeight,
  deleteFoodLogRow,
  createManualFoodLogEntry,
  lastDayTotals,
  lastWeekAverage,
} from "../memory/food.js";
import { addPreset, listPresets, removePreset, updatePreset } from "../memory/presets.js";
import { logEvent } from "../memory/logs.js";
import { nutritionGoals } from "../config.js";
import { SseBroadcaster } from "./sse.js";

// Module-anchored — never process.cwd(). The server can be launched from either the repo root or
// gmail-agent/, exactly like the MCP entry point (see the cwd auth-bug fix).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "public");

export interface AppDeps {
  db: DB;
  broadcaster: SseBroadcaster;
}

/**
 * Build the dashboard app. Mostly a read-only view over the DB — no Gmail, no OpenAI. The one
 * exceptions (see ADR 0002) are food data and AI News sender/interests settings. Food edits are
 * logged to `logs` with source "manual-edit". Automation lives in the separately-run
 * heartbeat; this server otherwise just renders what's there and pushes an SSE `update` when the DB
 * changes (the server entry drives that via the poller).
 */
export function createApp(deps: AppDeps): express.Express {
  const { db, broadcaster } = deps;
  const app = express();
  app.use(express.json());

  app.get("/api/parcels", (req, res) => {
    const all = req.query.all === "true" || req.query.all === "1";
    const parcels = all ? listAllParcels(db) : listActiveParcels(db);
    res.json({ all, count: parcels.length, parcels });
  });

  app.get("/api/summary", (_req, res) => {
    res.json({
      summary: getMeta(db, "daily_summary") ?? null,
      generatedAt: getMeta(db, "daily_summary_at") ?? null,
    });
  });

  app.get("/api/decisions", (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 20;
    res.json({ decisions: listDecisions(db, limit) });
  });

  app.get("/api/status", (_req, res) => {
    res.json({ lastChecked: getLastChecked(db) ?? null, serverTime: new Date().toISOString() });
  });

  app.get("/api/emails", (_req, res) => {
    const senders = listNewsSenders(db);
    const withNewsFlag = <T extends { sender?: string }>(emails: T[]) => emails.map((email) => ({
      ...email,
      in_ai_news: Boolean(matchSender(email.sender ?? "", senders)),
    }));
    const today = withNewsFlag(listTodaysEmails(db, startOfLocalDayIso()));
    const unread = withNewsFlag(listUnread(db));
    const recent = withNewsFlag(listRecentEmails(db, 15));
    res.json({
      today,
      unread,
      recent,
      lastChecked: getLastChecked(db) ?? null,
      counts: { today: today.length, unread: unread.length, recent: recent.length },
    });
  });

  app.get("/api/news", (_req, res) => {
    // 30 calendar days including today; local-day arithmetic handles DST boundaries.
    const since = startOfLocalDayNDaysAgoIso(29);
    const feed = listNewsFeed(db, since).map((item) => ({
      message_id: item.message_id,
      received_at: item.received_at,
      subject: item.subject,
      bullets: item.bullets,
      score: item.score ?? null,
      reason: item.reason ?? null,
      status: item.status,
      from_address: item.from_address,
      sender_id: item.sender_id,
      sender_display_name: item.sender.display_name?.trim() || item.from_address,
      gmail_url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(item.message_id)}`,
      ...(item.error !== undefined ? { error: item.error } : {}),
    }));
    res.json({ leaderboard: newsLeaderboard(db, since), feed });
  });

  app.get("/api/news/senders", (_req, res) => res.json({ senders: listNewsSenders(db) }));

  app.post("/api/news/senders", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.pattern !== "string" || !body.pattern.trim() ||
      (body.display_name !== undefined && typeof body.display_name !== "string") ||
      (body.added_at !== undefined && (typeof body.added_at !== "string" || !body.added_at.trim() || !Number.isFinite(Date.parse(body.added_at))))) {
      res.status(400).json({ error: "Expected pattern, optional display_name, and optional valid added_at." });
      return;
    }
    try {
      const sender = addNewsSender(db, body.pattern, body.display_name?.trim() || undefined,
        body.added_at === undefined ? undefined : new Date(body.added_at).toISOString());
      res.status(201).json({ sender });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid news sender pattern:")) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/api/news/senders/from-email", (req, res) => {
    const emailId = req.body?.emailId;
    if (typeof emailId !== "string" || !emailId.trim()) {
      res.status(400).json({ error: "emailId must be a non-empty string." });
      return;
    }
    const email = getEmail(db, emailId.trim());
    if (!email) {
      res.status(404).json({ error: `Email ${emailId} not found.` });
      return;
    }
    try {
      const result = addNewsSenderFromEmail(db, email);
      res.status(result.created ? 201 : 200).json({ sender: result.sender });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/news/senders/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Sender id must be a positive integer." });
      return;
    }
    if (!req.body || typeof req.body.display_name !== "string") {
      res.status(400).json({ error: "display_name must be a string." });
      return;
    }
    if (!listNewsSenders(db).some((sender) => sender.id === id)) {
      res.status(404).json({ error: `Active news sender ${id} not found.` });
      return;
    }
    res.json({ sender: renameNewsSender(db, id, req.body.display_name.trim() || undefined) });
  });

  app.delete("/api/news/senders/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Sender id must be a positive integer." });
      return;
    }
    if (!removeNewsSender(db, id)) {
      res.status(404).json({ error: `Active news sender ${id} not found.` });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/news/interests", (_req, res) => res.json({ interests: getNewsInterests(db) }));
  app.put("/api/news/interests", (req, res) => {
    if (!req.body || typeof req.body.interests !== "string") {
      res.status(400).json({ error: "interests must be a string." });
      return;
    }
    setNewsInterests(db, req.body.interests);
    res.json({ interests: getNewsInterests(db) });
  });

  app.get("/api/logs", (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
    res.json({ logs: listRecentLogs(db, limit) });
  });

  app.get("/api/food", (_req, res) => {
    const since = startOfLocalDayIso();
    res.json({
      entries: listTodaysFood(db, since),
      totals: todaysTotals(db, since),
      goals: nutritionGoals(),
    });
  });

  app.post("/api/food", (req, res) => {
    let entry;
    try {
      entry = createManualFoodLogEntry(db, req.body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    logEvent(db, {
      source: "manual-edit",
      message: `Logged "${entry.name}" (${entry.qty}g) manually`,
      data: { table: "food_log", id: entry.id },
    });
    res.status(201).json({ entry });
  });

  app.put("/api/food/:id", (req, res) => {
    const id = Number(req.params.id);
    let entry;
    try {
      entry = updateFoodLogWeight(db, id, Number(req.body.qty));
    } catch {
      res.status(404).json({ error: `food_log row ${id} not found.` });
      return;
    }
    logEvent(db, {
      source: "manual-edit",
      message: `Edited weight of food_log #${id} ("${entry.name}") to ${entry.qty}g`,
      data: { table: "food_log", id },
    });
    res.json({ entry });
  });

  app.delete("/api/food/:id", (req, res) => {
    const id = Number(req.params.id);
    const removed = deleteFoodLogRow(db, id);
    if (!removed) {
      res.status(404).json({ error: `food_log row ${id} not found.` });
      return;
    }
    logEvent(db, {
      source: "manual-edit",
      message: `Deleted food_log row #${id}`,
      data: { table: "food_log", id },
    });
    res.json({ ok: true });
  });

  app.get("/api/food/stats", (_req, res) => {
    const todayStart = startOfLocalDayIso();
    const yesterdayStart = startOfLocalDayNDaysAgoIso(1);
    const weekStart = startOfLocalDayNDaysAgoIso(6); // 7 calendar days including today
    res.json({
      lastDay: lastDayTotals(db, yesterdayStart, todayStart),
      lastWeekAverage: lastWeekAverage(db, weekStart),
    });
  });

  app.get("/api/presets", (_req, res) => {
    res.json({ presets: listPresets(db) });
  });

  app.post("/api/presets", (req, res) => {
    const preset = addPreset(db, req.body);
    logEvent(db, {
      source: "manual-edit",
      message: `Created preset "${preset.name}"`,
      data: { table: "food_presets", name: preset.name },
    });
    res.status(201).json({ preset });
  });

  app.put("/api/presets/:name", (req, res) => {
    const name = req.params.name;
    const preset = updatePreset(db, { ...req.body, name });
    logEvent(db, {
      source: "manual-edit",
      message: `Updated preset "${preset.name}"`,
      data: { table: "food_presets", name: preset.name },
    });
    res.json({ preset });
  });

  app.delete("/api/presets/:name", (req, res) => {
    const name = req.params.name;
    const removed = removePreset(db, name);
    if (!removed) {
      res.status(404).json({ error: `Preset "${name}" not found.` });
      return;
    }
    logEvent(db, {
      source: "manual-edit",
      message: `Deleted preset "${name}"`,
      data: { table: "food_presets", name },
    });
    res.json({ ok: true });
  });

  app.get("/api/observations", (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
    res.json({ observations: listRecentObservations(db, limit) });
  });

  app.get("/api/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    broadcaster.add(res);
    // Nudge this client to do its first render immediately.
    res.write(`event: update\ndata: ${JSON.stringify({ reason: "connected" })}\n\n`);
    req.on("close", () => broadcaster.remove(res));
  });

  // Static dashboard (index.html served at "/").
  app.use(express.static(PUBLIC_DIR));

  return app;
}
