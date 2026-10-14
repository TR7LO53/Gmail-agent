import { describe, expect, it } from 'vitest'
import { validatePresetWrite } from './presets'

const base = { name: "  Łosoś O'Neil  ", kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }

describe('validatePresetWrite', () => {
  it('trims the name, accepts zero macros, and de-duplicates valid slot tags', () => {
    expect(validatePresetWrite({ ...base, slot_tags: ['lunch', 'breakfast', 'lunch'] })).toEqual({
      name: "Łosoś O'Neil", kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
      slot_tags: ['lunch', 'breakfast'],
    })
  })

  it.each([
    { ...base, name: '   ' },
    { ...base, kcal: -1 },
    { ...base, protein_g: Number.NaN },
    { ...base, carbs_g: Number.POSITIVE_INFINITY },
    { ...base, piece_weight_g: 0 },
    { ...base, slot_tags: ['snack'] as never },
  ])('rejects invalid preset values', (value) => expect(() => validatePresetWrite(value)).toThrow())

  it('copies aliases and accepts an empty tag list', () => {
    const aliases = ['ryba']
    const value = validatePresetWrite({ ...base, aliases, slot_tags: [] })
    aliases.push('dodatkowy')
    expect(value).toMatchObject({ aliases: ['ryba'], slot_tags: [] })
  })
})
