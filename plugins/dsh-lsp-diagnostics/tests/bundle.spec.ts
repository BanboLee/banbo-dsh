import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../index.js'
import { DEFAULT_CONFIG } from './helpers.js'

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

  it('rejects non-boolean enabled', () => {
    for (const enabled of [0, 1, 'false', [], {}]) {
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
    for (const bad of [cyclic, { a: undefined }, { a: () => 1 }, { a: 1n }, { a: Number.NaN }, { a: Number.POSITIVE_INFINITY }, { a: Symbol('x') }]) {
      const servers = mutableServers()
      servers.typescript.configuration = bad
      expect(() => validated({ servers }), `configuration ${String(bad)}`).toThrow()
      servers.typescript.configuration = DEFAULT_CONFIG.servers.typescript.configuration
      servers.typescript.initializationOptions = bad
      expect(() => validated({ servers }), `initializationOptions ${String(bad)}`).toThrow()
    }
  })

  it('accepts valid nested JSON configuration and initializationOptions', () => {
    const servers = mutableServers()
    servers.typescript.configuration = { nested: { list: [1, 'two', null, true] } }
    servers.go.initializationOptions = { deep: { value: 3.5 } }
    expect(validated({ servers })).toMatchObject({
      servers: {
        typescript: { configuration: { nested: { list: [1, 'two', null, true] } } },
        go: { initializationOptions: { deep: { value: 3.5 } } },
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
    await ctx.plugin(await import('../index.js'), { enabled: false } as unknown as Parameters<typeof apply>[1])
    const events = onSpy.mock.calls.map((call) => call[0])
    expect(events).not.toContain('fs/observed')
    expect(events).not.toContain('tools/post-execute')
    expect(effectSpy).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
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
