import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../src/client/styles.css', import.meta.url), 'utf8')
/** Selector list of every rule whose body sets `property: value`. */
const selectorsSetting = (declaration: string): string[] =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => body!.includes(declaration)).map(([, selector]) => selector!.trim())

describe('styles', () => {
  it('styles only the search match with the highlight, never archived titles', () => {
    const highlighted = selectorsSetting('font-weight: 600').filter(selector => selector.includes('t3sb-search-mark'))
    expect(highlighted).toEqual(['.t3sb-search-mark'])
    for (const selector of selectorsSetting('color: var(--dsw-alias-label-primary)')) expect(selector).not.toMatch(/t3sb-archived/)
  })
})
