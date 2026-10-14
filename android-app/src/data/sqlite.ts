import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { SqlConnection } from "./schema";
import { DATABASE_NAME, DATABASE_VERSION, prepareSchema } from "./schema";

class CapacitorConnection implements SqlConnection {
  constructor(private readonly connection: SQLiteDBConnection) {}

  async query<T extends Record<string, unknown>>(statement: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.connection.query(statement, values as any[]);
    return (result.values ?? []) as T[];
  }

  async run(statement: string, values: unknown[] = []): Promise<{ changes: number; lastId?: number }> {
    const result = await this.connection.run(statement, values as any[]);
    return { changes: result.changes?.changes ?? 0, lastId: result.changes?.lastId };
  }

  async close(): Promise<void> { await this.connection.close(); }
}

let opening: Promise<SqlConnection> | undefined;

export function openFoodDatabase(): Promise<SqlConnection> {
  if (!Capacitor.isNativePlatform()) return Promise.reject(new Error("Pantry wymaga aplikacji na Androidzie, aby korzystać z trwałej bazy danych."));
  if (!opening) {
    opening = (async () => {
      const sqlite = new SQLiteConnection(CapacitorSQLite);
      const consistency = await sqlite.checkConnectionsConsistency();
      if (consistency.result === false) await sqlite.closeAllConnections();
      const has = await sqlite.isConnection(DATABASE_NAME, false);
      const connection = has.result
        ? await sqlite.retrieveConnection(DATABASE_NAME, false)
        : await sqlite.createConnection(DATABASE_NAME, false, "no-encryption", DATABASE_VERSION, false);
      if (!(await connection.isDBOpen()).result) await connection.open();
      const db = new CapacitorConnection(connection);
      await prepareSchema(db);
      return db;
    })().catch((error) => { opening = undefined; throw error; });
  }
  return opening;
}
