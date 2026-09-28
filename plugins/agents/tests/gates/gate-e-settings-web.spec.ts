/** Gate E — official settings and third-party Web client platform probes. */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, SettingsForms } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { BanboAgentsCatalog } from '../../lib/catalog-remote.js'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'
import { Config } from '../../index.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

const settingsFixture = () => Object.freeze({ Config })

interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => { apply(ctx: unknown): Promise<void>, inject: string[] }
}

function browserHarness() {
  const registrations: Registration[] = []
  const styles: Array<{ dataset: Record<string, string>, textContent: string, remove(): void }> = []
  const document = {
    querySelector(selector: string) {
      return styles.find((style) => selector.includes(JSON.stringify(style.dataset.pluginCss))) ?? null
    },
    createElement(name: string) {
      if (name !== 'style') throw new Error(`unexpected element: ${name}`)
      const style = {
        dataset: {} as Record<string, string>,
        textContent: '',
        remove() {
          const index = styles.indexOf(style)
          if (index >= 0) styles.splice(index, 1)
        },
      }
      return style
    },
    head: { appendChild(style: { dataset: Record<string, string>, textContent: string, remove(): void }) { styles.push(style) } },
  }
  const context = {
    window: { __ModuleLoader__: { load(registration: Registration) { registrations.push(registration) } } },
    document,
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
  }
  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const execute = () => vm.runInNewContext(source, context, { filename: 'lib/client.js' })
  const materialize = (registration: Registration) => registration.factory((specifier) => {
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    throw new Error(`undeclared client external: ${specifier}`)
  })
  return {
    registrations,
    styles,
    execute,
    materialize,
  }
}

function clientContext(catalog = { generation: 'gate-e', agents: [] }) {
  const effects: Array<() => void | Promise<void>> = []
  let mounts = 0
  let slots = 0
  let locales = 0
  let listeners = 0
  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { includeDefaults: true, agents: {} },
      base: { includeDefaults: true, agents: {} },
      user: undefined,
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => {
      listeners += 1
      return () => { listeners -= 1 }
    },
    mutate: vi.fn(),
    set: vi.fn(),
    unset: vi.fn(),
  }
  const ctx = {
    // The catalog namespace is created by this plugin's own `$mount`, so it is
    // resolved with `ctx.get` (root service store) rather than injected or read
    // as `ctx.remote.<ns>` — see the client inject contract in
    // tests/client-copy.spec.ts.
    get: vi.fn((key: string) =>
      (key === 'remote.banboAgentsCatalog' ? { list: vi.fn(async () => ({ ok: true, value: catalog })) } : undefined)),
    remote: {
      $mount: vi.fn(async (contribution) => {
        expect(contribution).toMatchObject({
          package: '@banbolee/dsh-agents',
          descriptors: [{ namespace: 'banboAgentsCatalog', method: 'list', result: { mode: 'strict' } }],
        })
        mounts += 1
        return () => { mounts -= 1 }
      }),
    },
    settingsScope: { bind: vi.fn(() => scope) },
    configForms: { get: vi.fn(() => scope) },
    locale: {
      bind: vi.fn(() => (key: string) => key),
      register: vi.fn(() => {
        locales += 1
        return () => { locales -= 1 }
      }),
    },
    slots: {
      register: vi.fn(() => {
        slots += 1
        return () => { slots -= 1 }
      }),
      inject: vi.fn((_name, callback) => {
        const disposers = [...callback()]
        return () => { for (const dispose of disposers.reverse()) dispose() }
      }),
    },
    effect: vi.fn((factory: () => void | (() => void | Promise<void>)) => {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    }),
  }
  return {
    ctx,
    counts: () => ({ mounts, slots, locales, listeners }),
    async dispose() {
      for (const dispose of effects.reverse()) await dispose()
    },
  }
}

describe('E1 — 0.1.7 settings are row-derived, with no provider registration', () => {
  it('exposes the SettingsForms surface and none of the deleted provider API', () => {
    const forms = SettingsForms.prototype as unknown as Record<string, unknown>
    // The 0.1.7 surface this bundle's settings integration depends on.
    for (const member of ['configure', 'describe', 'update', 'replace', 'mutate', 'prepareDocument']) {
      expect(typeof forms[member], `SettingsForms.${member}`).toBe('function')
    }
    for (const dead of ['register', 'installSection', 'get', 'load', 'persist', 'publish']) {
      // `register()` and the provider hooks are what 0.1.5's `SettingsProvider`
      // had and this bundle used to call. They are GONE: a plugin's settings are
      // its own Loader row Config now.
      expect(forms[dead], `SettingsProvider.${dead} must no longer exist`).toBeUndefined()
    }
  })

  it('marks exactly the editable half of this row Config volatile', () => {
    // `describe()` projects the fields whose schema is volatile; the Loader
    // commits a settings write into the SAME reference, so the plugin reads the
    // new value without a remount. `enabled`/`rootDir` are deployment
    // configuration and stay ordinary (plain values, not forms).
    const parsed = Config({}) as Record<string, any>
    expect(parsed.enabled).toBe(true)
    expect(typeof parsed.includeDefaults.get).toBe('function')
    expect(typeof parsed.agents.get).toBe('function')
    expect(parsed.includeDefaults.get()).toBe(true)
    expect(parsed.agents.get()).toEqual({})

    const declared = Config({ includeDefaults: false, agents: { worker: { enabled: true } } }) as Record<string, any>
    expect(declared.includeDefaults.get()).toBe(false)
    expect(declared.agents.get()).toEqual({ worker: { enabled: true } })
  })

  it('keeps the conflict contract the card renders', async () => {
    const { Config: schema } = settingsFixture()
    expect(schema).toBe(Config)
    const conflict = new SettingsConflictError('banbo-agents' as never, 0, 1)
    expect(conflict).toMatchObject({
      name: 'SettingsConflictError', code: 'SETTINGS_CONFLICT', expected: 0, actual: 1,
    })
    expect(conflict.message).toContain('banbo-agents')
  })
})

describe('E2 — generated and packed Remote artifacts', () => {
  it('retains the Host decorator marker and a strict client descriptor', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('banboAgents', {
      generation: 'gate-e', definitions: new Map(), builtinIds: new Set(),
      abi: { agents: [] }, settings: { get: () => ({ includeDefaults: true, agents: {} }) },
    })
    const service = new BanboAgentsCatalog(ctx)
    expect(remoteMethods(service).map((marker) => marker.method)).toEqual(['list'])
    expect(TYPERT_REMOTE.descriptors).toHaveLength(1)
    expect(TYPERT_REMOTE.descriptors[0]).toMatchObject({
      service: 'banboAgentsCatalog', namespace: 'banboAgentsCatalog', method: 'list',
      result: { mode: 'strict' },
    })
    const result = TYPERT_REMOTE.descriptors[0]!.result
    expect(result.mode).toBe('strict')
    if (result.mode !== 'strict') throw new Error('expected strict generated codec')
    // 0.1.7 flipped the generated codec contract from an EAGER `schema:` (a zod
    // instance) to a LAZY `create:` factory; the loader and the registry both
    // refuse a descriptor without it. Building them literally is the generation
    // contract this gate exists to catch.
    expect(typeof result.create).toBe('function')
    expect(result).not.toHaveProperty('schema')
    expect(result.create().parse({ agents: [], generation: 'gate-e' })).toEqual({ agents: [], generation: 'gate-e' })
    expect(readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')).not.toContain('remoteMethods(')
  })
})

describe('E3 — third-party Web materialize, dispose and replacement', () => {
  it('replaces one live card without accumulating Remote, slot, locale, listener, or style state', async () => {
    const browser = browserHarness()
    browser.execute()
    const firstExports = browser.materialize(browser.registrations[0]!)
    const first = clientContext()
    await firstExports.apply(first.ctx)
    expect(first.counts()).toEqual({ mounts: 1, slots: 1, locales: 1, listeners: 1 })
    expect(browser.styles).toHaveLength(1)

    await first.dispose()
    // No manual compensation: the plugin owns its style tag, so disposal alone
    // must leave the page clean (§12.4).
    expect(browser.styles, 'dispose must remove the plugin\'s own style tag').toHaveLength(0)
    expect(first.counts()).toEqual({ mounts: 0, slots: 0, locales: 0, listeners: 0 })

    browser.execute()
    const secondExports = browser.materialize(browser.registrations[1]!)
    const second = clientContext()
    await secondExports.apply(second.ctx)
    expect(second.counts()).toEqual({ mounts: 1, slots: 1, locales: 1, listeners: 1 })
    expect(browser.styles).toHaveLength(1)
    await second.dispose()
    expect(browser.styles).toHaveLength(0)
  })

  it('does not import or write the official model-selection surface', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
    const host = readFileSync(join(pluginRoot, 'index.js'), 'utf8')
    const client = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
    expect(manifest.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-model-selection')
    expect(host).not.toContain('model/selection')
    expect(client).not.toContain('model/selection')
    expect(client).not.toContain('dsh-client-ui-model-selection')
  })
})

/* ------------------------------------------------------------------- E4 --- */

/**
 * The card's SEAT is a platform contract, not this bundle's choice: it must be
 * the slot the Plugins page actually renders a bundle's configuration into,
 * keyed the way that page addresses it. 0.1.5's `settings.plugin.item` list
 * seat is deleted, so the only correct answer is read from the package that
 * declares the new one.
 */
describe('E4 — the Plugins page seat this card occupies', () => {
  const managerRoot = dirname(require.resolve('@deepseek-ai/dsh-client-ui-plugin-manager/package.json'))

  it('registers into the keyed bundle-configuration seat the manager declares', () => {
    const contract = readFileSync(join(managerRoot, 'lib', 'types', 'client', 'slot-contract.d.ts'), 'utf8')
    // The seat exists, is KEYED (a list seat would be addressed by `id`), and
    // takes the bundle's package name as its key.
    expect(contract).toMatch(/'plugins\.bundle\.config':\s*\{[\s\S]{0,120}?kind:\s*'keyed'/)
    expect(contract).toMatch(/keyed by the bundle's package name/)
    expect(contract).toMatch(/'plugins\.bundle\.config':\s*\{[\s\S]{0,240}?owner:\s*PluginConfigViewProps/)
    // And the page renders it as a `page` (a bundle's configuration has no
    // summary view), looked up by the bundle's package name.
    const page = readFileSync(join(managerRoot, 'lib', 'client.js'), 'utf8')
    expect(page).toMatch(/renderSlot\(\s*"plugins\.bundle\.config"\s*,\s*\{\s*view:\s*"page"\s*\}\s*,\s*\{\s*entryKey:\s*pkg\.name\s*\}\s*\)/)
    expect(page).toMatch(/ledger\.bundles\.has\(openPkg\.name\)/)
  })

  it('ships a registration for exactly that seat, keyed by this package name', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
    const client = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
    expect(manifest.name).toBe('@banbolee/dsh-agents')
    expect(client).toContain('plugins.bundle.config')
    expect(client).not.toContain('settings.plugin.item')
    expect(client).not.toContain('settings.plugins.tab')
    // The card renders the page view only; anything else stays absent.
    expect(client).toMatch(/view !== "page"/)
    // The seat needs the manager's browser half served alongside this bundle.
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
  })
})
