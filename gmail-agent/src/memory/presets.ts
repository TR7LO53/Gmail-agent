import type { DB } from "./db.js";

export interface FoodPreset {
  id: number;
  name: string;
  aliases: string[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface AddPresetInput {
  name: string;
  aliases?: string[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

function rowToPreset(row: Record<string, unknown>): FoodPreset {
  return {
    id: row.id as number,
    name: row.name as string,
    aliases: JSON.parse(row.aliases as string) as string[],
    kcal: row.kcal as number,
    protein_g: row.protein_g as number,
    carbs_g: row.carbs_g as number,
    fat_g: row.fat_g as number,
  };
}

export function addPreset(db: DB, input: AddPresetInput): FoodPreset {
  if (findPresetByName(db, input.name)) {
    throw new Error(`Preset "${input.name}" already exists.`);
  }
  const stmt = db.prepare(
    `INSERT INTO food_presets (name, aliases, kcal, protein_g, carbs_g, fat_g)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    input.name,
    JSON.stringify(input.aliases ?? []),
    input.kcal,
    input.protein_g,
    input.carbs_g,
    input.fat_g,
  );
  return rowToPreset(
    db.prepare("SELECT * FROM food_presets WHERE id = ?").get(result.lastInsertRowid) as Record<
      string,
      unknown
    >,
  );
}

export function findPresetByName(db: DB, name: string): FoodPreset | undefined {
  const row = db.prepare("SELECT * FROM food_presets WHERE name = ?").get(name) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToPreset(row) : undefined;
}

export function updatePreset(db: DB, input: AddPresetInput): FoodPreset {
  const stmt = db.prepare(
    `UPDATE food_presets SET aliases = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?
     WHERE name = ?`,
  );
  stmt.run(
    JSON.stringify(input.aliases ?? []),
    input.kcal,
    input.protein_g,
    input.carbs_g,
    input.fat_g,
    input.name,
  );
  const updated = findPresetByName(db, input.name);
  if (!updated) throw new Error(`Preset "${input.name}" does not exist.`);
  return updated;
}

/** Delete a preset by canonical name. Returns true if a row was removed. */
export function removePreset(db: DB, name: string): boolean {
  const result = db.prepare("DELETE FROM food_presets WHERE name = ?").run(name);
  return result.changes > 0;
}

export function listPresets(db: DB): FoodPreset[] {
  const rows = db.prepare("SELECT * FROM food_presets ORDER BY name ASC").all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToPreset);
}
