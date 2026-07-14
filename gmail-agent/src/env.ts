import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Load `.env` from the package root, anchored to THIS module's location — never `process.cwd()`.
 * The bot/launcher/CLI can be started from different directories (desktop shortcut, npm, editor),
 * and cwd-based loading silently reads the wrong (or no) file. This is the same class of bug that
 * broke Gmail auth via MCP, so every entry point imports this first.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = path.join(ROOT, ".env");

dotenv.config({ path: ENV_PATH });

/** A trimmed, unquoted env value, or undefined if missing/empty. Handles pasted quotes/spaces. */
export function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** True if the env var is present and non-empty after trimming. */
export function hasEnv(name: string): boolean {
  return readEnv(name) !== undefined;
}

/** Print a compact presence check (OK/missing) for the given vars — never prints their values. */
export function logEnvStatus(names: string[]): void {
  console.log(`Config loaded from ${ENV_PATH}`);
  for (const n of names) console.log(`  [${hasEnv(n) ? "OK " : "-- "}] ${n}`);
}
