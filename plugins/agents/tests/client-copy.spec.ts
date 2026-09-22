/**
 * Settings-card copy contract — plan §12.1.
 *
 * The two retirement shapes carry materially different recovery consequences,
 * and the card is the only in-product place that tells a user which one
 * applies. These tests pin the differentiation so a future edit cannot quietly
 * collapse both back into one generic sentence.
 */

import { describe, expect, it } from 'vitest'

import { dictionaries } from '../src/client/AgentSettingsCard.js'

describe('retired-row copy', () => {
  it('distinguishes a removed main form from a removed child-only form', () => {
    for (const locale of ['zh', 'en'] as const) {
      const dict = dictionaries[locale]
      expect(dict.retiredMainHint, locale).toBeTruthy()
      expect(dict.retiredChildHint, locale).toBeTruthy()
      expect(dict.retiredMainHint, `${locale} must not reuse the child copy`).not.toBe(dict.retiredChildHint)
    }
  })

  it('states the subtree consequence for main and the delegation consequence for child', () => {
    expect(dictionaries.zh.retiredMainHint).toMatch(/整棵子树/)
    expect(dictionaries.zh.retiredChildHint).toMatch(/委派/)
    expect(dictionaries.en.retiredMainHint).toMatch(/subtree/i)
    expect(dictionaries.en.retiredChildHint).toMatch(/delegat/i)
  })

  it('keeps both dictionaries on exactly the same key set', () => {
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
  })
})
