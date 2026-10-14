// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HistoryScreen from '../src/components/HistoryScreen.svelte'
import type { DayTotals } from '../src/core/types'
import type { StoredEntry } from '../src/data/food-repository'
import { FoodRepository } from '../src/data/food-repository'
import { prepareSchema } from '../src/data/schema'
import { openNodeSqlite } from './helpers/sqlite-node'
import App from '../src/App.svelte'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('../src/data/sqlite', () => ({ openFoodDatabase: async () => (globalThis as any).__historyTestDb }))

afterEach(cleanup)

let directory: string
let db: ReturnType<typeof openNodeSqlite>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ggent-history-ui-'))
  db = openNodeSqlite(join(directory, 'food.db'));
  (globalThis as any).__historyTestDb = db
  await prepareSchema(db)
  const repo = new FoodRepository(db)
  const id = await repo.insertPreset({ name: 'Porridge', kcal: 500, protein_g: 10, carbs_g: 50, fat_g: 5 })
  await repo.add(id, 100)
})
afterEach(async () => { delete (globalThis as any).__historyTestDb; await db.close(); await rm(directory, { recursive: true, force: true }) })

describe('history screen', () => {
  it('renders seven selectable days, keeps empty days tappable and only shows read-only entries', async () => {
    const days: DayTotals[] = Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-${String(index + 8).padStart(2, '0')}`, kcal: index === 6 ? 2500 : 0, protein_g: 0, carbs_g: 0, fat_g: 0 }))
    const entry = { id: 1, ts: '2026-10-14T10:15:00.000Z', name: 'Saved oats', qty: 50, unit: 'g', kcal: 0, protein_g: 2, carbs_g: 4, fat_g: 1, preset_id: 1, source: 'manual', provenance: 'preset' } as StoredEntry
    const onSelect = vi.fn()
    render(HistoryScreen, { props: { days, entries: [entry], selectedDate: '2026-10-14', goal: 2000, error: '', onBack: vi.fn(), onSelect, onRetry: vi.fn() } })
    const buttons = screen.getAllByRole('button', { name: /kcal/ })
    expect(buttons).toHaveLength(7)
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(buttons[0].querySelector('.bar-fill')?.getAttribute('style')).toContain('height: 0%')
    await fireEvent.click(buttons[0])
    expect(onSelect).toHaveBeenCalledWith('2026-10-08')
    expect(screen.getByText('Saved oats')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Edytuj|Usuń/ })).toBeNull()
    expect(screen.getByText('Cel 2000 kcal')).toBeTruthy()
  })

  it('wires Pantry navigation to the live seven-day snapshot and lets an empty day be selected', async () => {
    render(App)
    await screen.findByText('Porridge')
    await fireEvent.click(screen.getByRole('button', { name: 'Historia' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /kcal/ })).toHaveLength(7))
    const currentDay = screen.getByRole('button', { name: /500 kcal/ })
    await fireEvent.click(currentDay)
    expect(screen.getByText('Porridge')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Edytuj|Usuń/ })).toBeNull()
    await fireEvent.click(screen.getAllByRole('button', { name: /kcal/ })[0])
    expect(await screen.findByText('Brak wpisów tego dnia.')).toBeTruthy()
  })
})
