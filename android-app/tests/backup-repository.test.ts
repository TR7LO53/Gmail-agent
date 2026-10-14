import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFoodBackup, serializeFoodBackup } from '../src/core/backup'
import { FoodRepository } from '../src/data/food-repository'
import { prepareSchema } from '../src/data/schema'
import { SettingsRepository } from '../src/data/settings-repository'
import { openNodeSqlite } from './helpers/sqlite-node'

describe('FoodRepository backup import/export', () => {
  let dir = ''
  const databases: ReturnType<typeof openNodeSqlite>[] = []
  async function db(name: string) { const value = openNodeSqlite(join(dir, name)); databases.push(value); await prepareSchema(value); return value }
  afterEach(async () => { for (const database of databases.splice(0)) await database.close(); if (dir) await rm(dir, { recursive: true, force: true }) })

  it('restores all presets and history, maps name clashes, keeps snapshots and rolls back failed imports', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ggent-backup-'))
    const source = await db('source.sqlite'), sourceRepo = new FoodRepository(source)
    const sourceId = await sourceRepo.insertPreset({ name: 'Owsianka', aliases: ['owsy'], slot_tags: ['breakfast', 'dinner'], kcal: 500, protein_g: 10, carbs_g: 60, fat_g: 8 })
    const importedId = await sourceRepo.insertPreset({ name: 'Nowy produkt', piece_weight_g: 20, slot_tags: ['lunch'], kcal: 90, protein_g: 2, carbs_g: 10, fat_g: 3 })
    const history = await sourceRepo.add(sourceId, 40)
    await source.run('UPDATE food_log SET ts=?,raw_input=?,query_en=?,original=?,kcal=? WHERE id=?', ['2026-10-10T12:30:00.000Z', 'zjedzone', 'oats', 'old oats', 101, history.id])
    await source.run("INSERT INTO food_log(ts,source,name,qty,unit,kcal,protein_g,carbs_g,fat_g,preset_id) VALUES('2026-10-11T09:00:00.000Z','manual','Bez produktu',25,'g',20,1,2,3,NULL)")
    const backup = parseFoodBackup(serializeFoodBackup(await sourceRepo.exportBackup()))
    expect(backup.food_log).toHaveLength(2)

    const target = await db('target.sqlite'), targetRepo = new FoodRepository(target)
    const clashId = await targetRepo.insertPreset({ name: 'Owsianka', aliases: ['lokalny'], kcal: 999, protein_g: 99, carbs_g: 99, fat_g: 99 })
    const settings = new SettingsRepository(target)
    await settings.save({ goals: { kcal: 2345, protein_g: 100, carbs_g: 150, fat_g: 55 }, boundaries: { lunchStart: 600, dinnerStart: 1000 } })
    const result = await targetRepo.importBackup(backup)
    expect(result).toEqual({ addedPresets: 1, skippedPresets: 1, addedEntries: 2 })
    const presets = await targetRepo.listPresets()
    expect(presets.find((item) => item.id === clashId)).toMatchObject({ kcal: 999, aliases: ['lokalny'], from_ggent: false, usage_count: 1 })
    expect(presets.find((item) => item.name === 'Nowy produkt')).toMatchObject({ from_ggent: true, slot_tags: ['lunch'], piece_weight_g: 20 })
    const logs = await target.query<any>('SELECT * FROM food_log ORDER BY ts')
    expect(logs[0]).toMatchObject({ ts: '2026-10-10T12:30:00.000Z', preset_id: clashId, raw_input: 'zjedzone', query_en: 'oats', original: 'old oats', kcal: 101 })
    expect(logs[1].preset_id).toBeNull()
    expect(await settings.get()).toMatchObject({ goals: { kcal: 2345 } })
    expect((await targetRepo.importBackup(backup)).addedEntries).toBe(2)

    await target.run("CREATE TRIGGER fail_backup BEFORE INSERT ON food_log WHEN NEW.name='explode' BEGIN SELECT RAISE(ABORT,'forced'); END")
    const broken = { ...backup, food_presets: [...backup.food_presets, { ...backup.food_presets[0], id: 70, name: 'Transient' }], food_log: [...backup.food_log, { ...backup.food_log[0], id: 70, name: 'explode', preset_id: 70 }] }
    await expect(targetRepo.importBackup(broken)).rejects.toThrow()
    expect((await targetRepo.listPresets()).some((item) => item.name === 'Transient')).toBe(false)
    await target.run('DROP TRIGGER fail_backup')
    await expect(targetRepo.importBackup(broken)).resolves.toMatchObject({ addedPresets: 1 })
    const reopened = openNodeSqlite(join(dir, 'target.sqlite')); databases.push(reopened); await prepareSchema(reopened)
    expect((await new FoodRepository(reopened).listPresets()).find((item) => item.name === 'Transient')).toMatchObject({ from_ggent: true })
  })

  it('adds the origin column repeatedly to a legacy database without changing data', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ggent-legacy-'))
    const legacy = openNodeSqlite(join(dir, 'legacy.sqlite')); databases.push(legacy)
    await legacy.run("CREATE TABLE food_presets(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,aliases TEXT NOT NULL DEFAULT '[]',kcal REAL NOT NULL,protein_g REAL NOT NULL,carbs_g REAL NOT NULL,fat_g REAL NOT NULL,piece_weight_g REAL NULL,slots TEXT NOT NULL DEFAULT '[]')")
    await legacy.run("INSERT INTO food_presets(name,kcal,protein_g,carbs_g,fat_g) VALUES('Stary',1,2,3,4)")
    await prepareSchema(legacy); await prepareSchema(legacy)
    expect((await new FoodRepository(legacy).listPresets())[0]).toMatchObject({ name: 'Stary', from_ggent: false })
  })
})
