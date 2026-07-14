import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import {
  recordObservation,
  getObservation,
  listRecentObservations,
} from "../../src/memory/observations.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

describe("observations (Observational Memory)", () => {
  let db: DB;
  beforeEach(() => {
    db = memDb();
  });

  it("records and reads back by kind + key", () => {
    recordObservation(db, { kind: "sender_carrier", key: "dhl.com", content: "DHL" });
    expect(getObservation(db, "sender_carrier", "dhl.com")?.content).toBe("DHL");
    expect(getObservation(db, "sender_carrier", "unknown.com")).toBeUndefined();
  });

  it("upserts on the same kind + key (no duplicate rows)", () => {
    recordObservation(db, { kind: "sender_carrier", key: "dhl.com", content: "DHL" });
    recordObservation(db, { kind: "sender_carrier", key: "dhl.com", content: "DPD" });
    expect(getObservation(db, "sender_carrier", "dhl.com")?.content).toBe("DPD");
    expect(listRecentObservations(db).filter((o) => o.key === "dhl.com")).toHaveLength(1);
  });

  it("keeps different kinds separate", () => {
    recordObservation(db, { kind: "sender_carrier", key: "k", content: "DHL" });
    recordObservation(db, { kind: "parcel_note", key: "k", content: "in transit" });
    expect(getObservation(db, "sender_carrier", "k")?.content).toBe("DHL");
    expect(getObservation(db, "parcel_note", "k")?.content).toBe("in transit");
    expect(listRecentObservations(db)).toHaveLength(2);
  });
});
