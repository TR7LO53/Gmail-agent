import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { SqlConnection } from "./schema";
import { DATABASE_NAME, DATABASE_VERSION, prepareSchema } from "./schema";

export class CapacitorConnection implements SqlConnection {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly connection: SQLiteDBConnection) {}

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  private async queryNow<T extends Record<string, unknown>>(statement: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.connection.query(statement, values as any[]);
    return (result.values ?? []) as T[];
  }

  private async runNow(statement: string, values: unknown[] = []): Promise<{ changes: number; lastId?: number }> {
    const result = await this.connection.run(statement, values as any[], false);
    return { changes: result.changes?.changes ?? 0, lastId: result.changes?.lastId };
  }

  async query<T extends Record<string, unknown>>(statement: string, values: unknown[] = []): Promise<T[]> {
    return this.enqueue(() => this.queryNow<T>(statement, values));
  }

  async run(statement: string, values: unknown[] = []): Promise<{ changes: number; lastId?: number }> {
    return this.enqueue(() => this.runNow(statement, values));
  }

  async transaction<T>(action: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.connection.beginTransaction();
      const tx: SqlConnection = {
        query: <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) => this.queryNow<R>(sql, values),
        run: (sql: string, values: unknown[] = []) => this.runNow(sql, values),
        transaction: async <R>(nested: (connection: SqlConnection) => Promise<R>) => nested(tx),
        close: async () => { throw new Error("Nie można zamknąć bazy w transakcji."); },
      };
      try {
        const result = await action(tx);
        await this.connection.commitTransaction();
        return result;
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    });
  }

  async close(): Promise<void> { await this.enqueue(() => this.connection.close()); }
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
