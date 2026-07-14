import { AuthError } from "../gmail/auth";
import { fail, type ToolResponse } from "./types";

/**
 * Turn any thrown error into a friendly ToolResponse with a `recovery` hint,
 * so tools degrade gracefully instead of crashing the agent.
 */
export function mapError(err: unknown): ToolResponse<never> {
  if (err instanceof AuthError) {
    return fail("Authorization is missing or expired. Run `npm run auth` to log in again.", {
      kind: "auth",
    });
  }

  const e = err as { code?: number | string; message?: string };
  const code = typeof e?.code === "string" ? Number(e.code) : e?.code;

  // Expired/revoked OAuth token (google-auth throws this on refresh). Common when the OAuth
  // consent screen is in "Testing" mode — refresh tokens expire after 7 days.
  if (/invalid_grant/i.test(e?.message ?? "")) {
    return fail(
      "Gmail authorization expired (invalid_grant). Run `npm run auth` to reconnect. If this keeps happening weekly, set the Google OAuth consent screen to 'Production'.",
      { kind: "auth" },
    );
  }

  if (code === 401 || code === 403) {
    return fail(
      "Gmail rejected the request (auth/permission). Re-run `npm run auth` and make sure read-only scope was granted.",
      { kind: "auth", code },
    );
  }
  if (code === 429) {
    return fail("Gmail API rate limit hit. Wait a few seconds and retry.", {
      kind: "rate_limit",
      code,
    });
  }
  if (code === 404) {
    return fail("The requested Gmail resource was not found. Verify the id with gmail_search.", {
      kind: "not_found",
      code,
    });
  }

  return fail(`Unexpected error: ${e?.message ?? String(err)}.`, { kind: "unknown" });
}
