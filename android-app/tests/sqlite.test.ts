import { describe, expect, it, vi } from 'vitest'
import { CapacitorConnection } from '../src/data/sqlite'

function fakeConnection() {
  return {
    beginTransaction: vi.fn(async () => undefined), commitTransaction: vi.fn(async () => undefined), rollbackTransaction: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ values: [] })), run: vi.fn(async () => ({ changes: { changes: 1, lastId: 1 } })), close: vi.fn(async () => undefined),
  }
}

describe('Capacitor SQLite transactions', () => {
  it('keeps transaction inserts inside begin/commit and disables implicit per-run transactions', async () => {
    const native = fakeConnection(), db = new CapacitorConnection(native as any)
    await db.transaction(async (tx) => { await tx.run('INSERT INTO table VALUES(?)', [1]); await tx.query('SELECT 1') })
    expect(native.beginTransaction).toHaveBeenCalledOnce()
    expect(native.commitTransaction).toHaveBeenCalledOnce()
    expect(native.rollbackTransaction).not.toHaveBeenCalled()
    expect(native.run).toHaveBeenCalledWith('INSERT INTO table VALUES(?)', [1], false)
  })

  it('awaits rollback after callback failure and remains usable', async () => {
    const native = fakeConnection(), db = new CapacitorConnection(native as any)
    await expect(db.transaction(async (tx) => { await tx.run('bad'); throw new Error('fail') })).rejects.toThrow('fail')
    expect(native.rollbackTransaction).toHaveBeenCalledOnce()
    expect(native.commitTransaction).not.toHaveBeenCalled()
    await db.run('next')
    expect(native.run).toHaveBeenLastCalledWith('next', [], false)
  })

  it('queues outside statements until the transaction commits', async () => {
    const native = fakeConnection(), db = new CapacitorConnection(native as any)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transaction = db.transaction(async (tx) => { await tx.run('first'); enter(); await gate; await tx.run('second') })
    await entered
    const outside = db.run('outside')
    expect(native.run.mock.calls.map(([sql]) => sql)).toEqual(['first'])
    release()
    await Promise.all([transaction, outside])
    expect(native.run.mock.calls.map(([sql]) => sql)).toEqual(['first', 'second', 'outside'])
  })
})
