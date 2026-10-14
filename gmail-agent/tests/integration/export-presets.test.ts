import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseFoodBackup } from "../../../android-app/src/core/backup";
import { exportPresets } from "../../src/export-presets.js";
import { addPreset } from "../../src/memory/presets.js";
import { openDb } from "../../src/memory/db.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "export-presets-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createDb(dbPath: string, withPresets = true): void {
  const db = openDb(dbPath);
  if (withPresets) {
    addPreset(db, { name: "Owsianka", aliases: ["owsy", "płatki"], kcal: 68.2, protein_g: 2.4, carbs_g: 12.01, fat_g: 1.4 });
    addPreset(db, { name: "Jajko", aliases: [], kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
  }
  db.prepare("INSERT INTO food_log (ts, source, name, qty, unit, kcal, protein_g, carbs_g, fat_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), "test", "wpis do pominięcia", 100, "g", 1, 0, 0, 0);
  db.close();
}

describe("exportPresets integration", () => {
  it("writes a file accepted by Android's parser and leaves the SQLite source unchanged", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, "source.db");
    const outputPath = path.join(dir, "backup.json");
    createDb(dbPath);
    const before = openDb(dbPath);
    const rowsBefore = before.prepare("SELECT * FROM food_presets ORDER BY id").all();
    const logBefore = before.prepare("SELECT * FROM food_log").all();
    const schemaBefore = before.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    before.close();

    expect(await exportPresets(dbPath, outputPath)).toBe(2);
    const text = await readFile(outputPath, "utf8");
    const parsed = parseFoodBackup(text);
    expect(parsed).toEqual({
      version: 1,
      food_presets: [
        { id: 2, name: "Jajko", aliases: [], kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11, slots: [], piece_weight_g: null },
        { id: 1, name: "Owsianka", aliases: ["owsy", "płatki"], kcal: 68.2, protein_g: 2.4, carbs_g: 12.01, fat_g: 1.4, slots: [], piece_weight_g: null },
      ],
      food_log: [],
    });
    expect(text.endsWith("\n")).toBe(true);

    const after = openDb(dbPath);
    expect(after.prepare("SELECT * FROM food_presets ORDER BY id").all()).toEqual(rowsBefore);
    expect(after.prepare("SELECT * FROM food_log").all()).toEqual(logBefore);
    expect(after.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual(schemaBefore);
    after.close();
  });

  it("exports an empty preset table and rejects a missing database without creating it", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, "empty.db");
    const outputPath = path.join(dir, "empty.json");
    const db = openDb(dbPath);
    db.close();
    expect(await exportPresets(dbPath, outputPath)).toBe(0);
    expect(parseFoodBackup(await readFile(outputPath, "utf8"))).toEqual({ version: 1, food_presets: [], food_log: [] });

    const missing = path.join(dir, "missing.db");
    await expect(exportPresets(missing, path.join(dir, "missing.json"))).rejects.toThrow();
    await expect(readFile(missing)).rejects.toMatchObject({ code: "ENOENT" });

    const blockedOutput = path.join(dir, "blocked.json");
    await mkdir(blockedOutput);
    await expect(exportPresets(dbPath, blockedOutput)).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => name.startsWith("blocked.json."))).toEqual([]);
  });

  it("rejects missing tables and corrupt aliases without touching an existing output", async () => {
    const dir = await tempDir();
    const noTablePath = path.join(dir, "no-table.db");
    await writeFile(noTablePath, "");
    const blank = openDb(noTablePath);
    blank.close();
    // Drop the preset table after using openDb to create a valid SQLite file.
    const noTable = openDb(noTablePath);
    noTable.exec("DROP TABLE food_presets");
    noTable.close();
    const sentinel = path.join(dir, "sentinel.json");
    await writeFile(sentinel, "previous backup\n");
    await expect(exportPresets(noTablePath, sentinel)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("previous backup\n");

    const dbPath = path.join(dir, "corrupt.db");
    createDb(dbPath);
    const db = openDb(dbPath);
    db.prepare("UPDATE food_presets SET aliases = ? WHERE name = ?").run("not-json", "Owsianka");
    db.close();
    await expect(exportPresets(dbPath, sentinel)).rejects.toThrow(/Owsianka.*aliases/);
    expect(await readFile(sentinel, "utf8")).toBe("previous backup\n");
    await expect(exportPresets(dbPath, dbPath)).rejects.toThrow(/źródłową bazę/);
    const reopened = openDb(dbPath);
    reopened.close();
  });

  it("runs the CLI runner from an unrelated cwd and reports errors via a nonzero exit", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, "source.db");
    const outputPath = path.join(dir, "from-cli.json");
    createDb(dbPath);
    const exporterUrl = pathToFileURL(path.join(packageRoot, "src", "export-presets.ts")).href;
    const invoke = `import { runExportPresetsCli } from ${JSON.stringify(exporterUrl)}; process.exitCode = await runExportPresetsCli(["--db", process.env.EXPORT_DB ?? "", "--output", process.env.EXPORT_OUTPUT ?? ""]);`;
    const env = { ...process.env, EXPORT_DB: dbPath, EXPORT_OUTPUT: outputPath };
    const success = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", invoke], { cwd: dir, encoding: "utf8", env });
    expect(success.status, success.stderr).toBe(0);
    expect(parseFoodBackup(await readFile(outputPath, "utf8")).food_presets).toHaveLength(2);

    const failure = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", invoke], { cwd: dir, encoding: "utf8", env: { ...env, EXPORT_DB: path.join(dir, "absent.db") } });
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/nie powiódł się/);
    expect(parseFoodBackup(await readFile(outputPath, "utf8")).food_presets).toHaveLength(2);
  });
});
