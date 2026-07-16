import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import {
  addPreset,
  findPresetByName,
  listPresets,
  updatePreset,
  removePreset,
} from "../../src/memory/presets.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

describe("food presets", () => {
  let db: DB;
  beforeEach(() => {
    db = memDb();
  });

  it("adds a preset and finds it by name", () => {
    addPreset(db, {
      name: "pierś z kurczaka",
      kcal: 165,
      protein_g: 31,
      carbs_g: 0,
      fat_g: 3.6,
    });
    const found = findPresetByName(db, "pierś z kurczaka");
    expect(found?.name).toBe("pierś z kurczaka");
    expect(found?.kcal).toBe(165);
    expect(found?.protein_g).toBe(31);
    expect(found?.carbs_g).toBe(0);
    expect(found?.fat_g).toBe(3.6);
  });

  it("persists aliases alongside the canonical name", () => {
    addPreset(db, {
      name: "pierś z kurczaka",
      aliases: ["kurczak", "chicken breast"],
      kcal: 165,
      protein_g: 31,
      carbs_g: 0,
      fat_g: 3.6,
    });
    const found = findPresetByName(db, "pierś z kurczaka");
    expect(found?.aliases).toEqual(["kurczak", "chicken breast"]);
  });

  it("rejects adding a preset whose canonical name already exists", () => {
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    expect(() =>
      addPreset(db, { name: "jajko", kcal: 200, protein_g: 20, carbs_g: 2, fat_g: 15 }),
    ).toThrow(/jajko/);
    // the original values are untouched
    expect(findPresetByName(db, "jajko")?.kcal).toBe(155);
  });

  it("lists all stored presets, empty when none exist", () => {
    expect(listPresets(db)).toEqual([]);
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    addPreset(db, { name: "owsianka", kcal: 68, protein_g: 2.4, carbs_g: 12, fat_g: 1.4 });
    const names = listPresets(db).map((p) => p.name);
    expect(names).toEqual(["jajko", "owsianka"]);
  });

  it("updates an existing preset's macros and aliases", () => {
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    updatePreset(db, {
      name: "jajko",
      kcal: 160,
      protein_g: 14,
      carbs_g: 1,
      fat_g: 11.5,
      aliases: ["egg"],
    });
    const found = findPresetByName(db, "jajko");
    expect(found?.kcal).toBe(160);
    expect(found?.protein_g).toBe(14);
    expect(found?.aliases).toEqual(["egg"]);
  });

  it("rejects updating a preset that doesn't exist", () => {
    expect(() =>
      updatePreset(db, { name: "nieznane", kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }),
    ).toThrow(/nieznane/);
  });

  it("removes an existing preset", () => {
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    expect(removePreset(db, "jajko")).toBe(true);
    expect(findPresetByName(db, "jajko")).toBeUndefined();
  });

  it("removePreset returns false for a name that doesn't exist", () => {
    expect(removePreset(db, "nieznane")).toBe(false);
  });
});
