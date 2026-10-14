import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { access, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface ExportPreset {
  id: number;
  name: string;
  aliases: string[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  slots: [];
  piece_weight_g: null;
}

export interface PresetsBackup {
  version: 1;
  food_presets: ExportPreset[];
  food_log: [];
}

export interface ExportPaths {
  dbPath: string;
  outputPath: string;
}

const require = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(label: string, field: string): never {
  throw new Error(`Preset ${label}: nieprawidłowe pole ${field}.`);
}

function validateMacro(value: unknown, label: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(label, field);
  return value;
}

function validatePreset(preset: unknown, label: string): ExportPreset {
  if (!isRecord(preset)) invalid(label, "rekord");
  const { id, name, aliases, kcal, protein_g, carbs_g, fat_g } = preset;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) invalid(label, "id");
  if (typeof name !== "string" || !name.trim()) invalid(label, "name");
  if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === "string")) invalid(label, "aliases");
  return {
    id, name, aliases: [...aliases],
    kcal: validateMacro(kcal, label, "kcal"),
    protein_g: validateMacro(protein_g, label, "protein_g"),
    carbs_g: validateMacro(carbs_g, label, "carbs_g"),
    fat_g: validateMacro(fat_g, label, "fat_g"),
    slots: [], piece_weight_g: null,
  };
}

/** Map a desktop preset to the Android backup shape without rounding its values. */
export function mapPresetToBackup(preset: unknown): ExportPreset {
  const label = isRecord(preset) && typeof preset.name === "string" ? `"${preset.name}"` : "(bez nazwy)";
  return validatePreset(preset, label);
}

export function buildPresetsBackup(presets: readonly unknown[]): PresetsBackup {
  const food_presets = presets.map(mapPresetToBackup);
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const preset of food_presets) {
    if (ids.has(preset.id)) throw new Error(`Powtórzone ID Presetu: ${preset.id}.`);
    if (names.has(preset.name)) throw new Error(`Powtórzona nazwa Presetu: ${preset.name}.`);
    ids.add(preset.id);
    names.add(preset.name);
  }
  return { version: 1, food_presets, food_log: [] };
}

export function resolveExportPaths(
  moduleUrl: string = import.meta.url,
  options: { db?: string; output?: string } = {},
): ExportPaths {
  const root = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
  const dbPath = path.resolve(root, options.db ?? "data/gmail-agent.db");
  const outputPath = path.resolve(root, options.output ?? "data/presets-backup.json");
  return { dbPath, outputPath };
}

interface ReadOnlyDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

function openReadOnly(dbPath: string): ReadOnlyDatabase {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: true }) => ReadOnlyDatabase;
  };
  return new DatabaseSync(dbPath, { readOnly: true });
}

function parseRows(rows: unknown[]): PresetsBackup {
  return buildPresetsBackup(rows.map((row) => {
    if (!isRecord(row)) invalid("(nieznany)", "rekord");
    const label = typeof row.name === "string" ? `"${row.name}"` : `ID ${String(row.id)}`;
    let aliases: unknown;
    try {
      aliases = JSON.parse(row.aliases as string) as unknown;
    } catch {
      invalid(label, "aliases (niepoprawny JSON)");
    }
    return { ...row, aliases };
  }));
}

async function sameExistingFile(left: string, right: string): Promise<boolean> {
  const resolved = async (candidate: string) => {
    try { await access(candidate); return await realpath(candidate); }
    catch { return path.resolve(candidate); }
  };
  return (await resolved(left)).toLowerCase() === (await resolved(right)).toLowerCase();
}

/** Export from an existing SQLite database using a read-only connection. */
export async function exportPresets(dbPath: string, outputPath: string): Promise<number> {
  const source = path.resolve(dbPath);
  const destination = path.resolve(outputPath);
  if (await sameExistingFile(source, destination)) {
    throw new Error("Plik wynikowy nie może wskazywać na źródłową bazę danych.");
  }

  let db: ReadOnlyDatabase | undefined;
  let temporaryPath: string | undefined;
  try {
    db = openReadOnly(source);
    const rows = db.prepare("SELECT id, name, aliases, kcal, protein_g, carbs_g, fat_g FROM food_presets ORDER BY name ASC").all();
    const backup = parseRows(rows);
    const json = `${JSON.stringify(backup, null, 2)}\n`;

    await mkdir(path.dirname(destination), { recursive: true });
    temporaryPath = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, json, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, destination);
    temporaryPath = undefined;
    return backup.food_presets.length;
  } finally {
    db?.close();
    if (temporaryPath) await rm(temporaryPath, { force: true });
  }
}

export function parseCliArgs(args: readonly string[]): { db?: string; output?: string; help: boolean } {
  const options: { db?: string; output?: string; help: boolean } = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--db" || arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Brak ścieżki po ${arg}.`);
      if (arg === "--db") options.db = value;
      else options.output = value;
      index += 1;
    } else throw new Error(`Nieznany argument: ${arg}. Użyj --help, aby zobaczyć pomoc.`);
  }
  return options;
}

export const EXPORT_HELP = `Eksportuje Presety z desktopowej bazy do kopii Androida.\n\nUżycie: npm run export-presets [-- --db <ścieżka>] [--output <ścieżka>]\nDomyślne ścieżki: data/gmail-agent.db oraz data/presets-backup.json (względem gmail-agent).\nWzględne ścieżki opcji również są liczone od katalogu gmail-agent.\n`;

export async function runExportPresetsCli(args: readonly string[], stdout = process.stdout, stderr = process.stderr): Promise<number> {
  try {
    const options = parseCliArgs(args);
    if (options.help) { stdout.write(EXPORT_HELP); return 0; }
    const paths = resolveExportPaths(import.meta.url, options);
    const count = await exportPresets(paths.dbPath, paths.outputPath);
    stdout.write(`Wyeksportowano ${count} Presetów do ${paths.outputPath}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Eksport Presetów nie powiódł się: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
