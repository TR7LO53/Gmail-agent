import { describe, expect, it } from 'vitest'
import { appendDecimal, appendDigit, backspace, parseGrams } from '../src/lib/grams-input'

describe('grams input', () => {
  it('accepts decimal grams, editing and positive values only', () => {
    expect(appendDigit('8', '0')).toBe('80')
    expect(appendDecimal('80')).toBe('80,')
    expect(parseGrams('80,5')).toBe(80.5)
    expect(backspace('80,5')).toBe('80,')
    expect(parseGrams('0')).toBeUndefined()
    expect(parseGrams('NaN')).toBeUndefined()
    expect(parseGrams('-1')).toBeUndefined()
  })
})
