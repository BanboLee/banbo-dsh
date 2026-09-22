/** Browser plugin lifecycle and strict Remote mount order (§12.4 / Gate E). */

import { describe, expect, it, vi } from 'vitest'

import { apply, inject } from '../src/client/index.js'

const catalog = {
  generation: 'sha256-web',
  agents: [{
    id: 'worker', displayName: 'Worker', description: 'Implements.', forms: ['child'] as const,
    source: 'built-in' as const, defaultEnabled: true, modelEditable: true,
    allowedChildren: [], toolCapabilities: ['read'],
  }],
}

function fixture(options: { remoteFailure?: boolean, mountReject?: boolean } = {}) {
  const order: string[] = []
  const effects: Array<() => void | Promise<void>> = []
  const slotDisposer = vi.fn()
  const mountDisposer = vi.fn(async () => { order.push('unmount') })
  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const, value: { includeDefaults: true, agents: {} },
      base: { includeDefaults: true, agents: {} }, user: undefined,
      revision: 1, writable: true, mode: 'host' as const,
    }),
    subscribe: vi.fn(() => vi.fn()),
    mutate: vi.fn(),
    set: vi.fn(),
    unset: vi.fn(),
  }
  const register = vi.fn((_options, _component) => {
    order.push('register')
    return slotDisposer
  })
  // The namespace is resolved with `ctx.get` (root service store), NOT read as
  // `ctx.remote.<ns>`: that key is created by this plugin's own `$mount`, so
  // injecting it would deadlock and reading it as a property throws
  // `cannot get property "remote.banboAgentsCatalog" without inject` on the
  // real Web client.
  const catalogService = {
    list: vi.fn(async () => {
      order.push('list')
      return options.remoteFailure
        ? { ok: false, error: { code: 'gateway/internal', message: 'catalog failed' } }
        : { ok: true, value: catalog }
    }),
  }
  const ctx = {
    get: vi.fn((key: string) => (key === 'remote.banboAgentsCatalog' ? catalogService : undefined)),
    remote: {
      $mount: vi.fn(async () => {
        order.push('mount')
        if (options.mountReject) throw new Error('mount failed')
        return mountDisposer
      }),
    },
    settingsScope: {
      bind: vi.fn(() => {
        order.push('bind')
        return scope
      }),
    },
    slots: {
      inject: vi.fn((_name, factory) => {
        order.push('inject-slot')
        const yielded = [...factory()]
        return () => { for (const dispose of yielded.reverse()) dispose() }
      }),
      register,
    },
    locale: {
      register: vi.fn(() => vi.fn()),
      bind: vi.fn(() => (key: string) => key),
    },
    effect: vi.fn((factory: () => void | (() => void | Promise<void>)) => {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return Promise.resolve()
    }),
  }
  return {
    ctx,
    order,
    scope,
    slotDisposer,
    mountDisposer,
    async dispose() {
      for (const dispose of effects.reverse()) await dispose()
    },
  }
}

interface StyleTag {
  dataset: Record<string, string>
  textContent: string
  remove(): void
}

/**
 * Minimal `document` for the style installer: enough to observe that the plugin
 * creates exactly one tag and removes the one it owns.
 */
function withDocument() {
  const styles: StyleTag[] = []
  const document = {
    querySelector(selector: string) {
      return styles.find((tag) => selector.includes(JSON.stringify(tag.dataset.pluginCss))) ?? null
    },
    createElement() {
      const tag: StyleTag = {
        dataset: {},
        textContent: '',
        remove() {
          const index = styles.indexOf(tag)
          if (index >= 0) styles.splice(index, 1)
        },
      }
      return tag
    },
    head: { appendChild(tag: StyleTag) { styles.push(tag) } },
  }
  const scope = globalThis as { document?: unknown }
  const previous = scope.document
  scope.document = document
  return {
    styles,
    restore() {
      if (previous === undefined) delete scope.document
      else scope.document = previous
    },
  }
}

describe('agents Web client plugin', () => {
  it('declares only services available before its own Remote contribution mounts', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'settingsScope'])
    expect(inject).not.toContain('remote.banboAgentsCatalog')
  })

  it('owns its style tag: one install per mount, removed on dispose (§12.4)', async () => {
    const doc = withDocument()
    try {
      const value = fixture()
      await apply(value.ctx as never)
      expect(doc.styles).toHaveLength(1)
      expect(doc.styles[0]!.dataset.plugin).toBe('@banbolee/dsh-agents')
      expect(doc.styles[0]!.dataset.pluginCss).toBe('@banbolee/dsh-agents/client.css')

      await value.dispose()
      // A replacement that does not own style teardown must not stack a second
      // copy of the stylesheet on every HMR cycle.
      expect(doc.styles).toHaveLength(0)
    } finally {
      doc.restore()
    }
  })

  it('removes the style again when startup fails after installing it', async () => {
    const doc = withDocument()
    try {
      const value = fixture({ mountReject: true })
      await expect(apply(value.ctx as never)).rejects.toThrow(/mount failed/)
      expect(doc.styles).toHaveLength(0)
    } finally {
      doc.restore()
    }
  })

  it('mounts its generated descriptor before calling/listing/registering the card', async () => {
    const value = fixture()
    await apply(value.ctx as never)

    expect(value.order).toEqual(['mount', 'list', 'bind', 'inject-slot', 'register'])
    expect(value.ctx.remote.$mount).toHaveBeenCalledTimes(1)
    expect(value.ctx.settingsScope.bind).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'banbo-agents',
      decode: expect.any(Function),
    }))
    expect(value.ctx.slots.register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.plugin.item',
      key: 'banbo-agents',
      locale: 'banbo.agents',
      inject: expect.any(Function),
    }), expect.any(Function))
  })

  it('disposes the slot/controller and mounted Remote in reverse ownership order', async () => {
    const value = fixture()
    await apply(value.ctx as never)
    await value.dispose()
    expect(value.slotDisposer).toHaveBeenCalledTimes(1)
    expect(value.mountDisposer).toHaveBeenCalledTimes(1)
    expect(value.order.at(-1)).toBe('unmount')
  })

  it('publishes no settings scope or slot when descriptor mount fails', async () => {
    const value = fixture({ mountReject: true })
    await expect(apply(value.ctx as never)).rejects.toThrow(/mount failed/)
    expect(value.ctx.settingsScope.bind).not.toHaveBeenCalled()
    expect(value.ctx.slots.register).not.toHaveBeenCalled()
  })

  it('unmounts and publishes no card when the CatalogRemote reports failure', async () => {
    const value = fixture({ remoteFailure: true })
    await expect(apply(value.ctx as never)).rejects.toThrow(/catalog failed/)
    expect(value.mountDisposer).toHaveBeenCalledTimes(1)
    expect(value.ctx.settingsScope.bind).not.toHaveBeenCalled()
    expect(value.ctx.slots.register).not.toHaveBeenCalled()
  })
})
