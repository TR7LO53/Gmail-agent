import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditedWrite } from "../../src/memory/audit.js";
import { openDb, type DB } from "../../src/memory/db.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { addPreset, listPresets, removePreset, updatePreset } from "../../src/memory/presets.js";

describe("auditedWrite", () => {
  let db: DB;
  const oatmeal = { name: "oatmeal", kcal: 100, protein_g: 5, carbs_g: 20, fat_g: 2 };
  const target = { table: "food_presets", name: oatmeal.name } as const;

  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.close(); });

  it.each([
    ["created", "Created", () => addPreset(db, oatmeal)],
    ["updated", "Updated", () => updatePreset(db, { ...oatmeal, kcal: 150 })],
    ["deleted", "Deleted", () => removePreset(db, oatmeal.name)],
  ] as const)("%s data and records its Activity", (action, verb, mutate) => {
    if (action !== "created") addPreset(db, oatmeal);
    const value = auditedWrite(db, () => ({
      value: mutate(),
      entries: [{ ...target, action }],
    }));
    if (action === "deleted") {
      expect(value).toBe(true);
      expect(listPresets(db)).toEqual([]);
    } else {
      expect(value).toMatchObject({ name: "oatmeal", kcal: action === "created" ? 100 : 150 });
      expect(listPresets(db)).toEqual([value]);
    }
    expect(listRecentLogs(db)).toEqual([expect.objectContaining({
      level: "info", source: "manual-edit", data: target, message: `${verb} preset "oatmeal"`,
    })]);
  });

  it("records only an attempted edit when the row is missing", () => {
    const existing = addPreset(db, { ...oatmeal, name: "rice" });
    expect(auditedWrite(db, () => ({ missing: target, action: "updated" as const }))).toBeUndefined();
    expect(listPresets(db)).toEqual([existing]);
    expect(listRecentLogs(db)).toEqual([expect.objectContaining({
      level: "info", source: "manual-edit", data: target,
      message: 'Attempted to edit preset "oatmeal", but it no longer exists.',
    })]);
  });

  it("rolls back a thrown mutation and propagates the same error", () => {
    const error = new Error("mutation failed");
    const mutate = () => auditedWrite(db, () => {
      addPreset(db, oatmeal);
      throw error;
    });
    let caught: unknown;
    try {
      mutate();
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
    expect(listPresets(db)).toEqual([]);
    expect(listRecentLogs(db)).toEqual([]);
  });

  it.each(["ABORT", "ROLLBACK"])("preserves the log error and rolls data back on %s", (mode) => {
    db.exec(`CREATE TRIGGER reject_log BEFORE INSERT ON logs
      BEGIN SELECT RAISE(${mode}, 'log failed'); END`);
    expect(() => auditedWrite(db, () => ({
      value: addPreset(db, oatmeal),
      entries: [{ ...target, action: "created" }],
    }))).toThrow("log failed");
    expect(listPresets(db)).toEqual([]);
    expect(listRecentLogs(db)).toEqual([]);
  });
});
