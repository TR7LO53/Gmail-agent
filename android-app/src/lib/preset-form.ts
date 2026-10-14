import type { Preset, Slot } from '../core/types'
import type { PresetWrite } from '../core/presets'

export interface PresetDraft {
  name: string
  kcal: string
  protein_g: string
  carbs_g: string
  fat_g: string
  piece_weight_g: string
  slot_tags: Slot[]
}

export function emptyPresetDraft(): PresetDraft {
  return { name: '', kcal: '', protein_g: '', carbs_g: '', fat_g: '', piece_weight_g: '', slot_tags: [] }
}

export function presetToDraft(preset: Preset): PresetDraft {
  return {
    name: preset.name,
    kcal: String(preset.kcal),
    protein_g: String(preset.protein_g),
    carbs_g: String(preset.carbs_g),
    fat_g: String(preset.fat_g),
    piece_weight_g: preset.piece_weight_g == null ? '' : String(preset.piece_weight_g),
    slot_tags: [...(preset.slot_tags ?? [])],
  }
}

function parseNumber(text: string, label: string, optional = false): number | undefined {
  const value = text.trim()
  if (!value && optional) return undefined
  if (!value) throw new Error(`Uzupe\u0142nij pole ${label}.`)
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value)) throw new Error(`Podaj poprawn\u0105 warto\u015b\u0107 pola ${label}.`)
  const number = Number(value.replace(',', '.'))
  if (!Number.isFinite(number) || number < 0) throw new Error(`Podaj poprawn\u0105 nieujemn\u0105 warto\u015b\u0107 pola ${label}.`)
  return number
}

export function presetDraftToWrite(draft: PresetDraft): PresetWrite {
  const name = draft.name.trim()
  if (!name) throw new Error('Podaj nazw\u0119 produktu.')
  const piece = parseNumber(draft.piece_weight_g, 'wagi sztuki', true)
  if (piece === 0) throw new Error('Waga jednej sztuki musi by\u0107 wi\u0119ksza od zera.')
  return {
    name,
    kcal: parseNumber(draft.kcal, 'kcal')!,
    protein_g: parseNumber(draft.protein_g, 'B')!,
    carbs_g: parseNumber(draft.carbs_g, 'W')!,
    fat_g: parseNumber(draft.fat_g, 'T')!,
    ...(piece === undefined ? {} : { piece_weight_g: piece }),
    slot_tags: [...draft.slot_tags],
  }
}
