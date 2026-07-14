import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import type { OAuth2Client } from "google-auth-library";

/** Read-only access only. The agent can never send, edit or delete mail — there are no such tools. */
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// Anchor paths to the project root (this file is at <root>/src/gmail/auth.ts), NOT process.cwd().
// The MCP server is launched by the editor from the workspace root, where these files don't live;
// resolving from the module location makes auth work no matter which directory started the process.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const TOKEN_PATH = path.join(ROOT, "data", "token.json");

/** Thrown when no saved authorization exists. Tools convert this into a friendly recovery hint. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Load a previously saved token, or null if none/unreadable. */
async function loadSavedCredentials(): Promise<OAuth2Client | null> {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf-8");
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials) as unknown as OAuth2Client;
  } catch {
    return null;
  }
}

/** Persist the refresh token to data/token.json so we only log in once. */
async function saveCredentials(client: OAuth2Client): Promise<void> {
  const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
  const keys = JSON.parse(content);
  const key = keys.installed ?? keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Interactive login. Opens a browser the first time (loopback OAuth for a Desktop client),
 * then saves the token. Subsequent calls reuse the saved token. Used by `npm run auth`.
 *
 * Pass `{ force: true }` to ALWAYS run a fresh browser consent flow even when a token already
 * exists — required when the saved refresh token has expired (`invalid_grant`). Without this,
 * a stale token.json is loaded and returned, so `npm run auth` would silently re-use the dead
 * token and never reconnect. Forcing deletes the old token first so a new refresh token is minted.
 */
export async function authorize(opts: { force?: boolean } = {}): Promise<OAuth2Client> {
  if (opts.force) {
    await fs.rm(TOKEN_PATH, { force: true });
  } else {
    const saved = await loadSavedCredentials();
    if (saved) return saved;
  }

  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials) await saveCredentials(client as unknown as OAuth2Client);
  return client as unknown as OAuth2Client;
}

/**
 * Non-interactive: return the saved authorized client, or throw AuthError.
 * Used by the tools so they never pop a browser unexpectedly.
 */
export async function loadAuthorizedClient(): Promise<OAuth2Client> {
  const saved = await loadSavedCredentials();
  if (!saved) {
    throw new AuthError("No saved authorization. Run `npm run auth` to log in (read-only).");
  }
  return saved;
}

/** Result of the startup auth guard, so the launcher can print a useful line. */
export type AuthCheck =
  | { status: "ok" } // saved token verified against Gmail
  | { status: "reauthorized" } // token was missing/expired → fresh browser login completed
  | { status: "offline"; message: string }; // couldn't verify (network, not an auth problem) → continue anyway

/**
 * Startup guard used by the launcher. Verifies the saved token with a cheap live Gmail call and,
 * only when it is missing or expired (`invalid_grant`), runs the interactive browser consent flow
 * BEFORE the app starts — so turning Ggent on reconnects itself instead of silently running blind.
 *
 * A transient network error is NOT treated as an auth failure (we don't want to pop a browser on a
 * Wi-Fi blip): it returns `offline` and the caller continues; the heartbeat will surface real errors.
 */
export async function ensureGmailAuth(): Promise<AuthCheck> {
  const saved = await loadSavedCredentials();
  if (saved) {
    try {
      const gmail = google.gmail({ version: "v1", auth: saved });
      await gmail.users.getProfile({ userId: "me" });
      return { status: "ok" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/invalid_grant|invalid_token|unauthorized|invalid_client|\b401\b|\b403\b/i.test(msg)) {
        return { status: "offline", message: msg }; // not clearly an auth failure → don't force a login
      }
      // fall through: token is expired/revoked → re-consent below
    }
  }

  await authorize({ force: true });
  return { status: "reauthorized" };
}
