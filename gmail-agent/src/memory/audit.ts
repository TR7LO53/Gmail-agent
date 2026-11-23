import { inTransaction, type DB } from "./db.js";
import { logEvent } from "./logs.js";

type Target =
  | { table: "food_presets"; name: string }
  | { table: "food_log"; id: number };
type Action = "created" | "updated" | "deleted";

export type ActivityEntry =
  | (Extract<Target, { table: "food_presets" }> & { action: Action })
  | (Extract<Target, { table: "food_log" }> & { name: string } &
      ({ action: "created" | "updated"; qty: number } | { action: "deleted" }));

type Saved<T> = { value: T; entries: [ActivityEntry, ...ActivityEntry[]] };
type WriteResult<T> = Saved<T> | { missing: Target; action: "updated" | "deleted" };

const verbs = { created: "Created", updated: "Updated", deleted: "Deleted" };

export function auditedWrite<T>(db: DB, write: () => Saved<T>): T;
export function auditedWrite<T>(db: DB, write: () => WriteResult<T>): T | undefined;
export function auditedWrite<T>(db: DB, write: () => WriteResult<T>): T | undefined {
  return inTransaction(db, () => {
    const result = write();
    if ("missing" in result) {
      const target = result.missing;
      const data = target.table === "food_log"
        ? { table: target.table, id: target.id }
        : { table: target.table, name: target.name };
      const subject = data.table === "food_log" ? `food #${data.id}` : `preset "${data.name}"`;
      const verb = result.action === "updated" ? "edit" : "delete";
      logEvent(db, {
        source: "manual-edit",
        message: `Attempted to ${verb} ${subject}, but it no longer exists.`,
        data,
      });
      return undefined;
    }

    for (const entry of result.entries) {
      const { action, name, table } = entry;
      const subject = table === "food_log" ? "food" : "preset";
      const weight = "qty" in entry ? ` (${entry.qty} g)` : "";
      const data = table === "food_log" ? { table, id: entry.id } : { table, name };
      logEvent(db, {
        source: "manual-edit",
        message: `${verbs[action]} ${subject} "${name}"${weight}`,
        data,
      });
    }
    return result.value;
  });
}

export class MissingFoodDataError extends Error {}
