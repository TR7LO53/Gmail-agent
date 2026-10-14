import type { Slot } from './types'

export const BACKUP_VERSION = 1

export interface BackupPreset {
  id: number
  name: string
  aliases: string[]
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  slots: Slot[]
  piece_weight_g: number | null
}

export interface BackupEntry {
  id: number
  ts: string
  source: string
  raw_input: string | null
  query_en: string | null
  original: string | null
  name: string
  qty: number
  unit: 'g'
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  provenance: string | null
  preset_id: number | null
}

export interface FoodBackup {
  version: 1
  food_presets: BackupPreset[]
  food_log: BackupEntry[]
}

const slots = new Set<Slot>(['breakfast', 'lunch', 'dinner'])
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(detail: string): never { throw new Error(`Nieprawidłowe dane kopii: ${detail}.`) }
function identifier(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(`pole ${field}`)
  return value
}
function number(value: unknown, field: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) fail(`pole ${field}`)
  return value
}
function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`pole ${field}`)
  return value
}
function nullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail(`pole ${field}`)
  return value
}
function stringArray(value: unknown, field: string): string[] {
  let normalized = value
  if (field === 'aliases' && typeof value === 'string') {
    try { normalized = JSON.parse(value) as unknown } catch { return fail('pole aliases') }
  }
  if (!Array.isArray(normalized) || !normalized.every((item) => typeof item === 'string')) fail(`pole ${field}`)
  return [...normalized]
}
function parsePreset(value: unknown): BackupPreset {
  if (!isObject(value)) fail('produkt')
  const result = {
    id: identifier(value.id, 'id produktu'),
    name: nonempty(value.name, 'name produktu'),
    aliases: stringArray(value.aliases === undefined ? [] : value.aliases, 'aliases'),
    kcal: number(value.kcal, 'kcal produktu'),
    protein_g: number(value.protein_g, 'protein_g produktu'),
    carbs_g: number(value.carbs_g, 'carbs_g produktu'),
    fat_g: number(value.fat_g, 'fat_g produktu'),
    slots: stringArray(value.slots === undefined ? [] : value.slots, 'slots').map((slot) => {
      if (!slots.has(slot as Slot)) fail('slots')
      return slot as Slot
    }),
    piece_weight_g: value.piece_weight_g == null ? null : number(value.piece_weight_g, 'piece_weight_g', true),
  }
  return result
}
function parseEntry(value: unknown): BackupEntry {
  if (!isObject(value)) fail('wpis historii')
  if (typeof value.ts !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value.ts) || !Number.isFinite(Date.parse(value.ts))) fail('ts')
  const [, year, month, day, hour, minute, second] = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(value.ts)!
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) fail('ts')
  if (value.unit !== 'g') fail('unit (obsługiwana jednostka to g)')
  const presetId = value.preset_id == null ? null : identifier(value.preset_id, 'preset_id')
  return {
    id: identifier(value.id, 'id wpisu'), ts: new Date(value.ts).toISOString(),
    source: nonempty(value.source, 'source'), raw_input: nullableText(value.raw_input, 'raw_input'),
    query_en: nullableText(value.query_en, 'query_en'), original: nullableText(value.original, 'original'),
    name: nonempty(value.name, 'name wpisu'), qty: number(value.qty, 'qty', true), unit: 'g',
    kcal: number(value.kcal, 'kcal wpisu'), protein_g: number(value.protein_g, 'protein_g wpisu'),
    carbs_g: number(value.carbs_g, 'carbs_g wpisu'), fat_g: number(value.fat_g, 'fat_g wpisu'),
    provenance: nullableText(value.provenance, 'provenance'), preset_id: presetId,
  }
}
function unique<T>(items: T[], getId: (item: T) => number, label: string) {
  const ids = new Set<number>()
  for (const item of items) { const id = getId(item); if (ids.has(id)) fail(`powtórzone ID ${label}`); ids.add(id) }
}

export function buildFoodBackup(presets: readonly BackupPreset[], entries: readonly BackupEntry[]): FoodBackup {
  return parseFoodBackup(JSON.stringify({ version: BACKUP_VERSION, food_presets: presets, food_log: entries }))
}

export function serializeFoodBackup(backup: FoodBackup): string {
  return JSON.stringify(parseFoodBackup(JSON.stringify(backup)), null, 2)
}

export function parseFoodBackup(text: string): FoodBackup {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { throw new Error('Plik kopii nie zawiera poprawnego JSON.') }
  if (!isObject(value)) fail('oczekiwano obiektu kopii')
  if (value.version !== BACKUP_VERSION) throw new Error('Nieobsługiwana wersja kopii.')
  if (!Array.isArray(value.food_presets) || !Array.isArray(value.food_log)) fail('brak tablic food_presets lub food_log')
  const presets = value.food_presets.map(parsePreset)
  const entries = value.food_log.map(parseEntry)
  unique(presets, (item) => item.id, 'produktu')
  unique(entries, (item) => item.id, 'wpisu')
  const names = new Set<string>()
  for (const preset of presets) { if (names.has(preset.name)) fail('powtórzona nazwa produktu'); names.add(preset.name) }
  const presetIds = new Set(presets.map((preset) => preset.id))
  if (entries.some((entry) => entry.preset_id !== null && !presetIds.has(entry.preset_id))) fail('nieistniejące odwołanie preset_id')
  return { version: BACKUP_VERSION, food_presets: presets, food_log: entries }
}
