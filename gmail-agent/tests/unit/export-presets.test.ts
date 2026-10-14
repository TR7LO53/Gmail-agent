import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPresetsBackup, mapPresetToBackup, parseCliArgs, resolveExportPaths } from "../../src/export-presets.js";

const preset = {
  id: 7,
  name: "Owsianka O'Brian",
  aliases: ["owsy", "płatki"],
  kcal: 0,
  protein_g: 13.25,
  carbs_g: 67.04,
  fat_g: 3.6,
};

describe("desktop preset backup mapping", () => {
  it("preserves preset values and adds empty Android fields", () => {
    expect(mapPresetToBackup(preset)).toEqual({ ...preset, slots: [], piece_weight_g: null });
  });

  it("builds a version 1 backup with empty presets and food log when appropriate", () => {
    expect(buildPresetsBackup([])).toEqual({ version: 1, food_presets: [], food_log: [] });
    expect(buildPresetsBackup([{ ...preset, aliases: [] }])).toMatchObject({ version: 1, food_log: [] });
  });

  it.each([
    [{ ...preset, id: 0 }, "id"],
    [{ ...preset, name: " " }, "name"],
    [{ ...preset, aliases: [1] }, "aliases"],
    [{ ...preset, kcal: -1 }, "kcal"],
    [{ ...preset, fat_g: Number.POSITIVE_INFINITY }, "fat_g"],
  ])("rejects invalid field %s", (value, field) => {
    expect(() => mapPresetToBackup(value)).toThrow(String(field));
  });

  it("resolves defaults and relative options from the package, not cwd", () => {
    const moduleUrl = new URL("../../src/export-presets.ts", import.meta.url).href;
    const root = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
    expect(resolveExportPaths(moduleUrl)).toEqual({ dbPath: path.join(root, "data", "gmail-agent.db"), outputPath: path.join(root, "data", "presets-backup.json") });
    expect(resolveExportPaths(moduleUrl, { db: "test.db", output: "out.json" })).toEqual({ dbPath: path.join(root, "test.db"), outputPath: path.join(root, "out.json") });
  });

  it("parses CLI options and rejects missing values", () => {
    expect(parseCliArgs(["--db", "one.db", "--output", "two.json"])).toEqual({ db: "one.db", output: "two.json", help: false });
    expect(() => parseCliArgs(["--output"])).toThrow(/Brak ścieżki/);
  });
});
