import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { upsertParcel } from "../../src/memory/parcels.js";
import { recordDecision } from "../../src/memory/decisions.js";
import { setLastChecked } from "../../src/memory/meta.js";
import { SseBroadcaster, getDashboardSignature } from "../../src/ui/sse.js";
import type { DB } from "../../src/memory/db.js";

function fakeClient() {
  const writes: string[] = [];
  return { writes, write: (c: string) => writes.push(c) };
}

describe("SseBroadcaster", () => {
  it("greets a new client and tracks size", () => {
    const b = new SseBroadcaster();
    const c = fakeClient();
    b.add(c);
    expect(b.size).toBe(1);
    expect(c.writes[0]).toContain(": connected");
  });

  it("broadcasts a well-formed event frame to all clients", () => {
    const b = new SseBroadcaster();
    const c1 = fakeClient();
    const c2 = fakeClient();
    b.add(c1);
    b.add(c2);

    b.broadcast("update", { at: "now" });

    const frame = c1.writes.at(-1)!;
    expect(frame).toBe('event: update\ndata: {"at":"now"}\n\n');
    expect(c2.writes.at(-1)).toBe(frame);
  });

  it("stops delivering to a removed client", () => {
    const b = new SseBroadcaster();
    const c = fakeClient();
    b.add(c);
    b.remove(c);
    expect(b.size).toBe(0);
    b.broadcast("update", {});
    // only the initial ": connected" write happened
    expect(c.writes).toHaveLength(1);
  });

  it("drops a client whose write throws during broadcast", () => {
    const b = new SseBroadcaster();
    let calls = 0;
    const dead = {
      write: () => {
        calls++;
        if (calls > 1) throw new Error("EPIPE"); // greet OK, then die on broadcast
      },
    };
    b.add(dead);
    expect(b.size).toBe(1);
    b.broadcast("update", {});
    expect(b.size).toBe(0);
  });
});

describe("getDashboardSignature", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("is stable when nothing changes", () => {
    const a = getDashboardSignature(db);
    expect(getDashboardSignature(db)).toBe(a);
  });

  it("changes after a new decision", () => {
    const before = getDashboardSignature(db);
    recordDecision(db, { timestamp: "2026-07-01T10:00:00.000Z", email_id: "m1", action_taken: "skip" });
    expect(getDashboardSignature(db)).not.toBe(before);
  });

  it("changes after a parcel update", () => {
    const before = getDashboardSignature(db);
    upsertParcel(db, { tracking_number: "T1", carrier: "DHL", status: "shipped", email_id: "m1" });
    expect(getDashboardSignature(db)).not.toBe(before);
  });

  it("changes after last_checked advances", () => {
    const before = getDashboardSignature(db);
    setLastChecked(db, "2026-07-01T12:00:00.000Z");
    expect(getDashboardSignature(db)).not.toBe(before);
  });
});
