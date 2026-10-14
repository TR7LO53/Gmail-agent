import { describe, expect, it } from 'vitest'
import { emptyPresetDraft, presetDraftToWrite, presetToDraft } from '../src/lib/preset-form'

describe('preset form draft', () => {
  it('starts empty and converts decimal commas, including fractional piece weights', () => {
    const draft = { ...emptyPresetDraft(), name: ' Produkt ', kcal: '4,3', protein_g: '0', carbs_g: '1.25', fat_g: '2', piece_weight_g: '12,5' }
    expect(presetDraftToWrite(draft)).toEqual({ name: 'Produkt', kcal: 4.3, protein_g: 0, carbs_g: 1.25, fat_g: 2, piece_weight_g: 12.5, slot_tags: [] })
    expect(emptyPresetDraft()).toMatchObject({ name: '', kcal: '', slot_tags: [] })
  })

  it('rejects missing fields, invalid numbers, and non-positive piece weights', () => {
    const empty = emptyPresetDraft()
    expect(() => presetDraftToWrite(empty)).toThrow()
    const filled = { ...empty, name: 'Test', kcal: '1', protein_g: '1', carbs_g: '1', fat_g: '1' }
    for (const value of ['', '-1', 'text', 'NaN', 'Infinity']) {
      expect(() => presetDraftToWrite({ ...filled, protein_g: value })).toThrow()
    }
    expect(() => presetDraftToWrite({ ...filled, piece_weight_g: '0' })).toThrow()
    expect(presetDraftToWrite({ ...filled, piece_weight_g: '' }).piece_weight_g).toBeUndefined()
  })

  it('supports every tag combination and copies preset tags into a separate draft', () => {
    const slots = ['breakfast', 'lunch', 'dinner'] as const
    for (let mask = 0; mask < 8; mask++) {
      const selected = slots.filter((_, index) => (mask & (1 << index)) !== 0)
      expect(presetDraftToWrite({ name: 'A', kcal: '1', protein_g: '2', carbs_g: '3', fat_g: '4', piece_weight_g: '', slot_tags: [...selected] }).slot_tags).toEqual(selected)
    }
    const preset = { name: 'A', kcal: 1, protein_g: 2, carbs_g: 3, fat_g: 4, slot_tags: ['lunch'] as ('lunch')[] }
    const draft = presetToDraft(preset)
    draft.slot_tags.push('dinner')
    expect(preset.slot_tags).toEqual(['lunch'])
  })
})
