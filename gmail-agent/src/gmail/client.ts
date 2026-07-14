import { google, type gmail_v1 } from "googleapis";
import { loadAuthorizedClient } from "./auth";

/** The authenticated Gmail API client. Tools accept this so tests can inject a fake. */
export type GmailClient = gmail_v1.Gmail;

let cached: GmailClient | null = null;

/** Return a cached, authenticated Gmail client (throws AuthError if not logged in yet). */
export async function getGmailClient(): Promise<GmailClient> {
  if (cached) return cached;
  const auth = await loadAuthorizedClient();
  cached = google.gmail({ version: "v1", auth });
  return cached;
}

/** Test helper: clear the cached client. */
export function resetGmailClient(): void {
  cached = null;
}
