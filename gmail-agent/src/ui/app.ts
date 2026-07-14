import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { DB } from "../memory/db.js";
import { listActiveParcels, listAllParcels } from "../memory/parcels.js";
import { listDecisions } from "../memory/decisions.js";
import { getMeta, getLastChecked } from "../memory/meta.js";
import { listTodaysEmails, listUnread, listRecentEmails, startOfLocalDayIso } from "../memory/emails.js";
import { listRecentObservations } from "../memory/observations.js";
import { listRecentLogs } from "../memory/logs.js";
import { listTodaysFood, todaysTotals } from "../memory/food.js";
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
 * Build the read-only dashboard app. It only ever READS the DB — no Gmail, no OpenAI, no writes.
 * Automation lives in the separately-run heartbeat; this server just renders what's there and
 * pushes an SSE `update` when the DB changes (the server entry drives that via the poller).
 */
export function createApp(deps: AppDeps): express.Express {
  const { db, broadcaster } = deps;
  const app = express();

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
    const today = listTodaysEmails(db, startOfLocalDayIso());
    const unread = listUnread(db);
    const recent = listRecentEmails(db, 15);
    res.json({
      today,
      unread,
      recent,
      lastChecked: getLastChecked(db) ?? null,
      counts: { today: today.length, unread: unread.length, recent: recent.length },
    });
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
