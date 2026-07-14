import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { upsertParcel, getParcel, listActiveParcels, listAllParcels } from "../../src/memory/parcels.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

describe("parcels memory", () => {
  let db: DB;

  beforeEach(() => {
    db = memDb();
  });

  it("inserts a new parcel row", () => {
    upsertParcel(db, {
      tracking_number: "TRK001",
      carrier: "DHL",
      status: "shipped",
      email_id: "email1",
    });
    const p = getParcel(db, "TRK001");
    expect(p).toBeDefined();
    expect(p?.carrier).toBe("DHL");
    expect(p?.status).toBe("shipped");
    expect(p?.history).toHaveLength(1);
    expect(p?.history[0].status).toBe("shipped");
  });

  it("appends history and updates status when status changes", () => {
    upsertParcel(db, { tracking_number: "TRK002", carrier: "DPD", status: "shipped", email_id: "e1" });
    upsertParcel(db, { tracking_number: "TRK002", carrier: "DPD", status: "in_transit", email_id: "e2" });
    const p = getParcel(db, "TRK002");
    expect(p?.status).toBe("in_transit");
    expect(p?.history).toHaveLength(2);
    expect(p?.history.map((h) => h.status)).toEqual(["shipped", "in_transit"]);
  });

  it("does NOT duplicate history when status is unchanged", () => {
    upsertParcel(db, { tracking_number: "TRK003", carrier: "InPost", status: "in_transit", email_id: "e1" });
    upsertParcel(db, { tracking_number: "TRK003", carrier: "InPost", status: "in_transit", email_id: "e2" });
    const p = getParcel(db, "TRK003");
    expect(p?.history).toHaveLength(1);
  });

  it("listActiveParcels excludes delivered parcels", () => {
    upsertParcel(db, { tracking_number: "TRK010", carrier: "DHL", status: "in_transit", email_id: "e1" });
    upsertParcel(db, { tracking_number: "TRK011", carrier: "UPS", status: "delivered", email_id: "e2" });
    const active = listActiveParcels(db);
    expect(active.map((p) => p.tracking_number)).toContain("TRK010");
    expect(active.map((p) => p.tracking_number)).not.toContain("TRK011");
  });

  it("listAllParcels includes delivered parcels", () => {
    upsertParcel(db, { tracking_number: "TRK020", carrier: "GLS", status: "delivered", email_id: "e1" });
    const all = listAllParcels(db);
    expect(all.map((p) => p.tracking_number)).toContain("TRK020");
  });

  it("preserves first_seen on subsequent upserts", () => {
    upsertParcel(db, { tracking_number: "TRK030", carrier: "FedEx", status: "ordered", email_id: "e1" });
    const before = getParcel(db, "TRK030")!.first_seen;
    upsertParcel(db, { tracking_number: "TRK030", carrier: "FedEx", status: "shipped", email_id: "e2" });
    const after = getParcel(db, "TRK030")!.first_seen;
    expect(after).toBe(before);
  });
});
