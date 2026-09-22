/** Gate E — official settings and third-party Web client platform probes. */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SettingsConflictError, SettingsProvider } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { BanboAgentsCatalog } from '../../lib/catalog-remote.js'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

class MemorySettings extends SettingsProvider {
  readonly writable = true
  readonly persisted: Array<{ ns: string, section: Record<string, unknown> }> = []

  constructor(ctx: Context, private stored: Record<string, unknown> = {}) {
    super(ctx)
  }

  protected async load(): Promise<Record<string, unknown>> {
    return structuredClone(this.stored)
  }

  protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.stored[ns] = structuredClone(section)
    this.persisted.push({ ns, section: structuredClone(section) })
  }

  external(document: Record<string, unknown>): void {
    this.stored = structuredClone(document)
    this.publish(structuredClone(document), 'provider')
  }
}

function settingsFixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const provider = new MemorySettings(ctx)
  const schema = z.object({
    enabled: z.boolean().default(true),
    count: z.number().default(1),
  })
  provider.register('probe-settings', schema)
  return { ctx, provider }
}

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
    remote: {
      $mount: vi.fn(async (contribution) => {
        expect(contribution).toMatchObject({
          package: '@banbolee/dsh-agents',
          descriptors: [{ namespace: 'banboAgentsCatalog', method: 'list', result: { mode: 'strict' } }],
        })
        mounts += 1
        return () => { mounts -= 1 }
      }),
      banboAgentsCatalog: { list: vi.fn(async () => ({ ok: true, value: catalog })) },
    },
    settingsScope: { bind: vi.fn(() => scope) },
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

describe('E1 — official settings revision and last-good behavior', () => {
  it('applies one path mutation and refuses a stale expected revision', async () => {
    const { provider } = settingsFixture()
    expect(provider.describe()[0]?.revision).toBe(0)

    await provider.mutate('probe-settings', [{ op: 'set', path: ['count'], value: 2 }], 0)
    expect(provider.get('probe-settings')).toEqual({ enabled: true, count: 2 })
    expect(provider.describe()[0]?.revision).toBe(1)

    await expect(provider.mutate('probe-settings', [{ op: 'set', path: ['count'], value: 3 }], 0))
      .rejects.toMatchObject({
        name: 'SettingsConflictError', code: 'SETTINGS_CONFLICT', expected: 0, actual: 1,
      } satisfies Partial<SettingsConflictError>)
    expect(provider.get('probe-settings')).toEqual({ enabled: true, count: 2 })
    expect(provider.persisted).toHaveLength(1)
  })

  it('keeps the last good resolved value after an invalid external section', () => {
    const { ctx, provider } = settingsFixture()
    const warn = vi.spyOn(ctx.logger, 'warn')
    provider.external({ 'probe-settings': { enabled: false, count: 4 } })
    expect(provider.get('probe-settings')).toEqual({ enabled: false, count: 4 })
    expect(provider.describe()[0]?.revision).toBe(1)

    provider.external({ 'probe-settings': { enabled: 'invalid', count: 9 } })
    expect(provider.get('probe-settings')).toEqual({ enabled: false, count: 4 })
    expect(provider.describe()[0]?.revision).toBe(1)
    expect(warn).toHaveBeenCalledWith('settings: keeping last good "%s" after invalid stored section', 'probe-settings')
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
    expect(result.schema.parse({ agents: [], generation: 'gate-e' })).toEqual({ agents: [], generation: 'gate-e' })
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
