import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only import — erased by esbuild, so Vite never tries to bundle node:sqlite.
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Use createRequire so Vite/esbuild doesn't statically analyse node:sqlite.
// node:sqlite is a Node.js built-in (stable since 22.5); require() always finds it.
const _require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, "../../data/gmail-agent.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parcels (
  tracking_number TEXT PRIMARY KEY,
  carrier         TEXT NOT NULL,
  status          TEXT NOT NULL,
  last_update     TEXT NOT NULL,
  thread_id       TEXT,
  first_seen      TEXT NOT NULL,
  history         TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      TEXT NOT NULL,
  email_id       TEXT NOT NULL,
  thread_id      TEXT,
  action_taken   TEXT NOT NULL,
  agent_reasoning TEXT,
  outcome        TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT,
  subject         TEXT,
  sender          TEXT,
  received_at     TEXT,
  is_unread       INTEGER NOT NULL DEFAULT 0,
  is_parcel       INTEGER NOT NULL DEFAULT 0,
  tracking_number TEXT,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  key        TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, key)
);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL,
  source  TEXT NOT NULL,
  message TEXT NOT NULL,
  data    TEXT
);

CREATE TABLE IF NOT EXISTS food_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  source     TEXT NOT NULL,
  raw_input  TEXT,
  query_en   TEXT,
  original   TEXT,
  name       TEXT NOT NULL,
  qty        REAL,
  unit       TEXT,
  kcal       REAL NOT NULL,
  protein_g  REAL NOT NULL,
  carbs_g    REAL NOT NULL,
  fat_g      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS food_presets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  aliases    TEXT NOT NULL DEFAULT '[]',
  kcal       REAL NOT NULL,
  protein_g  REAL NOT NULL,
  carbs_g    REAL NOT NULL,
  fat_g      REAL NOT NULL
);
`;

/** Add a column to an existing table if it's missing (CREATE TABLE IF NOT EXISTS can't alter). */
function ensureColumn(db: DB, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export type DB = DatabaseSyncType;

export function openDb(dbPath?: string): DB {
  const { DatabaseSync } = _require("node:sqlite") as {
    DatabaseSync: typeof DatabaseSyncType;
  };
  const p = dbPath ?? DEFAULT_PATH;
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  // Migration: older DBs have food_log without the per-item original (Polish) name.
  ensureColumn(db, "food_log", "original", "TEXT");
  // Migration: older DBs have food_log without a provenance tag ('preset' | 'lookup').
  ensureColumn(db, "food_log", "provenance", "TEXT");
  return db;
}
