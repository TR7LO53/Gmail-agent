import { DatabaseSync } from 'node:sqlite'
import type { SqlConnection } from '../../src/data/schema'

export function openNodeSqlite(path: string): SqlConnection {
  const db = new DatabaseSync(path)
  return {
    async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) { return db.prepare(sql).all(...values) as T[] },
    async run(sql: string, values: unknown[] = []) {
      const result = db.prepare(sql).run(...values)
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) }
    },
    async close() { db.close() },
  }
}
