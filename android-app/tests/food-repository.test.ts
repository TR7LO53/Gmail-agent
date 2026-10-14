import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FoodRepository } from '../src/data/food-repository'
import { prepareSchema } from '../src/data/schema'
import { openNodeSqlite } from './helpers/sqlite-node'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('FoodRepository on file-backed SQLite', () => {
  it('persists a snapshot across a new connection and rescales that snapshot after preset changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pantry-sqlite-')); dirs.push(dir)
    const path = join(dir, 'food.sqlite')
    let db = openNodeSqlite(path); await prepareSchema(db)
    const repo = new FoodRepository(db, () => new Date('2026-10-14T08:00:00.000Z'))
    const presetId = await repo.insertPreset({ name: "Żółć z babcią's jadłospisu", aliases: ['żółć'], kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10, piece_weight_g: 0.5, slot_tags: ['breakfast'] })
    const added = await repo.add(presetId, 100)
    expect(added).toMatchObject({ ts: '2026-10-14T08:00:00.000Z', name: "Żółć z babcią's jadłospisu", preset_id: presetId, qty: 100, unit: 'g', source: 'manual', provenance: 'preset', kcal: 150, protein_g: 12, carbs_g: 1, fat_g: 10 })
    await db.run('UPDATE food_presets SET kcal=999,protein_g=99 WHERE id=?', [presetId])
    await db.close()

    db = openNodeSqlite(path); await prepareSchema(db)
    const reopened = new FoodRepository(db, () => new Date('2026-10-14T09:00:00.000Z'))
    expect(await reopened.listPresets()).toMatchObject([{ id: presetId, aliases: ['żółć'], slot_tags: ['breakfast'], piece_weight_g: 0.5, usage_count: 1 }])
    const entry = await reopened.getEntry(added.id)
    expect(entry).toMatchObject({ ...added, kcal: 150, protein_g: 12 })
    const edited = await reopened.updateWeight(added.id, 150)
    expect(edited).toMatchObject({ id: added.id, ts: added.ts, name: added.name, qty: 150, kcal: 225, protein_g: 18, carbs_g: 1.5, fat_g: 15 })
    expect((await reopened.listPresets())[0].usage_count).toBe(1)
    await reopened.delete(added.id)
    expect(await reopened.listEntries('2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z')).toEqual([])
    expect((await reopened.listPresets())[0].usage_count).toBe(0)
    await db.close()
  })

  it('uses half-open time windows and rejects missing IDs and invalid weights', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pantry-sqlite-')); dirs.push(dir)
    const db = openNodeSqlite(join(dir, 'food.sqlite')); await prepareSchema(db)
    const repo = new FoodRepository(db, () => new Date('2026-10-14T00:00:00.000Z'))
    const id = await repo.insertPreset({ name: 'Owsianka', kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
    await expect(repo.add(id, 0)).rejects.toThrow()
    await expect(repo.add(id, -1)).rejects.toThrow()
    await expect(repo.updateWeight(900, 10)).rejects.toThrow('Nie znaleziono wpisu')
    await expect(repo.delete(900)).rejects.toThrow('Nie znaleziono wpisu')
    const entry = await repo.add(id, 1)
    expect(await repo.listEntries(entry.ts, '2026-10-14T00:00:00.000Z')).toEqual([])
    expect((await repo.listEntries('2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z')).map((item) => item.id)).toEqual([entry.id])
    await db.close()
  })
})
