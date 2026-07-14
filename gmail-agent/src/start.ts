import { logEnvStatus } from "./env.js";
import { exec } from "node:child_process";
import { ensureGmailAuth } from "./gmail/auth.js";
import { openDb } from "./memory/db.js";
import { openaiProvider } from "./llm/provider.js";
import { usdaProvider } from "./nutrition/provider.js";
import { openaiTranscriber } from "./llm/transcribe.js";
import { createApp } from "./ui/app.js";
import { SseBroadcaster, getDashboardSignature } from "./ui/sse.js";
import { startHeartbeat } from "./core/heartbeat.js";
import { startBot } from "./bot/discord.js";

/**
 * One-click launcher. Runs BOTH the heartbeat (automation) and the dashboard (pure viewer) in a
 * single process, then opens the browser. Meant to be started from a desktop shortcut / .bat so
 * there is nothing to type. Close the window (or Ctrl+C) to stop everything.
 */

const PORT = Number(process.env.PORT) || 3000;
const INTERVAL_MIN = Number(process.env.GGENT_INTERVAL_MIN) || 5;
const POLL_MS = 2500;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; ignore errors (user can open the URL manually)
}

logEnvStatus(["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USER_ID", "USDA_API_KEY", "OPENAI_API_KEY"]);

// Gmail setup, once, at startup. If the token is missing or expired this opens a browser to log in
// BEFORE anything runs — so Ggent reconnects itself instead of silently running on a dead token.
try {
  console.log("Checking Gmail connection...");
  const auth = await ensureGmailAuth();
  if (auth.status === "ok") console.log("✅ Gmail connected.");
  else if (auth.status === "reauthorized") console.log("✅ Gmail reconnected — fresh token saved.");
  else console.warn(`⚠️  Couldn't verify Gmail (${auth.message}). Continuing; will retry each check.`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`⚠️  Gmail login didn't complete: ${msg}`);
  console.error("   The dashboard will still open, but email/parcels won't update until you run `npm run auth`.");
}

const db = openDb();
const broadcaster = new SseBroadcaster();
const app = createApp({ db, broadcaster });

// Dashboard change-poller: push an SSE `update` whenever the heartbeat writes new data.
let lastSignature = getDashboardSignature(db);
const poller = setInterval(() => {
  const sig = getDashboardSignature(db);
  if (sig !== lastSignature) {
    lastSignature = sig;
    broadcaster.broadcast("update", { at: new Date().toISOString() });
  }
}, POLL_MS);

// Automation loop in the same process.
const heartbeat = startHeartbeat(
  { llm: openaiProvider, db },
  {
    intervalMs: INTERVAL_MIN * 60 * 1000,
    onTick: (r) => {
      const d = r.data;
      if (d) {
        console.log(
          `[${new Date().toLocaleTimeString()}] checked mail — ${d.classifier.tracked} new parcel(s), ${d.tracker.updated} updated, ${d.unread} unread`,
        );
      }
    },
    onError: (e) => console.error("Mail check failed:", e instanceof Error ? e.message : e),
  },
);

// Food-logging Discord bot (skips itself if DISCORD_BOT_TOKEN is unset).
const bot = startBot({
  llm: openaiProvider,
  nutrition: usdaProvider,
  db,
  transcribe: openaiTranscriber,
});

const server = app.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log("\n  ┌───────────────────────────────────────────────┐");
  console.log("  │  Ggent is running                              │");
  console.log(`  │  Dashboard: ${url.padEnd(34)}│`);
  console.log(`  │  Checking mail every ${String(INTERVAL_MIN).padEnd(2)} min                   │`);
  console.log("  │  Close this window to stop.                    │");
  console.log("  └───────────────────────────────────────────────┘\n");
  openBrowser(url);
});

function shutdown(): void {
  console.log("\nStopping Ggent...");
  heartbeat.stop();
  clearInterval(poller);
  if (bot) void bot.destroy();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
