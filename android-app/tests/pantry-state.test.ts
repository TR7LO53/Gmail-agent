import { describe, expect, it } from 'vitest'
import { localDayWindow } from '../src/lib/pantry-state'

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
