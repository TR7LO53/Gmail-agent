import type { DB } from "../memory/db.js";
import { getLastChecked } from "../memory/meta.js";

/**
 * Minimal Server-Sent-Events fan-out. The dashboard server holds one broadcaster; each browser
 * that opens `/api/stream` registers its response here. When the DB changes, the server calls
 * `broadcast("update", ...)` and every connected client gets an event and refetches.
 *
 * Kept dependency-free and framework-agnostic (only needs `write`/`end`) so it is unit-testable
 * with a fake response object.
 */

export interface SseClient {
  write(chunk: string): void;
  end?(): void;
}

export class SseBroadcaster {
  private clients = new Set<SseClient>();

  get size(): number {
    return this.clients.size;
  }

  /** Register a client and send an initial comment so the connection is established immediately. */
  add(client: SseClient): void {
    try {
      client.write(": connected\n\n");
    } catch {
      return; // never register a client we can't even greet
    }
    this.clients.add(client);
  }

  remove(client: SseClient): void {
    this.clients.delete(client);
  }

  /** Send a named event with a JSON payload to every connected client. */
  broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        // A dead socket — drop it so a broken client can't wedge the loop.
        this.clients.delete(client);
      }
    }
  }
}

/**
 * A cheap change token for the dashboard. It changes whenever any dashboard-relevant write happens
 * — the heartbeat (last_checked), the classifier/tracker (new decisions), or a status update
 * (parcels.last_update) — so the server can poll it and push an SSE `update` only on real changes.
 */
export function getDashboardSignature(db: DB): string {
  const decisions = db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number };
  const parcels = db.prepare("SELECT MAX(last_update) AS m FROM parcels").get() as {
    m: string | null;
  };
  const emails = db
    .prepare("SELECT COUNT(*) AS n, MAX(last_seen) AS m, SUM(is_unread) AS u FROM emails")
    .get() as { n: number; m: string | null; u: number | null };
  const food = db.prepare("SELECT COUNT(*) AS n, MAX(ts) AS m FROM food_log").get() as {
    n: number;
    m: string | null;
  };
  const logs = db.prepare("SELECT MAX(id) AS m FROM logs").get() as { m: number | null };
  return `${getLastChecked(db) ?? ""}|${decisions.n}|${parcels.m ?? ""}|${emails.n}|${emails.m ?? ""}|${emails.u ?? 0}|${food.n}|${food.m ?? ""}|${logs.m ?? 0}`;
}
