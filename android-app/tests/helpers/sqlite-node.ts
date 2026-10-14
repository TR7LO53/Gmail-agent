import { DatabaseSync } from 'node:sqlite'
import type { SqlConnection } from '../../src/data/schema'

export function openNodeSqlite(path: string): SqlConnection {
  const db = new DatabaseSync(path)
  const connection: SqlConnection = {
    async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) { return db.prepare(sql).all(...values) as T[] },
    async run(sql: string, values: unknown[] = []) {
      const result = db.prepare(sql).run(...values)
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) }
    },
    async transaction<T>(action: (connection: SqlConnection) => Promise<T>) {
      db.exec('BEGIN')
      try { const value = await action(connection); db.exec('COMMIT'); return value }
      catch (error) { db.exec('ROLLBACK'); throw error }
    },
    async close() { db.close() },
  }
  return connection
}
