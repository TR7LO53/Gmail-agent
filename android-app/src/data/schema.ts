export const DATABASE_NAME = "ggent_food";
export const DATABASE_VERSION = 1;

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS food_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aliases TEXT NOT NULL DEFAULT '[]',
    kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL,
    piece_weight_g REAL NULL,
    slots TEXT NOT NULL DEFAULT '[]',
    from_ggent INTEGER NOT NULL DEFAULT 0 CHECK (from_ggent IN (0,1))
  )`,
  `CREATE TABLE IF NOT EXISTS food_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, source TEXT NOT NULL, raw_input TEXT NULL, query_en TEXT NULL,
    original TEXT NULL, name TEXT NOT NULL, qty REAL NOT NULL, unit TEXT NOT NULL,
    kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL,
    provenance TEXT NULL, preset_id INTEGER NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    goal_kcal REAL NOT NULL CHECK (goal_kcal > 0),
    goal_protein_g REAL NOT NULL CHECK (goal_protein_g >= 0),
    goal_carbs_g REAL NOT NULL CHECK (goal_carbs_g >= 0),
    goal_fat_g REAL NOT NULL CHECK (goal_fat_g >= 0),
    lunch_start INTEGER NOT NULL CHECK (lunch_start BETWEEN 0 AND 1439),
    dinner_start INTEGER NOT NULL CHECK (dinner_start BETWEEN 0 AND 1439),
    CHECK (lunch_start < dinner_start)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_food_log_ts_id ON food_log(ts, id)",
  "CREATE INDEX IF NOT EXISTS idx_food_log_preset_id ON food_log(preset_id)",
];

export interface SqlConnection {
  query<T extends Record<string, unknown> = Record<string, unknown>>(statement: string, values?: unknown[]): Promise<T[]>;
  run(statement: string, values?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  transaction<T>(action: (connection: SqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function prepareSchema(db: SqlConnection): Promise<void> {
  for (const statement of SCHEMA_SQL) await db.run(statement);
  const columns = await db.query<{ name: string }>("PRAGMA table_info(food_presets)");
  if (!columns.some((column) => column.name === "from_ggent")) {
    await db.run("ALTER TABLE food_presets ADD COLUMN from_ggent INTEGER NOT NULL DEFAULT 0 CHECK (from_ggent IN (0,1))");
  }
  await db.run("INSERT OR IGNORE INTO app_settings(id,goal_kcal,goal_protein_g,goal_carbs_g,goal_fat_g,lunch_start,dinner_start) VALUES(1,2000,150,200,70,660,1020)");
}
