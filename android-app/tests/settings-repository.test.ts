import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { SettingsRepository } from "../src/data/settings-repository";
import { prepareSchema } from "../src/data/schema";
import { openNodeSqlite } from "./helpers/sqlite-node";

const directories: string[] = [];
async function tempDb() { const dir = await mkdtemp(join(tmpdir(), "ggent-settings-")); directories.push(dir); return { dir, path: join(dir, "food.db") }; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("SettingsRepository SQLite persistence", () => {
  it("round trips all values across a close, reopen, and repeated schema preparation", async () => {
    const { path } = await tempDb();
    const db = openNodeSqlite(path);
    try {
      await prepareSchema(db);
      const repository = new SettingsRepository(db);
      expect(await repository.get()).toEqual(DEFAULT_SETTINGS);
      const saved = await repository.save({ goals: { kcal: 2234.5, protein_g: 161.5, carbs_g: 205.25, fat_g: 73.75 }, boundaries: { lunchStart: 599, dinnerStart: 1111 } });
      expect(saved.goals.kcal).toBe(2234.5);
    } finally { await db.close(); }
    const reopened = openNodeSqlite(path);
    try {
      await prepareSchema(reopened);
      const repository = new SettingsRepository(reopened);
      expect(await repository.get()).toEqual({ goals: { kcal: 2234.5, protein_g: 161.5, carbs_g: 205.25, fat_g: 73.75 }, boundaries: { lunchStart: 599, dinnerStart: 1111 } });
      await repository.save({ goals: { kcal: 2300, protein_g: 155, carbs_g: 210, fat_g: 75 }, boundaries: { lunchStart: 600, dinnerStart: 1080 } });
      expect((await reopened.query("SELECT COUNT(*) AS count FROM app_settings"))[0].count).toBe(1);
      const before = await repository.get();
      await expect(repository.save({ goals: { ...before.goals, kcal: 0 }, boundaries: before.boundaries })).rejects.toThrow();
      expect(await repository.get()).toEqual({ goals: { kcal: 2300, protein_g: 155, carbs_g: 210, fat_g: 75 }, boundaries: { lunchStart: 600, dinnerStart: 1080 } });
    } finally { await reopened.close(); }
  });

  it("adds settings to a legacy database while preserving existing food rows", async () => {
    const { path } = await tempDb();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE food_presets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL DEFAULT '[]', kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL, piece_weight_g REAL NULL, slots TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE food_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, source TEXT NOT NULL, raw_input TEXT NULL, query_en TEXT NULL, original TEXT NULL, name TEXT NOT NULL, qty REAL NOT NULL, unit TEXT NOT NULL, kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL, provenance TEXT NULL, preset_id INTEGER NULL);
      INSERT INTO food_presets(id,name,kcal,protein_g,carbs_g,fat_g) VALUES(1,'Oats',1,1,1,1);
      INSERT INTO food_log(ts,source,name,qty,unit,kcal,protein_g,carbs_g,fat_g) VALUES('2026-01-01','manual','Oats',1,'g',1,1,1,1)`);
    old.close();
    const db = openNodeSqlite(path);
    try {
      await prepareSchema(db);
      expect((await db.query("SELECT name FROM food_presets WHERE id=1"))[0].name).toBe("Oats");
      expect((await db.query("SELECT name FROM food_log WHERE id=1"))[0].name).toBe("Oats");
      expect(await new SettingsRepository(db).get()).toEqual(DEFAULT_SETTINGS);
    } finally { await db.close(); }
  });
});
