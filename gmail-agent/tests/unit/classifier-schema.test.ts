import { describe, it, expect } from "vitest";
import { ClassificationSchema } from "../../src/agents/classifier.js";

describe("ClassificationSchema", () => {
  it("parses a valid parcel classification", () => {
    const result = ClassificationSchema.parse({
      isParcelRelated: true,
      trackingNumber: "1Z999AA10123456784",
      carrier: "UPS",
      status: "in_transit",
      estimatedDelivery: "2026-07-01",
      confidence: 0.95,
      reasoning: "UPS tracking confirmation email",
    });
    expect(result.isParcelRelated).toBe(true);
    expect(result.trackingNumber).toBe("1Z999AA10123456784");
    expect(result.carrier).toBe("UPS");
    expect(result.status).toBe("in_transit");
  });

  it("accepts a non-parcel classification (optional fields absent)", () => {
    const result = ClassificationSchema.parse({
      isParcelRelated: false,
      confidence: 0.99,
      reasoning: "Promotional newsletter",
    });
    expect(result.isParcelRelated).toBe(false);
    expect(result.trackingNumber).toBeUndefined();
    expect(result.carrier).toBeUndefined();
  });

  it("rejects an invalid status value", () => {
    expect(() =>
      ClassificationSchema.parse({
        isParcelRelated: true,
        status: "flying_through_space",
        confidence: 0.5,
        reasoning: "test",
      }),
    ).toThrow();
  });

  it("rejects confidence out of range", () => {
    expect(() =>
      ClassificationSchema.parse({
        isParcelRelated: false,
        confidence: 1.5,
        reasoning: "test",
      }),
    ).toThrow();
  });

  it("accepts all known carriers", () => {
    const carriers = ["DHL", "DPD", "InPost", "UPS", "GLS", "FedEx", "Poczta Polska", "Amazon", "Allegro", "other"] as const;
    for (const carrier of carriers) {
      expect(() =>
        ClassificationSchema.parse({ isParcelRelated: true, carrier, confidence: 0.8, reasoning: "test" }),
      ).not.toThrow();
    }
  });

  it("accepts all known status values", () => {
    const statuses = ["ordered", "shipped", "in_transit", "out_for_delivery", "delivered", "unknown"] as const;
    for (const status of statuses) {
      expect(() =>
        ClassificationSchema.parse({ isParcelRelated: true, status, confidence: 0.8, reasoning: "test" }),
      ).not.toThrow();
    }
  });
});
