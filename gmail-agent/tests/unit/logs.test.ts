import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { logEvent, listRecentLogs, pruneLogs } from "../../src/memory/logs.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

describe("activity logs", () => {
  let db: DB;
  beforeEach(() => {
    db = memDb();
  });

  it("records entries and lists them newest first", () => {
    logEvent(db, { source: "heartbeat", message: "a" });
    logEvent(db, { source: "gmail_search", message: "b", data: { returned: 3 } });
    const logs = listRecentLogs(db, 10);
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toBe("b");
    expect(logs[0].source).toBe("gmail_search");
    expect(logs[0].data).toEqual({ returned: 3 });
    expect(logs[0].level).toBe("info"); // default
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) logEvent(db, { source: "classifier", message: "m" + i });
    expect(listRecentLogs(db, 3)).toHaveLength(3);
  });

  it("stores the error level", () => {
    logEvent(db, { source: "tracker", level: "error", message: "boom" });
    expect(listRecentLogs(db, 1)[0].level).toBe("error");
  });

  it("pruneLogs keeps only the newest N", () => {
    for (let i = 0; i < 10; i++) logEvent(db, { source: "tracker", message: "m" + i });
    pruneLogs(db, 4);
    const logs = listRecentLogs(db, 100);
    expect(logs).toHaveLength(4);
    expect(logs[0].message).toBe("m9");
    expect(logs[3].message).toBe("m6");
  });
});
