import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { auditedWrite, MissingFoodDataError } from "../memory/audit.js";
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
  deleteFoodLogRowReturningName,
  MissingManualMacrosError,
  FoodMacroRangeError,
  createManualFoodLogEntry,
  lastDayTotals,
  lastWeekAverage,
} from "../memory/food.js";
import { addPreset, DuplicatePresetError, listPresets, removePreset, updatePreset } from "../memory/presets.js";
import { logEvent } from "../memory/logs.js";
import { nutritionGoals } from "../config.js";
import { SseBroadcaster } from "./sse.js";
import {
  createMarketsService,
  getHoldings,
  isTimeframe,
  isWatchlistEntryId,
  saveManualHoldings,
  type MarketsDeps,
} from "../markets/service.js";

// Module-anchored — never process.cwd(). The server can be launched from either the repo root or
// gmail-agent/, exactly like the MCP entry point (see the cwd auth-bug fix).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "public");

const nonemptyName = z.string().refine((name) => name.trim().length > 0, "Enter a name.");
const weight = z.number().finite().positive();
const foodWeightInput = z.object({ qty: weight });
const foodId = z.object({
  id: z.string().regex(/^0*[1-9][0-9]*$/).transform(Number).refine(Number.isSafeInteger),
});
const presetName = z.object({ name: nonemptyName });
const macro = z.number().finite().nonnegative();
const macros = z.object({ kcal: macro, protein_g: macro, carbs_g: macro, fat_g: macro });
const presetFields = macros.extend({ aliases: z.array(z.string()).optional() });
const newPreset = presetFields.extend({ name: nonemptyName.transform((name) => name.trim()) });
const manualEntry = macros.partial().extend({
  name: nonemptyName.transform((name) => name.trim()),
  qty: weight,
});

const foodFieldErrors: Record<string, string> = {
  qty: "Weight must be a finite number greater than zero.",
  name: "Name must be non-empty text.",
  id: "Food id must be a positive safe integer.",
  kcal: "kcal must be a finite number of at least zero.",
  protein_g: "protein_g must be a finite number of at least zero.",
  carbs_g: "carbs_g must be a finite number of at least zero.",
  fat_g: "fat_g must be a finite number of at least zero.",
  aliases: "Aliases must be a list of strings.",
};

const foodWriteError: express.ErrorRequestHandler = (error, req, res, next) => {
  const isFoodWrite = req.method === "POST"
    ? /^\/api\/(food|presets)\/?$/i.test(req.path)
    : ["PUT", "DELETE"].includes(req.method) && /^\/api\/(food|presets)\/[^/]+\/?$/i.test(req.path);
  if (!isFoodWrite) {
    next(error);
    return;
  }

  if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body must be a valid JSON object." });
  } else if (error instanceof URIError) {
    res.status(400).json({ error: "Invalid URL parameter." });
  } else if (error instanceof z.ZodError) {
    const field = error.issues[0]?.path[0];
    res.status(400).json({ error: foodFieldErrors[String(field)] ?? "Request body must be a JSON object." });
  } else if (error instanceof MissingManualMacrosError || error instanceof FoodMacroRangeError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof DuplicatePresetError) {
    res.status(409).json({ error: error.message });
  } else {
    console.error("Food Data write failed:", error);
    res.status(500).json({ error: "Food Data write failed." });
  }
};

export interface AppDeps {
  db: DB;
  broadcaster: SseBroadcaster;
  /** Prices and the holdings check for the Markets tab; without it those two routes answer 503. */
  markets?: MarketsDeps;
}

/**
 * Build the dashboard app. Mostly a read-only view over the DB — no Gmail, no OpenAI. The
 * exceptions (see ADR 0002) are food data, AI News sender/interests settings and manual Strategy
 * holdings Snapshots. Every such edit is logged to `logs` with source "manual-edit". Automation
 * lives in the separately-run heartbeat; this server otherwise just renders what's there and pushes
 * an SSE `update` when the DB changes (the server entry drives that via the poller). Markets prices
 * are fetched live and never stored; opening the watchlist also starts the throttled holdings check.
 */
export function createApp(deps: AppDeps): express.Express {
  const { db, broadcaster } = deps;
  const app = express();
  app.use(express.json());
  const markets = deps.markets ? createMarketsService({ db, ...deps.markets }) : undefined;
  const marketsNow = deps.markets?.now ?? Date.now;

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
      logEvent(db, {
        source: "manual-edit",
        message: `Added AI News sender ${sender.pattern}`,
        data: { table: "news_senders", id: sender.id },
      });
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
      if (result.created) {
        logEvent(db, {
          source: "manual-edit",
          message: `Added AI News sender ${result.sender.pattern} from an email`,
          data: { table: "news_senders", id: result.sender.id, emailId: email.id },
        });
      }
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
    const sender = renameNewsSender(db, id, req.body.display_name.trim() || undefined);
    logEvent(db, {
      source: "manual-edit",
      message: `Renamed AI News sender #${id} to "${req.body.display_name.trim()}"`,
      data: { table: "news_senders", id },
    });
    res.json({ sender });
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
    logEvent(db, {
      source: "manual-edit",
      message: `Removed AI News sender #${id}`,
      data: { table: "news_senders", id },
    });
    res.json({ ok: true });
  });

  app.get("/api/news/interests", (_req, res) => res.json({ interests: getNewsInterests(db) }));
  app.put("/api/news/interests", (req, res) => {
    if (!req.body || typeof req.body.interests !== "string") {
      res.status(400).json({ error: "interests must be a string." });
      return;
    }
    setNewsInterests(db, req.body.interests);
    logEvent(db, { source: "manual-edit", message: "Updated AI News interests", data: { table: "meta" } });
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
    const entry = createManualFoodLogEntry(db, manualEntry.parse(req.body));
    res.status(201).json({ entry });
  });

  app.put("/api/food/:id", (req, res) => {
    const { id } = foodId.parse(req.params);
    const { qty } = foodWeightInput.parse(req.body);
    const target = { table: "food_log", id } as const;
    const entry = auditedWrite(db, () => {
      try {
        const value = updateFoodLogWeight(db, id, qty);
        return { value, entries: [{ ...target, action: "updated", name: value.name, qty }] };
      } catch (error) {
        if (!(error instanceof MissingFoodDataError)) throw error;
        return { missing: target, action: "updated" as const };
      }
    });
    if (!entry) {
      res.status(404).json({ error: `Food #${id} not found.` });
      return;
    }
    res.json({ entry });
  });

  app.delete("/api/food/:id", (req, res) => {
    const { id } = foodId.parse(req.params);
    const target = { table: "food_log", id } as const;
    const removed = auditedWrite(db, () => {
      const name = deleteFoodLogRowReturningName(db, id);
      if (name === undefined) return { missing: target, action: "deleted" as const };
      return { value: true, entries: [{ ...target, action: "deleted", name }] };
    });
    if (!removed) {
      res.status(404).json({ error: `Food #${id} not found.` });
      return;
    }
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
    const input = newPreset.parse(req.body);
    const preset = auditedWrite(db, () => {
      const value = addPreset(db, input);
      return { value, entries: [{ table: "food_presets", action: "created", name: value.name }] };
    });
    res.status(201).json({ preset });
  });

  app.put("/api/presets/:name", (req, res) => {
    const { name } = presetName.parse(req.params);
    const input = presetFields.parse(req.body);
    const target = { table: "food_presets", name } as const;
    const preset = auditedWrite(db, () => {
      try {
        const value = updatePreset(db, { ...input, name });
        return { value, entries: [{ ...target, action: "updated" }] };
      } catch (error) {
        if (!(error instanceof MissingFoodDataError)) throw error;
        return { missing: target, action: "updated" as const };
      }
    });
    if (!preset) {
      res.status(404).json({ error: `Preset "${name}" not found.` });
      return;
    }
    res.json({ preset });
  });

  app.delete("/api/presets/:name", (req, res) => {
    const { name } = presetName.parse(req.params);
    const target = { table: "food_presets", name } as const;
    const removed = auditedWrite(db, () => {
      if (!removePreset(db, name)) return { missing: target, action: "deleted" as const };
      return { value: true, entries: [{ ...target, action: "deleted" }] };
    });
    if (!removed) {
      res.status(404).json({ error: `Preset "${name}" not found.` });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/observations", (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
    res.json({ observations: listRecentObservations(db, limit) });
  });

  // Markets. A source failure is a normal 200 with `ok: false` so the UI can keep its old numbers;
  // 400 is only for bad parameters, 500 for a bug.
  const marketsError = (res: express.Response, error: unknown) => {
    console.error("Markets route failed:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Markets request failed." });
  };

  app.get("/api/markets/watchlist", async (_req, res) => {
    if (!markets) {
      res.status(503).json({ error: "Markets are not configured." });
      return;
    }
    try {
      res.json(await markets.getWatchlist());
    } catch (error) {
      marketsError(res, error);
    }
  });

  app.get("/api/markets/series", async (req, res) => {
    const { entry, tf } = req.query;
    if (!isWatchlistEntryId(entry)) {
      res.status(400).json({ error: "entry must be one of the Watchlist ids." });
      return;
    }
    if (!isTimeframe(tf)) {
      res.status(400).json({ error: "tf must be one of H1, H4, D1, W1, MN." });
      return;
    }
    if (!markets) {
      res.status(503).json({ error: "Markets are not configured." });
      return;
    }
    try {
      res.json(await markets.getSeries(entry, tf));
    } catch (error) {
      marketsError(res, error);
    }
  });

  app.get("/api/markets/holdings", (_req, res) => {
    try {
      res.json(getHoldings(db, marketsNow()));
    } catch (error) {
      marketsError(res, error);
    }
  });

  app.post("/api/markets/holdings", (req, res) => {
    try {
      const result = saveManualHoldings(db, marketsNow(), req.body);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.status(201).json(result.response);
    } catch (error) {
      marketsError(res, error);
    }
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

  app.use(foodWriteError);

  // Static dashboard (index.html served at "/").
  app.use(express.static(PUBLIC_DIR));

  return app;
}
