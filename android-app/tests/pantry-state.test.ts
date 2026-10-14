import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '../src/core/settings'
import { orderPresetTiles } from '../src/core/tile-order'
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
