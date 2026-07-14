import { describe, it, expect } from "vitest";
import { buildQuery } from "../../src/gmail/query";

describe("buildQuery", () => {
  it("combines simple filters", () => {
    expect(buildQuery({ from: "dhl.com", isUnread: true })).toBe("from:dhl.com is:unread");
  });

  it("supports multiple recipients", () => {
    expect(buildQuery({ to: ["a@x.com", "b@y.com"] })).toBe("to:a@x.com to:b@y.com");
  });

  it("normalizes dashed dates to slashes", () => {
    expect(buildQuery({ after: "2026-06-01", before: "2026-06-30" })).toBe(
      "after:2026/06/01 before:2026/06/30",
    );
  });

  it("adds has:attachment and appends free-text query last", () => {
    expect(buildQuery({ hasAttachment: true, query: "tracking number" })).toBe(
      "has:attachment tracking number",
    );
  });

  it("includes subject and label operators", () => {
    expect(buildQuery({ subject: "shipment", label: "Shipping" })).toBe(
      "subject:shipment label:Shipping",
    );
  });

  it("scopes to a Gmail category tab", () => {
    expect(buildQuery({ category: "primary", isUnread: true })).toBe("category:primary is:unread");
  });

  it("returns an empty string for empty input", () => {
    expect(buildQuery({})).toBe("");
  });

  it("does not add flags when false", () => {
    expect(buildQuery({ isUnread: false, hasAttachment: false })).toBe("");
  });
});
