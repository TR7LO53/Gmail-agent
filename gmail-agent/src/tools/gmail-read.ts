import { z } from "zod";
import { getGmailClient, type GmailClient } from "../gmail/client";
import { getHeader, decodeBody, extractAttachments, type AttachmentRef } from "../gmail/parse";
import { ok, fail, type ToolResponse } from "./types";
import { mapError } from "./errors";

/** Bodies are capped so a huge email can't blow up the context. */
const MAX_BODY_CHARS = 8000;

export const readInputSchema = z.object({
  /** A message id OR a thread id — the tool figures out which (the agent never has to). */
  id: z.string().min(1),
  detail: z.enum(["summary", "full"]).optional(),
});
export type ReadInput = z.infer<typeof readInputSchema>;

export interface ReadMessage {
  id: string;
  from?: string;
  to?: string;
  date?: string;
  subject?: string;
  snippet?: string;
  /** Decoded plain-text body — only present when detail = "full". */
  body?: string;
  bodyTruncated?: boolean;
  attachments: AttachmentRef[];
}

export interface ReadData {
  threadId: string;
  subject?: string;
  participants: string[];
  messageCount: number;
  messages: ReadMessage[];
}

/**
 * Resolve an id to its thread id. We try it as a message first (cheap "minimal" fetch) and use the
 * returned threadId; if that lookup fails, we assume the id is already a thread id. This keeps the
 * "is it a message or a thread?" decision in code, not in the agent (course lesson S03E04).
 */
async function resolveThreadId(gmail: GmailClient, id: string): Promise<string> {
  try {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "minimal" });
    if (msg.data.threadId) return msg.data.threadId;
  } catch {
    // Not a message id — treat the input as a thread id.
  }
  return id;
}

/** Read a full Gmail thread (read-only). Returns the whole conversation; attachments as refs. */
export async function gmailRead(
  input: ReadInput,
  deps: { gmail?: GmailClient } = {},
): Promise<ToolResponse<ReadData>> {
  const detail = input.detail ?? "summary";
  try {
    const gmail = deps.gmail ?? (await getGmailClient());
    const threadId = await resolveThreadId(gmail, input.id);

    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const msgs = thread.data.messages ?? [];
    if (msgs.length === 0) {
      return fail(`No thread or message found for id "${input.id}". Use gmail_search to find a valid id.`, {
        id: input.id,
      });
    }

    const participants = new Set<string>();
    let anyTruncated = false;

    const messages: ReadMessage[] = msgs.map((m) => {
      const headers = m.payload?.headers ?? undefined;
      const from = getHeader(headers, "From");
      if (from) participants.add(from);

      const row: ReadMessage = {
        id: m.id ?? "",
        from,
        to: getHeader(headers, "To"),
        date: getHeader(headers, "Date"),
        subject: getHeader(headers, "Subject"),
        snippet: m.snippet ?? undefined,
        attachments: extractAttachments(m.payload ?? undefined, m.id ?? ""),
      };

      if (detail === "full") {
        const decoded = decodeBody(m.payload ?? undefined);
        const truncated = decoded.length > MAX_BODY_CHARS;
        row.body = truncated ? decoded.slice(0, MAX_BODY_CHARS) : decoded;
        if (truncated) {
          row.bodyTruncated = true;
          anyTruncated = true;
        }
      }
      return row;
    });

    const subject = getHeader(msgs[0].payload?.headers ?? undefined, "Subject");

    return ok<ReadData>(
      { threadId, subject, participants: [...participants], messageCount: messages.length, messages },
      {
        next_action:
          detail === "summary"
            ? 'Call gmail_read again with detail="full" to read message bodies, or note any tracking number in the snippets.'
            : "If this thread references a tracking number, use gmail_search to find related carrier updates.",
        diagnostics: {
          threadId,
          messageCount: messages.length,
          detail,
          ...(anyTruncated ? { note: `Some bodies were truncated to ${MAX_BODY_CHARS} chars.` } : {}),
        },
      },
    );
  } catch (err) {
    return mapError(err);
  }
}
