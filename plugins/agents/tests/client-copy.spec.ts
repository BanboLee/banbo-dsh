/**
 * Settings-card copy contract — plan §12.1.
 *
 * The two retirement shapes carry materially different recovery consequences,
 * and the card is the only in-product place that tells a user which one
 * applies. These tests pin the differentiation so a future edit cannot quietly
 * collapse both back into one generic sentence.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { dictionaries } from '../src/client/AgentSettingsCard.js'
import { inject } from '../src/client/index.js'

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

/* --------------------------------------------------- client inject contract --- */

describe('the Remote namespace is resolved, never injected', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(resolve(here, '..'), 'src', 'client', 'index.tsx'), 'utf8')

  it('does NOT inject the namespace it mounts itself', () => {
    // Cordis resolves `ctx.remote.<ns>` as its own nested service key, but that
    // key is created by THIS plugin's `$mount`. Injecting it would make `apply`
    // wait for a service `apply` itself mounts — a deadlock — so it must stay
    // out of `inject` even though the client legitimately uses the namespace.
    const namespaces = [...source.matchAll(/['"]remote\.([A-Za-z_$][\w$]*)['"]/g)].map((match) => match[1])
    expect(namespaces.length, 'the client must name its Remote namespace').toBeGreaterThan(0)
    for (const namespace of namespaces) {
      expect(inject, `injecting "remote.${namespace}" would deadlock`).not.toContain(`remote.${namespace}`)
    }
    expect(inject).toContain('remote')
  })

  it('reaches the namespace through ctx.get, which needs no inject', () => {
    // The real Web client refused the whole entry with
    //   `cannot get property "remote.banboAgentsCatalog" without inject`
    // when the namespace was read as a property. `ctx.get` reads the root
    // service store, exactly like the Gateway's own `this.ctx.get(serviceKey)`,
    // so it resolves a namespace this plugin just mounted.
    expect(source).toMatch(/ctx\.get\(\s*CATALOG_NAMESPACE_KEY\s*\)/)
    // `ctx.remote.$mount` / `$on` are members of the `remote` SERVICE and stay
    // legal; a `ctx.remote.<namespace>` property read is what must not return.
    expect(source, 'no property-style namespace access may come back').not.toMatch(/ctx\.remote\.(?!\$)[A-Za-z_]/)
  })

  it('fails loudly when the Gateway published nothing', () => {
    expect(source).toMatch(/the Gateway did not publish/)
  })
})
