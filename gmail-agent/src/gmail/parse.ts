import type { gmail_v1 } from "googleapis";

type Part = gmail_v1.Schema$MessagePart;
type Header = gmail_v1.Schema$MessagePartHeader;

/** Case-insensitive header lookup (From / To / Subject / Date ...). */
export function getHeader(headers: Header[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  const found = headers.find((h) => h.name?.toLowerCase() === target);
  return found?.value ?? undefined;
}

/** Gmail encodes body/attachment data as base64url. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/** Very small HTML-to-text fallback (used only when there is no text/plain part). */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Find the first part (depth-first) of a given mime type that carries body data. */
function findPart(part: Part | undefined, mimeType: string): Part | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPart(child, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

/** Decode a message body to plain text. Prefers text/plain; falls back to stripped text/html. */
export function decodeBody(payload: Part | undefined): string {
  if (!payload) return "";

  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = findPart(payload, "text/html");
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

  // Single-part message (no nested parts).
  if (payload.body?.data) {
    const raw = decodeBase64Url(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtml(raw) : raw;
  }
  return "";
}

/** An attachment is returned as a REFERENCE link — never inline base64 (kills model context). */
export interface AttachmentRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId: string;
  messageId: string;
  /** Locator the web UI (Stage 4) will resolve to a real download. */
  ref: string;
}

/** Collect attachment references from a message payload (recursively). No bytes are read. */
export function extractAttachments(payload: Part | undefined, messageId: string): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const walk = (part?: Part): void => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        sizeBytes: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
        messageId,
        ref: `gmail://message/${messageId}/attachment/${part.body.attachmentId}`,
      });
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

/** True if any part is a real attachment (has a filename + attachmentId). */
export function hasAttachment(payload: Part | undefined): boolean {
  let found = false;
  const walk = (part?: Part): void => {
    if (!part || found) return;
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      found = true;
      return;
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return found;
}
