import type { DB } from "./db.js";

/**
 * Tiny key/value accessors over the `meta` table (provisioned in db.ts since Stage 2,
 * empty until now). Stage 3's heartbeat uses it for `last_checked`; the tracker stores
 * the generated `daily_summary` here too.
 */

/** Read a value from the `meta` table. Returns undefined if the key is absent. */
export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Insert or overwrite a value in the `meta` table. */
export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/** When the heartbeat last completed a scan (ISO string), or undefined on the first run. */
export function getLastChecked(db: DB): string | undefined {
  return getMeta(db, "last_checked");
}

export function setLastChecked(db: DB, iso: string): void {
  setMeta(db, "last_checked", iso);
}
