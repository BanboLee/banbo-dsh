import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createMutationCollector } from '../collector.js'
import { createDiagnosticsCoordinator } from '../coordinator.js'
import { apply, Config, inject, name } from '../index.js'
import { DiagnosticsRuntime } from '../runtime.js'
import { DEFAULT_CONFIG } from './helpers.js'

// Count real component construction without replacing their behavior. The
// disabled path must construct none of the collector/runtime/coordinator trio.
vi.mock('../collector.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../collector.js')>()
  return { ...original, createMutationCollector: vi.fn(original.createMutationCollector) }
})

vi.mock('../runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../runtime.js')>()
  const instances: InstanceType<typeof original.DiagnosticsRuntime>[] = []
  const MockRuntime = vi.fn(function (options: ConstructorParameters<typeof original.DiagnosticsRuntime>[0]) {
    const instance = new original.DiagnosticsRuntime(options)
    instances.push(instance)
    return instance
  })
  Object.setPrototypeOf(MockRuntime, original.DiagnosticsRuntime)
  MockRuntime.prototype = original.DiagnosticsRuntime.prototype
  ;(MockRuntime as unknown as { __instances: typeof instances }).__instances = instances
  return { ...original, DiagnosticsRuntime: MockRuntime }
})

// Wrap the real coordinator so cleanup order and await boundaries can be
// asserted per event: apply() still receives the genuine implementation, only
// the returned object's methods are observed.
vi.mock('../coordinator.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../coordinator.js')>()
  const coordinatorCalls: string[] = []
  const instances: Array<Record<string, (...args: unknown[]) => unknown>> = []
  const mocked = vi.fn(
    ((options: Parameters<typeof original.createDiagnosticsCoordinator>[0]) => {
      const real = original.createDiagnosticsCoordinator(options)
      const wrapped: Record<string, (...args: unknown[]) => unknown> = {}
      for (const key of ['listener', 'stopAdmission', 'abortActiveOperations', 'awaitActiveOperations', 'awaitRetiredIo'] as const) {
        const method = real[key]
        wrapped[key] = (...args: unknown[]) => {
          coordinatorCalls.push(key)
          return (method as (...callArgs: unknown[]) => unknown)(...args)
        }
      }
      ;(wrapped as unknown as { __calls: string[] }).__calls = coordinatorCalls
      instances.push(wrapped)
      return wrapped as typeof real
    }) as never,
  )
  ;(mocked as unknown as { __calls: string[]; __instances: typeof instances }).__calls = coordinatorCalls
  ;(mocked as unknown as { __calls: string[]; __instances: typeof instances }).__instances = instances
  return { ...original, createDiagnosticsCoordinator: mocked }
})

function validated(value: unknown): unknown {
  return Config['~standard'].validate(value).value
}

function mutableServers(): {
  typescript: Record<string, unknown>
  go: Record<string, unknown>
} {
  return structuredClone(DEFAULT_CONFIG.servers) as {
    typescript: Record<string, unknown>
    go: Record<string, unknown>
  }
}

describe('dsh-lsp-diagnostics Config schema', () => {
  it('exposes a standard-schema validator on the namespace', () => {
    expect(typeof Config['~standard']?.validate).toBe('function')
  })

  it('applies every default when config is omitted or empty', () => {
    expect(validated(undefined)).toEqual(DEFAULT_CONFIG)
    expect(validated({})).toEqual(DEFAULT_CONFIG)
  })

  it('preserves explicit enabled=true and explicit enabled=false', () => {
    expect(validated({ enabled: true })).toMatchObject({ enabled: true })
    expect(validated({ enabled: false })).toMatchObject({ enabled: false })
  })

  it('rejects explicit null for the config and every typed non-JSON-null field', () => {
    expect(() => validated(null)).toThrow()
    for (const [key, value] of [
      ['enabled', null],
      ['timeoutMs', null],
      ['settleMs', null],
      ['reportClean', null],
      ['servers', null],
    ] as const) {
      expect(() => validated({ [key]: value }), `${key}=null`).toThrow()
    }
    for (const field of ['command', 'args', 'env', 'extensionToLanguage'] as const) {
      const servers = mutableServers()
      servers.typescript[field] = null
      expect(() => validated({ servers }), `servers.typescript.${field}=null`).toThrow()
    }
  })

  it('rejects non-boolean enabled', () => {
    for (const enabled of [null, 0, 1, 'false', [], {}]) {
      expect(() => validated({ enabled })).toThrow()
    }
  })

  it('rejects unknown top-level keys', () => {
    expect(() => validated({ nope: true })).toThrow()
  })

  it('rejects unknown servers provider keys and missing/renamed providers', () => {
    const servers = mutableServers()
    expect(() => validated({ servers: { ...servers, rust: servers.go } })).toThrow()
    expect(() => validated({ servers: { typescript: servers.typescript } })).toThrow()
    expect(() => validated({ servers: { TypeScript: servers.typescript, go: servers.go } })).toThrow()
    expect(() => validated({ servers: [] })).toThrow()
    expect(() => validated({ servers: 'x' })).toThrow()
  })

  it('rejects unknown keys inside a server', () => {
    const servers = mutableServers()
    servers.typescript.bogus = 1
    expect(() => validated({ servers })).toThrow()
  })

  it('rejects unknown extension keys, case variants, missing entries, duplicates, and rewritten routes', () => {
    // Unknown extension.
    let servers = mutableServers()
    ;(servers.typescript.extensionToLanguage as Record<string, string>)['.js'] = 'javascript'
    expect(() => validated({ servers })).toThrow()
    // Case variant.
    servers = mutableServers()
    ;(servers.typescript.extensionToLanguage as Record<string, string>)['.TS'] = 'typescript'
    expect(() => validated({ servers })).toThrow()
    // Missing canonical extension (.tsx removed).
    servers = mutableServers()
    delete (servers.typescript.extensionToLanguage as Record<string, string>)['.tsx']
    expect(() => validated({ servers })).toThrow()
    // Duplicate normalized extension across providers.
    servers = mutableServers()
    ;(servers.go.extensionToLanguage as Record<string, string>)['.tsx'] = 'go'
    expect(() => validated({ servers })).toThrow()
    // Rewritten language route (.ts must stay typescript/typescript).
    servers = mutableServers()
    ;(servers.typescript.extensionToLanguage as Record<string, string>)['.ts'] = 'typescriptreact'
    expect(() => validated({ servers })).toThrow()
    // Canonical extension declared by the wrong provider.
    servers = mutableServers()
    ;(servers.typescript.extensionToLanguage as Record<string, string>)['.go'] = 'go'
    expect(() => validated({ servers })).toThrow()
  })

  it('rejects non-object extensionToLanguage and empty language ids', () => {
    let servers = mutableServers()
    servers.typescript.extensionToLanguage = 'ts'
    expect(() => validated({ servers })).toThrow()
    servers = mutableServers()
    ;(servers.go.extensionToLanguage as Record<string, string>)['.go'] = ''
    expect(() => validated({ servers })).toThrow()
  })

  it('rejects invalid command, args, and env', () => {
    let servers = mutableServers()
    servers.typescript.command = ''
    expect(() => validated({ servers })).toThrow()
    servers = mutableServers()
    servers.typescript.command = 42
    expect(() => validated({ servers })).toThrow()
    servers = mutableServers()
    servers.typescript.args = '--stdio'
    expect(() => validated({ servers })).toThrow()
    servers = mutableServers()
    servers.typescript.args = [1]
    expect(() => validated({ servers })).toThrow()
    servers = mutableServers()
    ;(servers.typescript.env as Record<string, unknown>).A = 1
    expect(() => validated({ servers })).toThrow()
  })

  it('rejects non-JSON-representable configuration and initializationOptions', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const inheritedToJsonBigInt = Object.create({ toJSON: () => 1n }) as Record<string, unknown>
    for (const bad of [
      cyclic,
      { a: undefined },
      { a: () => 1 },
      { a: 1n },
      Object(1n),
      inheritedToJsonBigInt,
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: Symbol('x') },
    ]) {
      const servers = mutableServers()
      servers.typescript.configuration = bad
      expect(() => validated({ servers }), `configuration ${String(bad)}`).toThrow()
      servers.typescript.configuration = DEFAULT_CONFIG.servers.typescript.configuration
      servers.typescript.initializationOptions = bad
      expect(() => validated({ servers }), `initializationOptions ${String(bad)}`).toThrow()
    }
  })

  it('rejects explicit undefined configuration/initializationOptions instead of defaulting them', () => {
    // Only a truly omitted field falls back to the default; an own enumerable
    // property whose value is undefined is not a JSON value and must fail loud.
    for (const field of ['configuration', 'initializationOptions'] as const) {
      const servers = mutableServers()
      servers.typescript[field] = undefined
      expect(() => validated({ servers }), `${field}=undefined`).toThrow()
    }
  })

  it('rejects non-plain JSON containers (Map/Set/Date/custom prototypes) at load time', () => {
    const bads: unknown[] = [
      new Map([['a', 1]]),
      new Set([1]),
      new Date(0),
      new Number(1),
      new String('x'),
      new Boolean(false),
      Object.create({ inherited: 1 }),
      { nested: new Map([['x', 'y']]) },
    ]
    for (const bad of bads) {
      const servers = mutableServers()
      servers.typescript.configuration = bad
      expect(() => validated({ servers }), `configuration ${String(bad)}`).toThrow()
    }
  })

  it('canonicalizes configuration/initializationOptions into stable plain JSON (stateful values snapshot once)', () => {
    // A stateful value (a getter) must be canonicalized exactly once at
    // validation: later protocol serialization reads a plain clone and can
    // never re-invoke the stateful accessor or observe a different value.
    let reads = 0
    const stateful = {
      get nested() {
        reads += 1
        return { ok: true }
      },
    }
    const servers = mutableServers()
    servers.typescript.configuration = stateful
    const result = validated({ servers }) as {
      servers: { typescript: { configuration: unknown } }
    }
    expect(reads).toBe(1)
    // The canonical clone serializes deterministically and repeatedly.
    const first = JSON.stringify(result.servers.typescript.configuration)
    const second = JSON.stringify(result.servers.typescript.configuration)
    expect(first).toBe('{"nested":{"ok":true}}')
    expect(second).toBe(first)
    // The validated config object is not the raw user object.
    expect(result.servers.typescript.configuration).not.toBe(stateful)
  })

  it('accepts valid nested JSON and preserves explicit JSON null values', () => {
    const servers = mutableServers()
    servers.typescript.configuration = null
    servers.typescript.initializationOptions = { nested: { list: [1, 'two', null, true] } }
    servers.go.configuration = { deep: { value: 3.5 } }
    servers.go.initializationOptions = null
    expect(validated({ servers })).toMatchObject({
      servers: {
        typescript: {
          configuration: null,
          initializationOptions: { nested: { list: [1, 'two', null, true] } },
        },
        go: { configuration: { deep: { value: 3.5 } }, initializationOptions: null },
      },
    })
  })

  it('rejects invalid timers/caps and accepts legal boundaries', () => {
    const bad = [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]
    for (const key of ['timeoutMs', 'settleMs', 'shutdownTimeoutMs', 'killGraceMs', 'maxDocumentBytes', 'maxMessageBytes', 'maxStderrBytes', 'maxDiagnostics', 'maxResultChars'] as const) {
      for (const value of bad) {
        expect(() => validated({ [key]: value }), `${key}=${value}`).toThrow()
      }
    }
    expect(validated({ maxResultChars: 1 })).toMatchObject({ maxResultChars: 1 })
    expect(validated({ timeoutMs: 2_147_483_647 })).toMatchObject({ timeoutMs: 2_147_483_647 })
  })

  it('enforces settleMs < timeoutMs', () => {
    expect(() => validated({ timeoutMs: 200, settleMs: 200 })).toThrow()
    expect(() => validated({ timeoutMs: 100, settleMs: 200 })).toThrow()
    expect(validated({ timeoutMs: 201, settleMs: 200 })).toMatchObject({ timeoutMs: 201, settleMs: 200 })
  })

  it('defaults per-server fields while validating provided overrides', () => {
    const servers = mutableServers()
    servers.typescript = { command: 'custom-ts' }
    expect(validated({ servers })).toMatchObject({
      servers: {
        typescript: { command: 'custom-ts', args: ['--stdio'], extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' } },
        go: DEFAULT_CONFIG.servers.go,
      },
    })
  })
})

describe('dsh-lsp-diagnostics plugin entry', () => {
  it('exports the named namespace surface without a default export', async () => {
    const mod = await import('../index.js')
    expect(mod.name).toBe('lsp-diagnostics')
    expect(mod.inject).toEqual(['fs', 'subprocess', 'tools'])
    expect(typeof mod.Config['~standard']?.validate).toBe('function')
    expect('default' in mod).toBe(false)
    expect(name).toBe('lsp-diagnostics')
    expect(inject).toEqual(['fs', 'subprocess', 'tools'])
  })

  it('loads through the real namespace object via ctx.plugin', async () => {
    const ctx = new Context()
    await ctx.provide('fs', {})
    await ctx.provide('subprocess', {})
    await ctx.provide('tools', {})
    await ctx.plugin(await import('../index.js'), DEFAULT_CONFIG)
  })

  it('fails loud at load time for invalid config', async () => {
    const ctx = new Context()
    await ctx.provide('fs', {})
    await ctx.provide('subprocess', {})
    await ctx.provide('tools', {})
    await expect(
      ctx.plugin(await import('../index.js'), { timeoutMs: 0 } as unknown as Parameters<typeof apply>[1]),
    ).rejects.toThrow()
    await expect(
      ctx.plugin(await import('../index.js'), { servers: { typescript: {} } } as unknown as Parameters<typeof apply>[1]),
    ).rejects.toThrow()
  })

  it('registers zero listeners/effects/processes when enabled=false', async () => {
    const ctx = new Context()
    const spawn = vi.fn()
    await ctx.provide('fs', {})
    await ctx.provide('subprocess', { spawn })
    await ctx.provide('tools', {})
    const onSpy = vi.spyOn(ctx, 'on')
    const effectSpy = vi.spyOn(ctx, 'effect')
    const before = {
      collector: vi.mocked(createMutationCollector).mock.calls.length,
      runtime: vi.mocked(DiagnosticsRuntime).mock.calls.length,
      coordinator: vi.mocked(createDiagnosticsCoordinator).mock.calls.length,
    }
    await ctx.plugin(await import('../index.js'), { enabled: false } as unknown as Parameters<typeof apply>[1])
    const events = onSpy.mock.calls.map((call) => call[0])
    expect(events).not.toContain('fs/observed')
    expect(events).not.toContain('tools/post-execute')
    expect(effectSpy).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(vi.mocked(createMutationCollector).mock.calls.length).toBe(before.collector)
    expect(vi.mocked(DiagnosticsRuntime).mock.calls.length).toBe(before.runtime)
    expect(vi.mocked(createDiagnosticsCoordinator).mock.calls.length).toBe(before.coordinator)
  })

  it('apply(enabled=false) returns without touching a bare context', () => {
    const ctx = {
      on: vi.fn(),
      effect: vi.fn(),
      subprocess: { spawn: vi.fn() },
    }
    apply(ctx as unknown as Parameters<typeof apply>[0], { ...DEFAULT_CONFIG, enabled: false })
    expect(ctx.on).not.toHaveBeenCalled()
    expect(ctx.effect).not.toHaveBeenCalled()
    expect(ctx.subprocess.spawn).not.toHaveBeenCalled()
  })
})

describe('dsh-lsp-diagnostics Todo 5 assembly', () => {
  it('enabled=true registers fs/observed + tools/post-execute and exactly one cleanup effect', async () => {
    const ctx = new Context()
    const onEvents: string[] = []
    const effectLabels: string[] = []
    await ctx.provide('fs', {})
    await ctx.provide('subprocess', {})
    await ctx.provide('tools', {})
    const onSpy = vi.spyOn(ctx, 'on').mockImplementation(((name: never, listener: never, options?: never) => {
      onEvents.push(String(name))
      return ctx.events.on(name, listener, options)
    }) as never)
    const effectSpy = vi.spyOn(ctx, 'effect').mockImplementation(((execute: never, label?: never) => {
      effectLabels.push(String(label))
      return ctx.fiber.effect(execute, label)
    }) as never)
    await ctx.plugin(await import('../index.js'), DEFAULT_CONFIG)
    expect(onEvents).toEqual(['fs/observed', 'tools/post-execute'])
    expect(effectLabels).toHaveLength(1)
    expect(effectLabels[0]).toBe('dsh-lsp-diagnostics listeners, operations, retired I/O, and runtime teardown')
  })

  it('waits a listener already entered but still blocked in downstream next before cleanup resolves', async () => {
    const ctx = new Context()
    await ctx.provide('fs', {})
    await ctx.provide('subprocess', {})
    await ctx.provide('tools', {})
    const fiber = await ctx.plugin(await import('../index.js'), DEFAULT_CONFIG)
    let releaseNext!: () => void
    const nextGate = new Promise<void>((resolve) => { releaseNext = resolve })
    const exec = {
      name: 'write',
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: '/ws' } } },
    }
    const listener = (ctx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<unknown>)(
      'tools/post-execute',
      exec,
      {},
      async () => {
        await nextGate
        return { kind: 'accept' }
      },
    )
    let disposed = false
    const cleanup = fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseNext()
    await listener
    await cleanup
    expect(disposed).toBe(true)
  })

  it('tears down in the exact plan order and awaits both quiescence barriers', async () => {
    const ctx = new Context()
    const order: string[] = []
    await ctx.provide('fs', {})
    await ctx.provide('subprocess', {})
    await ctx.provide('tools', {})
    vi.spyOn(ctx, 'on').mockImplementation(((name: never, listener: never, options?: never) => {
      order.push(`on:${String(name)}`)
      const dispose = ctx.events.on(name, listener, options)
      return () => {
        order.push(`off:${String(name)}`)
        return dispose()
      }
    }) as never)
    vi.spyOn(DiagnosticsRuntime.prototype, 'stopAdmission').mockImplementation(function (this: DiagnosticsRuntime) {
      order.push('runtime.stopAdmission')
      this.admissionOpen = false
    })
    vi.spyOn(DiagnosticsRuntime.prototype, 'dispose').mockImplementation(function () {
      order.push('runtime.dispose')
      return Promise.resolve()
    })
    const coordinatorMock = createDiagnosticsCoordinator as unknown as {
      __calls: string[]
      __instances: Array<Record<string, (...args: unknown[]) => unknown>>
    }
    coordinatorMock.__calls.length = 0
    const fiber = await ctx.plugin(await import('../index.js'), DEFAULT_CONFIG)
    const coordinator = coordinatorMock.__instances.at(-1)!
    let releaseActive!: () => void
    let releaseRetired!: () => void
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
    const retiredGate = new Promise<void>((resolve) => { releaseRetired = resolve })
    coordinator.awaitActiveOperations = vi.fn(async () => {
      coordinatorMock.__calls.push('awaitActiveOperations')
      order.push('awaitActive:start')
      await activeGate
      order.push('awaitActive:end')
    })
    coordinator.awaitRetiredIo = vi.fn(async () => {
      coordinatorMock.__calls.push('awaitRetiredIo')
      order.push('awaitRetired:start')
      await retiredGate
      order.push('awaitRetired:end')
    })

    const disposing = fiber.dispose()
    await vi.waitFor(() => expect(order).toContain('awaitActive:start'))
    expect(order).not.toContain('awaitRetired:start')
    expect(order).not.toContain('runtime.dispose')
    releaseActive()
    await vi.waitFor(() => expect(order).toContain('awaitRetired:start'))
    expect(order).not.toContain('runtime.dispose')
    releaseRetired()
    await disposing

    expect(order).toEqual([
      'on:fs/observed',
      'on:tools/post-execute',
      'runtime.stopAdmission',
      'off:tools/post-execute',
      'off:fs/observed',
      'awaitActive:start',
      'awaitActive:end',
      'awaitRetired:start',
      'awaitRetired:end',
      'runtime.dispose',
    ])
    expect(coordinatorMock.__calls).toEqual([
      'stopAdmission',
      'abortActiveOperations',
      'awaitActiveOperations',
      'awaitRetiredIo',
    ])
  })
})
