/** Structured search inputs, translated into Gmail's text search syntax. */
export interface SearchQueryInput {
  from?: string;
  /** Multiple recipients supported (a message can have more than one "to"). */
  to?: string[];
  subject?: string;
  /** Free-text query, passed through as-is. */
  query?: string;
  label?: string;
  /** Gmail category tab, e.g. "primary" | "social" | "promotions" | "updates" | "forums". */
  category?: string;
  /** Clear date names instead of a vague "date". Accepts YYYY-MM-DD or YYYY/MM/DD. */
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
}

/** Gmail's date operators expect YYYY/MM/DD; accept dashes too and normalize. */
function normalizeDate(value: string): string {
  return value.trim().replace(/-/g, "/");
}

/**
 * Build a Gmail search query string from structured fields.
 * Pure and side-effect free, so it is easy to unit test.
 * Example: { from: "dhl.com", isUnread: true } -> "from:dhl.com is:unread"
 */
export function buildQuery(input: SearchQueryInput): string {
  const parts: string[] = [];

  if (input.from) parts.push(`from:${input.from}`);
  if (input.to) for (const t of input.to) parts.push(`to:${t}`);
  if (input.subject) parts.push(`subject:${input.subject}`);
  if (input.label) parts.push(`label:${input.label}`);
  if (input.category) parts.push(`category:${input.category}`);
  if (input.after) parts.push(`after:${normalizeDate(input.after)}`);
  if (input.before) parts.push(`before:${normalizeDate(input.before)}`);
  if (input.hasAttachment) parts.push("has:attachment");
  if (input.isUnread) parts.push("is:unread");
  if (input.query) parts.push(input.query.trim());

  return parts.join(" ").trim();
}
