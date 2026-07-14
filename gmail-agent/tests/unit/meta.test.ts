import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { getMeta, setMeta, getLastChecked, setLastChecked } from "../../src/memory/meta.js";
import type { DB } from "../../src/memory/db.js";

describe("meta key/value store", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("returns undefined for a missing key", () => {
    expect(getMeta(db, "nope")).toBeUndefined();
  });

  it("stores and reads a value", () => {
    setMeta(db, "k", "v");
    expect(getMeta(db, "k")).toBe("v");
  });

  it("overwrites an existing key", () => {
    setMeta(db, "k", "v1");
    setMeta(db, "k", "v2");
    expect(getMeta(db, "k")).toBe("v2");
  });

  it("last_checked helpers round-trip", () => {
    expect(getLastChecked(db)).toBeUndefined();
    const iso = "2026-06-30T12:00:00.000Z";
    setLastChecked(db, iso);
    expect(getLastChecked(db)).toBe(iso);
  });
});
