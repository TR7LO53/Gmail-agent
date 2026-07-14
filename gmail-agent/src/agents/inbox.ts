import type { GmailClient } from "../gmail/client.js";
import type { DB } from "../memory/db.js";
import { gmailSearch } from "../tools/gmail-search.js";
import { upsertEmail, applyUnreadSnapshot } from "../memory/emails.js";
import { logEvent } from "../memory/logs.js";
import { ok, type ToolResponse } from "../tools/types.js";
import { trackedCategory } from "../config.js";

/**
 * Refresh the CURRENT unread set. A cheap, metadata-only Gmail search (no bodies, no LLM) run each
 * heartbeat tick: it records every unread email and clears the flag on anything that is no longer
 * unread. This is what makes "you have 2 unread emails" show up on the dashboard and stay accurate
 * after you read something.
 */
export interface RefreshUnreadDeps {
  gmail?: GmailClient;
  db: DB;
}

export async function refreshUnread(
  deps: RefreshUnreadDeps,
  opts: { maxResults?: number } = {},
): Promise<ToolResponse<{ unread: number }>> {
  const search = await gmailSearch(
    { isUnread: true, maxResults: opts.maxResults ?? 50, category: trackedCategory() },
    { gmail: deps.gmail },
  );

  if (!search.success || !search.data) {
    logEvent(deps.db, {
      source: "inbox",
      level: "error",
      message: `Unread scan failed: ${search.recovery ?? "unknown error"}`,
      data: { ...search.diagnostics },
    });
    return {
      success: false,
      recovery: search.recovery ?? "Unread search failed.",
      diagnostics: search.diagnostics,
    };
  }

  const rows = search.data.messages;
  for (const m of rows) {
    upsertEmail(deps.db, {
      id: m.id,
      thread_id: m.threadId,
      subject: m.subject,
      sender: m.from,
      internalDate: m.internalDate,
      is_unread: true,
    });
  }
  applyUnreadSnapshot(deps.db, rows.map((m) => m.id));

  logEvent(deps.db, {
    source: "inbox",
    message: `Unread scan → ${rows.length} unread`,
    data: { ...search.diagnostics, unread: rows.length },
  });

  return ok(
    { unread: rows.length },
    { diagnostics: { unread: rows.length }, next_action: "Open the dashboard to see unread mail." },
  );
}
