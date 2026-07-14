import { describe, it, expect } from "vitest";
import { TrackerResultSchema, DailySummarySchema } from "../../src/agents/tracker.js";

describe("TrackerResultSchema", () => {
  it("accepts a valid delivered result", () => {
    const r = TrackerResultSchema.parse({
      currentStatus: "delivered",
      summary: "Delivered today.",
      isDelivered: true,
    });
    expect(r.currentStatus).toBe("delivered");
    expect(r.isDelivered).toBe(true);
  });

  it("accepts an optional estimatedDelivery", () => {
    const r = TrackerResultSchema.parse({
      currentStatus: "in_transit",
      estimatedDelivery: "2026-07-02",
      summary: "On its way.",
      isDelivered: false,
    });
    expect(r.estimatedDelivery).toBe("2026-07-02");
  });

  it("rejects an unknown status enum value", () => {
    expect(() =>
      TrackerResultSchema.parse({ currentStatus: "lost", summary: "x", isDelivered: false }),
    ).toThrow();
  });

  it("requires summary and isDelivered", () => {
    expect(() => TrackerResultSchema.parse({ currentStatus: "shipped" })).toThrow();
  });
});

describe("DailySummarySchema", () => {
  it("requires a summary string", () => {
    expect(DailySummarySchema.parse({ summary: "ok" }).summary).toBe("ok");
    expect(() => DailySummarySchema.parse({})).toThrow();
  });
});
