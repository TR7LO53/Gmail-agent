import "../env.js";
import { openDb } from "../memory/db.js";
import { createApp } from "./app.js";
import { SseBroadcaster, getDashboardSignature } from "./sse.js";

/**
 * Stage 4 dashboard entry point (standalone, like src/mcp/server.ts).
 *
 * The server is a PURE VIEWER: it never scans, never touches Gmail or OpenAI. It reads the SQLite
 * DB and pushes an SSE `update` whenever the DB changes. Those changes come from a separately-run
 * `npm run heartbeat` (or `classify`/`track`) writing to the same DB (WAL allows a concurrent
 * reader). Bound to 127.0.0.1 — a personal, localhost-only tool.
 */

const PORT = Number(process.env.PORT) || 3000;
const POLL_MS = 2500;

const db = openDb();
const broadcaster = new SseBroadcaster();
const app = createApp({ db, broadcaster });

// Watch the DB for changes and fan out an SSE `update` only when something actually changed.
let lastSignature = getDashboardSignature(db);
const poller = setInterval(() => {
  const sig = getDashboardSignature(db);
  if (sig !== lastSignature) {
    lastSignature = sig;
    broadcaster.broadcast("update", { at: new Date().toISOString() });
  }
}, POLL_MS);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Ggent dashboard running at http://localhost:${PORT}  (read-only)`);
  console.log("Tip: run `npm run heartbeat` in another terminal to keep the data fresh.");
});

process.on("SIGINT", () => {
  console.log("\nStopping dashboard...");
  clearInterval(poller);
  server.close(() => process.exit(0));
});
