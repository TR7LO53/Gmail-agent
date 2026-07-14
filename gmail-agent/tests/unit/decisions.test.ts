import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { recordDecision, listDecisions, getProcessedEmailIds } from "../../src/memory/decisions.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

describe("decisions log", () => {
  let db: DB;

  beforeEach(() => {
    db = memDb();
  });

  it("stores a tracked decision", () => {
    recordDecision(db, {
      timestamp: "2026-06-30T10:00:00.000Z",
      email_id: "msg1",
      thread_id: "thread1",
      action_taken: "track",
      agent_reasoning: "DHL shipment notification",
      outcome: "DHL TRK001 → shipped",
    });
    const decisions = listDecisions(db, 10);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action_taken).toBe("track");
    expect(decisions[0].email_id).toBe("msg1");
    expect(decisions[0].outcome).toBe("DHL TRK001 → shipped");
  });

  it("stores a skip decision", () => {
    recordDecision(db, {
      timestamp: "2026-06-30T10:00:00.000Z",
      email_id: "msg2",
      action_taken: "skip",
      agent_reasoning: "Newsletter, not parcel related",
    });
    const decisions = listDecisions(db, 10);
    expect(decisions[0].action_taken).toBe("skip");
    expect(decisions[0].outcome).toBeUndefined();
  });

  it("returns decisions newest-first", () => {
    recordDecision(db, { timestamp: "2026-06-30T09:00:00.000Z", email_id: "old", action_taken: "skip" });
    recordDecision(db, { timestamp: "2026-06-30T10:00:00.000Z", email_id: "new", action_taken: "track" });
    const decisions = listDecisions(db, 10);
    expect(decisions[0].email_id).toBe("new");
    expect(decisions[1].email_id).toBe("old");
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      recordDecision(db, { timestamp: `2026-06-30T0${i}:00:00.000Z`, email_id: `msg${i}`, action_taken: "skip" });
    }
    const decisions = listDecisions(db, 3);
    expect(decisions).toHaveLength(3);
  });

  it("stores an update decision (tracker action)", () => {
    recordDecision(db, {
      timestamp: "2026-06-30T11:00:00.000Z",
      email_id: "u1",
      action_taken: "update",
      agent_reasoning: "Status advanced to delivered",
      outcome: "DHL X: in_transit -> delivered",
    });
    expect(listDecisions(db, 5)[0].action_taken).toBe("update");
  });

  it("getProcessedEmailIds returns the distinct set of seen email ids", () => {
    recordDecision(db, { timestamp: "2026-06-30T10:00:00.000Z", email_id: "a", action_taken: "track" });
    recordDecision(db, { timestamp: "2026-06-30T10:01:00.000Z", email_id: "a", action_taken: "update" });
    recordDecision(db, { timestamp: "2026-06-30T10:02:00.000Z", email_id: "b", action_taken: "skip" });

    const ids = getProcessedEmailIds(db);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.has("c")).toBe(false);
    expect(ids.size).toBe(2);
  });
});
