import { describe, expect, it } from 'vitest'
import { chartScale, entriesForLocalDate, lastSevenDaysWindow, localDateWindow } from '../src/lib/history'
import type { StoredEntry } from '../src/data/food-repository'
import type { DayTotals } from '../src/core/types'

const entry = (ts: string, id = 1) => ({ id, ts, name: 'Test', qty: 100, unit: 'g', kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, preset_id: 1, source: 'manual', provenance: 'preset' }) as StoredEntry

describe('history date helpers', () => {
  it('uses local calendar days across DST and month/year boundaries', () => {
    const priorTz = process.env.TZ
    process.env.TZ = 'Europe/Warsaw'
    try {
      const spring = lastSevenDaysWindow(new Date('2026-03-29T10:00:00Z'))
      expect(spring).toEqual({ start: '2026-03-22T23:00:00.000Z', end: '2026-03-29T22:00:00.000Z' })
      const fall = lastSevenDaysWindow(new Date('2026-10-25T10:00:00Z'))
      expect(fall).toEqual({ start: '2026-10-18T22:00:00.000Z', end: '2026-10-25T23:00:00.000Z' })
      expect(localDateWindow('2026-01-01')).toEqual({ start: '2025-12-31T23:00:00.000Z', end: '2026-01-01T23:00:00.000Z' })
    } finally { if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz }
  })

  it('selects the half-open local-day range, including UTC instants from another local date', () => {
    const priorTz = process.env.TZ
    process.env.TZ = 'Europe/Warsaw'
    try {
      const selected = entriesForLocalDate([
        entry('2026-10-13T22:00:00Z'),
        entry('2026-10-14T21:59:59.999Z', 2),
        entry('2026-10-14T22:00:00Z', 3),
      ], '2026-10-14')
      expect(selected.map((row) => row.id)).toEqual([1, 2])
    } finally { if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz }
  })

  it('scales all-zero and empty charts safely while including the goal and tallest bar', () => {
    const empty: DayTotals[] = []
    expect(chartScale(empty, 0)).toBe(1)
    expect(chartScale(empty, 2000)).toBe(2300)
    expect(chartScale([{ date: '2026-10-14', kcal: 2500, protein_g: 0, carbs_g: 0, fat_g: 0 }], 2000)).toBe(2875)
  })
})
