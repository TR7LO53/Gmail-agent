import type { Preset, Slot } from './types'

export type PresetWrite = Pick<Preset, 'name' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g'> & {
  piece_weight_g?: number
  slot_tags?: readonly Slot[]
  aliases?: readonly string[]
}

const validSlots = new Set<Slot>(['breakfast', 'lunch', 'dinner'])

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Podaj poprawn\u0105 nieujemn\u0105 warto\u015b\u0107 pola ${field}.`)
  }
  return value
}

export function validatePresetWrite(value: PresetWrite): PresetWrite {
  if (!value || typeof value !== 'object') throw new Error('Nieprawid\u0142owe dane produktu.')
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Podaj nazw\u0119 produktu.')
  const result: PresetWrite = {
    name: value.name.trim(),
    kcal: nonNegative(value.kcal, 'kcal'),
    protein_g: nonNegative(value.protein_g, 'B'),
    carbs_g: nonNegative(value.carbs_g, 'W'),
    fat_g: nonNegative(value.fat_g, 'T'),
  }
  if (value.piece_weight_g !== undefined) {
    if (typeof value.piece_weight_g !== 'number' || !Number.isFinite(value.piece_weight_g) || value.piece_weight_g <= 0) {
      throw new Error('Waga jednej sztuki musi by\u0107 wi\u0119ksza od zera.')
    }
    result.piece_weight_g = value.piece_weight_g
  }
  const tags = value.slot_tags ?? []
  if (!Array.isArray(tags) || !tags.every((tag) => validSlots.has(tag))) throw new Error('Nieprawid\u0142owy tag pory dnia.')
  result.slot_tags = [...new Set(tags)]
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === 'string')) throw new Error('Nieprawid\u0142owe aliasy produktu.')
    result.aliases = [...value.aliases]
  }
  return result
}
