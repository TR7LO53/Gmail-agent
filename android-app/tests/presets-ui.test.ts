// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.svelte'
import { FoodRepository } from '../src/data/food-repository'
import { prepareSchema } from '../src/data/schema'
import { openNodeSqlite } from './helpers/sqlite-node'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('../src/data/sqlite', () => ({ openFoodDatabase: async () => (globalThis as any).__presetTestDb }))

let directory: string
let db: ReturnType<typeof openNodeSqlite>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ggent-presets-ui-'))
  db = openNodeSqlite(join(directory, 'food.db'))
  ;(globalThis as any).__presetTestDb = db
  await prepareSchema(db)
})
afterEach(async () => { cleanup(); delete (globalThis as any).__presetTestDb; await db.close(); await rm(directory, { recursive: true, force: true }) })

describe('preset form user journey', () => {
  it('creates a preset, edits future values, and deletes only the tile while history remains', async () => {
    render(App)
    await screen.findByText('Brak produktów. Dodaj pierwszy produkt.')
    await fireEvent.click(screen.getByRole('button', { name: /Nowy produkt/ }))
    await fireEvent.input(screen.getByLabelText('Nazwa'), { target: { value: 'Jogurt' } })
    await fireEvent.input(screen.getByLabelText(/Energia/), { target: { value: '80' } })
    await fireEvent.input(screen.getByLabelText(/Białko/), { target: { value: '5' } })
    await fireEvent.input(screen.getByLabelText(/Węglowodany/), { target: { value: '10' } })
    await fireEvent.input(screen.getByLabelText(/Tłuszcz/), { target: { value: '2' } })
    await fireEvent.click(screen.getByLabelText('Śniadanie'))
    await fireEvent.click(screen.getByRole('button', { name: 'Zapisz produkt' }))
    await screen.findByText('80 kcal / 100 g')

    await fireEvent.click(screen.getByRole('button', { name: /Jogurt/ }))
    await fireEvent.click(screen.getByRole('button', { name: '1' }))
    await fireEvent.click(screen.getByRole('button', { name: '0' }))
    await fireEvent.click(screen.getByRole('button', { name: '0' }))
    await fireEvent.click(screen.getByRole('button', { name: /Dodaj 80 kcal/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Otwórz dzisiejsze wpisy/ })).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: /Otwórz dzisiejsze wpisy/ }))
    await screen.findByText('Jogurt')
    await fireEvent.click(screen.getByRole('button', { name: 'Edytuj Jogurt' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Edytuj produkt Jogurt' }))
    expect((screen.getByLabelText('Nazwa') as HTMLInputElement).value).toBe('Jogurt')
    await fireEvent.input(screen.getByLabelText('Nazwa'), { target: { value: 'Jogurt naturalny' } })
    await fireEvent.input(screen.getByLabelText(/Energia/), { target: { value: '120' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Zapisz produkt' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Edytuj produkt Jogurt naturalny/ })).toBeTruthy())
    expect((await new FoodRepository(db).listEntries('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'))[0]).toMatchObject({ name: 'Jogurt', kcal: 80 })

    await fireEvent.click(screen.getByRole('button', { name: 'Edytuj produkt Jogurt naturalny' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Usuń produkt' }))
    await screen.findByRole('button', { name: /Nowy produkt/ })
    expect(screen.queryByText('120 kcal / 100 g')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: /Otwórz dzisiejsze wpisy/ }))
    expect(screen.getByText('Jogurt')).toBeTruthy()
    expect(await new FoodRepository(db).listEntries('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')).toHaveLength(1)
  })
})
