import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '../src/core/settings'
import { orderPresetTiles } from '../src/core/tile-order'
import { lastSevenDaysTotals } from '../src/core/totals'
import { localDayWindow, PantryState } from '../src/lib/pantry-state'
import type { FoodRepository, StoredEntry, StoredPreset } from '../src/data/food-repository'

describe('local calendar day boundaries', () => {
  it('uses both local midnights across daylight saving changes and month boundaries', () => {
    const priorTz = process.env.TZ
    process.env.TZ = 'Europe/Warsaw'
    try {
      const spring = localDayWindow(new Date('2026-03-29T10:00:00.000Z'))
      expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 60 * 60 * 1000)
      const autumn = localDayWindow(new Date('2026-10-25T10:00:00.000Z'))
      expect(Date.parse(autumn.end) - Date.parse(autumn.start)).toBe(25 * 60 * 60 * 1000)
      const month = localDayWindow(new Date('2026-11-01T12:00:00.000Z'))
      expect(new Date(month.start).toISOString()).toBe('2026-10-31T23:00:00.000Z')
    } finally { if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz }
  })
})

describe('PantryState settings', () => {
  it('publishes saved goals and custom Slot ordering while preserving consumed totals', async () => {
    let persisted: AppSettings = { ...DEFAULT_SETTINGS, goals: { ...DEFAULT_SETTINGS.goals }, boundaries: { ...DEFAULT_SETTINGS.boundaries } }
    const presets = [
      { id: 1, name: 'Breakfast food', kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1, slot_tags: ['breakfast'], usage_count: 0 },
      { id: 2, name: 'Lunch food', kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1, slot_tags: ['lunch'], usage_count: 0 },
    ] as StoredPreset[]
    const now = new Date(2026, 9, 14, 10, 30)
    const entries = [{ id: 1, ts: new Date(2026, 9, 14, 9).toISOString(), name: 'Breakfast food', qty: 100, unit: 'g', kcal: 500, protein_g: 20, carbs_g: 40, fat_g: 10, preset_id: 1, source: 'manual', provenance: 'preset' }] as StoredEntry[]
    const food = { listPresets: async () => presets, listEntries: async () => entries } as unknown as FoodRepository
    const settings = { get: async () => ({ ...persisted, goals: { ...persisted.goals }, boundaries: { ...persisted.boundaries } }), save: async (next: AppSettings) => { persisted = next; return next } }
    const state = new PantryState(food, () => now, settings as never)
    await state.loadSettings(); await state.refresh()
    expect(orderPresetTiles(state.presets, state.slot).map(preset => preset.id)).toEqual([1, 2])
    const beforeTotals = state.totals
    await state.saveSettings({ goals: { kcal: 2200, protein_g: 155, carbs_g: 210, fat_g: 75 }, boundaries: { lunchStart: 600, dinnerStart: 1000 } })
    expect(state.goals.kcal).toBe(2200)
    expect(state.slot).toBe('lunch')
    expect(orderPresetTiles(state.presets, state.slot).map(preset => preset.id)).toEqual([2, 1])
    expect(state.totals).toEqual(beforeTotals)
    const restored = new PantryState(food, () => now, settings as never)
    await restored.loadSettings()
    expect(restored.goals.kcal).toBe(2200)
  })

  it('keeps active settings unchanged when persistence fails', async () => {
    const state = new PantryState({} as FoodRepository, () => new Date(2026, 9, 14, 10, 30), { get: async () => DEFAULT_SETTINGS, save: async () => { throw new Error('disk full') } } as never)
    await state.loadSettings()
    await expect(state.saveSettings({ goals: { ...DEFAULT_SETTINGS.goals, kcal: 2400 }, boundaries: { ...DEFAULT_SETTINGS.boundaries } })).rejects.toThrow('disk full')
    expect(state.goals.kcal).toBe(2000)
  })
})

describe('PantryState preset operations', () => {
  it('delegates preset CRUD explicitly without optimistic changes or implicit refresh', async () => {
    const calls: unknown[][] = []
    const food = {
      insertPreset: async (value: unknown) => { calls.push(['create', value]); return 42 },
      updatePreset: async (id: number, value: unknown) => { calls.push(['update', id, value]) },
      deletePreset: async (id: number) => { calls.push(['delete', id]) },
    } as unknown as FoodRepository
    const state = new PantryState(food)
    const value = { name: 'Test', kcal: 1, protein_g: 2, carbs_g: 3, fat_g: 4, slot_tags: ['lunch'] as const }
    expect(await state.createPreset(value)).toBe(42)
    await state.updatePreset(42, value)
    await state.deletePreset(42)
    expect(calls).toEqual([['create', value], ['update', 42, value], ['delete', 42]])
    expect(state.presets).toEqual([])
  })
})

describe('PantryState history refresh', () => {
  it('loads the exact local seven-day window and derives today and chart totals from one snapshot', async () => {
    const priorTz = process.env.TZ
    process.env.TZ = 'Europe/Warsaw'
    const now = new Date('2026-10-14T12:00:00Z')
    const rows = [
      { id: 1, ts: '2026-10-07T22:00:00.000Z', name: 'First day', qty: 100, unit: 'g', kcal: 120, protein_g: 2, carbs_g: 3, fat_g: 4, preset_id: 1, source: 'manual', provenance: 'preset' },
      { id: 2, ts: '2026-10-14T09:00:00.000Z', name: 'Today', qty: 100, unit: 'g', kcal: 300, protein_g: 10, carbs_g: 20, fat_g: 5, preset_id: 1, source: 'manual', provenance: 'preset' },
      { id: 3, ts: '2026-10-14T22:00:00.000Z', name: 'Tomorrow', qty: 100, unit: 'g', kcal: 900, protein_g: 1, carbs_g: 1, fat_g: 1, preset_id: 1, source: 'manual', provenance: 'preset' },
    ] as StoredEntry[]
    let queried: string[] = []
    const food = { listPresets: async () => [], listEntries: async (start: string, end: string) => { queried = [start, end]; return rows.slice(0, 2) } } as unknown as FoodRepository
    try {
      const state = new PantryState(food, () => now)
      await state.refresh()
      expect(queried).toEqual(['2026-10-07T22:00:00.000Z', '2026-10-14T22:00:00.000Z'])
      expect(state.entries.map((entry) => entry.id)).toEqual([2])
      expect(state.weekEntries.map((entry) => entry.id)).toEqual([1, 2])
      expect(state.historyTotals).toEqual(lastSevenDaysTotals(rows.slice(0, 2), now))
      expect(state.historyTotals.at(-1)?.kcal).toBe(300)
    } finally { if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz }
  })

  it('keeps the last complete snapshot on read failure', async () => {
    const now = new Date(2026, 9, 14, 10)
    let fail = false
    const food = { listPresets: async () => [], listEntries: async () => { if (fail) throw new Error('disk'); return [{ id: 1, ts: now.toISOString(), name: 'Stored', qty: 1, unit: 'g', kcal: 5, protein_g: 0, carbs_g: 0, fat_g: 0 }] } } as unknown as FoodRepository
    const state = new PantryState(food, () => now)
    await state.refresh()
    fail = true
    await expect(state.refresh()).rejects.toThrow('Nie udało się odczytać danych')
    expect(state.entries.map((entry) => entry.id)).toEqual([1])
    expect(state.historyTotals.at(-1)?.kcal).toBe(5)
    expect(state.error).toContain('odczytać danych')
  })

  it('does not let an older overlapping refresh overwrite a newer snapshot', async () => {
    let resolveFirst!: (entries: StoredEntry[]) => void
    let call = 0
    const first = new Promise<StoredEntry[]>((resolve) => { resolveFirst = resolve })
    const secondRow = { id: 2, ts: new Date(2026, 9, 14, 10).toISOString(), name: 'New', qty: 1, unit: 'g', kcal: 20, protein_g: 0, carbs_g: 0, fat_g: 0 } as StoredEntry
    const food = { listPresets: async () => [], listEntries: async () => ++call === 1 ? first : [secondRow] } as unknown as FoodRepository
    const state = new PantryState(food, () => new Date(2026, 9, 14, 10))
    const oldRefresh = state.refresh()
    await state.refresh()
    resolveFirst([{ ...secondRow, id: 1, name: 'Old', kcal: 10 }])
    await oldRefresh
    expect(state.entries.map((entry) => entry.name)).toEqual(['New'])
  })
})
