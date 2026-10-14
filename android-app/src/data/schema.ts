export const DATABASE_NAME = "ggent_food";
export const DATABASE_VERSION = 1;

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS food_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aliases TEXT NOT NULL DEFAULT '[]',
    kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL,
    piece_weight_g REAL NULL,
    slots TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS food_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, source TEXT NOT NULL, raw_input TEXT NULL, query_en TEXT NULL,
    original TEXT NULL, name TEXT NOT NULL, qty REAL NOT NULL, unit TEXT NOT NULL,
    kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL,
    provenance TEXT NULL, preset_id INTEGER NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_food_log_ts_id ON food_log(ts, id)",
  "CREATE INDEX IF NOT EXISTS idx_food_log_preset_id ON food_log(preset_id)",
];

export interface SqlConnection {
  query<T extends Record<string, unknown> = Record<string, unknown>>(statement: string, values?: unknown[]): Promise<T[]>;
  run(statement: string, values?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  close(): Promise<void>;
}

export async function prepareSchema(db: SqlConnection): Promise<void> {
  for (const statement of SCHEMA_SQL) await db.run(statement);
}
