import { describe, expect, it } from 'vitest'
import { buildFoodBackup, parseFoodBackup, serializeFoodBackup, type BackupEntry, type BackupPreset } from './backup'

const preset: BackupPreset = { id: 4, name: "Żółć's oats", aliases: ['owsianka'], kcal: 123, protein_g: 4, carbs_g: 20, fat_g: 2, slots: ['breakfast', 'lunch', 'dinner'], piece_weight_g: 25 }
const entry: BackupEntry = { id: 8, ts: '2026-10-13T23:30:00+02:00', source: 'text', raw_input: 'porcja', query_en: 'oats', original: 'Owsianka', name: 'Gotowa owsianka', qty: 45, unit: 'g', kcal: 77, protein_g: 3, carbs_g: 12, fat_g: 1, provenance: 'parsed', preset_id: 4 }

describe('JSON backup format', () => {
  it('round trips Unicode fields and canonical arrays while preserving snapshots', () => {
    const backup = buildFoodBackup([preset], [entry])
    const parsed = parseFoodBackup(serializeFoodBackup(backup))
    expect(parsed.food_presets[0]).toEqual(preset)
    expect(parsed.food_log[0]).toMatchObject({ ...entry, ts: '2026-10-13T21:30:00.000Z' })
  })

  it('accepts empty data, optional fields, and a JSON string aliases field', () => {
    expect(parseFoodBackup('{"version":1,"food_presets":[],"food_log":[]}')).toMatchObject({ food_presets: [], food_log: [] })
    const value = { version: 1, food_presets: [{ ...preset, aliases: '["a"]', slots: undefined, piece_weight_g: undefined }], food_log: [{ ...entry, raw_input: undefined, query_en: undefined, original: undefined, provenance: undefined, preset_id: null }] }
    expect(parseFoodBackup(JSON.stringify(value)).food_presets[0]).toMatchObject({ aliases: ['a'], slots: [], piece_weight_g: null })
    expect(parseFoodBackup(JSON.stringify(value)).food_log[0]).toMatchObject({ raw_input: null, preset_id: null })
  })

  it.each([
    '{', '{"version":2,"food_presets":[],"food_log":[]}', '{"version":"1","food_presets":[],"food_log":[]}',
    '{"version":1,"food_presets":{},"food_log":[]}',
  ])('rejects malformed or unsupported backup: %s', (text) => { expect(() => parseFoodBackup(text)).toThrow(/kopii|JSON/) })

  it('rejects the whole backup for invalid records, units, duplicate names, or dangling references', () => {
    const invalids = [
      { ...preset, name: ' ' }, { ...preset, kcal: '1' }, { ...preset, slots: ['snack'] },
      { ...preset, id: 4, name: 'different' },
    ]
    for (const bad of invalids) expect(() => parseFoodBackup(JSON.stringify({ version: 1, food_presets: [preset, bad], food_log: [entry] }))).toThrow('Nieprawidłowe')
    expect(() => parseFoodBackup(JSON.stringify({ version: 1, food_presets: [preset], food_log: [{ ...entry, unit: 'piece' }] }))).toThrow('Nieprawidłowe')
    expect(() => parseFoodBackup(JSON.stringify({ version: 1, food_presets: [preset], food_log: [{ ...entry, preset_id: 99 }] }))).toThrow('Nieprawidłowe')
    expect(() => parseFoodBackup(JSON.stringify({ version: 1, food_presets: [preset, { ...preset, id: 5 }], food_log: [] }))).toThrow('Nieprawidłowe')
  })

  it('rejects null arrays instead of treating them as omitted optional fields', () => {
    expect(() => parseFoodBackup(JSON.stringify({ version: 1, food_presets: [{ ...preset, aliases: null }], food_log: [] }))).toThrow('Nieprawidłowe')
    expect(() => parseFoodBackup(JSON.stringify({ version: 1, food_presets: [{ ...preset, slots: null }], food_log: [] }))).toThrow('Nieprawidłowe')
  })
})
