// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareSchema } from '../src/data/schema'
import { openNodeSqlite } from './helpers/sqlite-node'
import App from '../src/App.svelte'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('../src/data/sqlite', () => ({ openFoodDatabase: async () => (globalThis as any).__backupUiDb }))
vi.mock('../src/lib/backup-files', () => ({ shareBackupFile: vi.fn(), readBackupFile: async (file: File) => (file as any).contents }))

let directory: string
let db: ReturnType<typeof openNodeSqlite>
const backup = (version = 1) => JSON.stringify({ version, food_presets: [{ id: 42, name: 'Produkt z kopii', aliases: ['alias'], kcal: 90, protein_g: 2, carbs_g: 10, fat_g: 3, slots: ['lunch'], piece_weight_g: 20 }], food_log: [] })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ggent-backup-ui-'))
  db = openNodeSqlite(join(directory, 'food.sqlite'))
  ;(globalThis as any).__backupUiDb = db
  await prepareSchema(db)
})
afterEach(async () => { cleanup(); delete (globalThis as any).__backupUiDb; await db.close(); await rm(directory, { recursive: true, force: true }) })

describe('backup settings UI', () => {
  it('imports from settings, refreshes starred tiles and reports counts without submitting settings', async () => {
    render(App)
    await screen.findByText('Brak produktów. Dodaj pierwszy produkt.')
    await fireEvent.click(screen.getByRole('button', { name: 'Ustawienia' }))
    const file = Object.assign(new File(['ignored'], 'backup.json', { type: 'application/json' }), { contents: backup() })
    const input = screen.getByLabelText('Importuj kopię') as HTMLInputElement
    await fireEvent.change(input, { target: { files: [file] } })
    expect((await screen.findByRole('status')).textContent).toContain('Dodano produktów: 1; pominięto: 0; dodano wpisów historii: 0.')
    await fireEvent.click(screen.getByRole('button', { name: '‹ Pantry' }))
    expect(await screen.findByText('Produkt z kopii')).toBeTruthy()
    expect(screen.getByLabelText('Z Ggent')).toBeTruthy()
    expect((await db.query<any>('SELECT goal_kcal FROM app_settings WHERE id=1'))[0].goal_kcal).toBe(2000)
  })

  it('shows a Polish version error and leaves the database empty', async () => {
    render(App)
    await screen.findByText('Brak produktów. Dodaj pierwszy produkt.')
    await fireEvent.click(screen.getByRole('button', { name: 'Ustawienia' }))
    const file = Object.assign(new File(['ignored'], 'bad.json'), { contents: backup(99) })
    await fireEvent.change(screen.getByLabelText('Importuj kopię'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain('Nieobsługiwana wersja kopii.')
    expect(await db.query('SELECT * FROM food_presets')).toHaveLength(0)
  })
})
