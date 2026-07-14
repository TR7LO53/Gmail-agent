import { z } from "zod";
import { getGmailClient, type GmailClient } from "../gmail/client";
import { buildQuery } from "../gmail/query";
import { getHeader, hasAttachment } from "../gmail/parse";
import { ok, type ToolResponse } from "./types";
import { mapError } from "./errors";

export const searchInputSchema = z.object({
  from: z.string().optional(),
  to: z.array(z.string()).optional(),
  subject: z.string().optional(),
  query: z.string().optional(),
  label: z.string().optional(),
  category: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  hasAttachment: z.boolean().optional(),
  isUnread: z.boolean().optional(),
  maxResults: z.number().int().positive().max(100).optional(),
  pageToken: z.string().optional(),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

export interface SearchResultRow {
  id: string;
  threadId: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  /** Gmail internalDate (ms since epoch, as a string) — a clean received timestamp. */
  internalDate?: string;
  snippet?: string;
  labels: string[];
  hasAttachment: boolean;
  isUnread: boolean;
}

export interface SearchData {
  messages: SearchResultRow[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/**
 * Search the inbox (read-only). Builds a Gmail query from structured fields, lists matching
 * message ids, then fetches lightweight metadata for each. Bodies are NOT returned here — use
 * gmail_read for full content.
 *
 * Note: we fetch each match with format "full" so attachment detection is accurate; we only read
 * headers/labels/snippet/parts (never the body). This is fine for a prototype; Stage 5 can optimize.
 */
export async function gmailSearch(
  input: SearchInput,
  deps: { gmail?: GmailClient } = {},
): Promise<ToolResponse<SearchData>> {
  try {
    const gmail = deps.gmail ?? (await getGmailClient());
    const q = buildQuery(input);
    const maxResults = input.maxResults ?? 25;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: q || undefined,
      maxResults,
      pageToken: input.pageToken,
    });

    const ids = listRes.data.messages ?? [];
    if (ids.length === 0) {
      return ok<SearchData>(
        { messages: [] },
        {
          recovery:
            "No messages matched. Try removing a filter (e.g. isUnread), widening the date range, or using a free-text `query`.",
          diagnostics: { query: q, returned: 0 },
        },
      );
    }

    const rows: SearchResultRow[] = [];
    for (const ref of ids) {
      if (!ref.id) continue;
      const msg = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
      const payload = msg.data.payload ?? undefined;
      const labels = msg.data.labelIds ?? [];
      rows.push({
        id: msg.data.id ?? ref.id,
        threadId: msg.data.threadId ?? "",
        from: getHeader(payload?.headers ?? undefined, "From"),
        to: getHeader(payload?.headers ?? undefined, "To"),
        subject: getHeader(payload?.headers ?? undefined, "Subject"),
        date: getHeader(payload?.headers ?? undefined, "Date"),
        internalDate: msg.data.internalDate ?? undefined,
        snippet: msg.data.snippet ?? undefined,
        labels,
        hasAttachment: hasAttachment(payload),
        isUnread: labels.includes("UNREAD"),
      });
    }

    const nextPageToken = listRes.data.nextPageToken ?? undefined;
    return ok<SearchData>(
      {
        messages: rows,
        nextPageToken,
        resultSizeEstimate: listRes.data.resultSizeEstimate ?? undefined,
      },
      {
        next_action:
          "Call gmail_read with a message `id` (or its `threadId`) to read the full thread and attachments." +
          (nextPageToken ? " More results exist: pass `pageToken` to get the next page." : ""),
        diagnostics: { query: q, returned: rows.length, hasMore: Boolean(nextPageToken) },
      },
    );
  } catch (err) {
    return mapError(err);
  }
}
