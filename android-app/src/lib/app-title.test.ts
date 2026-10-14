import { describe, expect, it } from 'vitest'
import { appTitle } from './app-title'

describe('app title', () => {
  it('uses the Polish food app title', () => {
    expect(appTitle).toBe('Ggent — jedzenie')
  })
})
