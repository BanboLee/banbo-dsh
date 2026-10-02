/**
 * Deterministic tests for the L2 interactive backend (`terminal.js`): the
 * official `BashTerminalBackend` plus the harness home contract in the PTY
 * child environment.
 *
 * What has to hold, and why each assertion exists:
 *
 *   - the home facts come from the SAME registry the one-shot shell tools read
 *     (`ctx.shellEnv.collect()`), so the two surfaces cannot drift — asserted by
 *     making the registry and the fallback sources disagree and demanding the
 *     registry's values;
 *   - the fallback (`resolveDshHome()` + `ctx.get('profileContext')`) is only
 *     reached when the registry is unavailable or a contributor throws on the
 *     spawn-time partial execution, and it never fails a spawn;
 *   - the injection happens through the official constructor's `spawnTerminal`
 *     seam and lands in `spec.env` — the layer the subprocess provider applies
 *     after `scrubbedParentEnv()`. The end-to-end case drives the inherited
 *     `spawn()` itself, so it also proves nothing else was overridden: the
 *     configured argv reaches the provider unchanged, `terminalType` stays
 *     `dumb`, no confinement runs under `danger-full-access`, and the session
 *     factory receives the resolved official config;
 *   - the config surface and the inject list ARE the official ones, so the row
 *     keeps the official defaults (`backendType: 'shell'`) and activation
 *     semantics.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  BashTerminalBackend,
  Config as OfficialConfig,
  inject as officialInject,
} from '@deepseek-ai/dsh-terminal-bash'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  HarnessHomeTerminalBackend,
  apply,
  Config,
  harnessHomeEnvironment,
  inject,
  withHarnessHome,
} from '../terminal.js'

/** The base class's resolved config shape, as the backend stores it. */
interface BackendInternals {
  readonly type: string
  readonly config: { readonly backendType: string, readonly rows: number, readonly shellPath: string }
}

/** A `ctx.shellEnv` double whose `collect` returns exactly `snapshot`. */
function registry(snapshot: () => Record<string, string>) {
  return { collect: vi.fn(snapshot) }
}

describe('harnessHomeEnvironment — the one-shot registry is the source of truth', () => {
  it('takes DSH_HOME and the profile facts from ctx.shellEnv.collect()', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', registry(() => ({
      DSH_HOME: '/registry-home',
      DSH_SHELL: '1',
      DSH_PROFILE: 'registry-profile',
      DSH_PROFILE_DIR: '/registry-profile-dir',
    })) as never)
    // Deliberately different values: a fallback leak would pick these up.
    ctx.provide('profileContext', { name: 'context-profile', dir: '/context-profile-dir' } as never)

    expect(harnessHomeEnvironment(ctx)).toEqual({
      DSH_HOME: '/registry-home',
      DSH_PROFILE: 'registry-profile',
      DSH_PROFILE_DIR: '/registry-profile-dir',
    })
  })

  it('forwards no session facts: DSH_SHELL/DSH_SESSION_ID stay the PTY overlay own values', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', registry(() => ({
      DSH_HOME: '/registry-home',
      DSH_SHELL: '1',
      DSH_SESSION_ID: 'one-shot-session',
    })) as never)

    // The official overlay sets these itself (owner id / PTY session id); the
    // home contract must not overwrite them with a one-shot execution's.
    expect(Object.keys(harnessHomeEnvironment(ctx)).sort()).toEqual(['DSH_HOME'])
  })

  it('omits the profile facts when neither the registry nor the context can name them', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', registry(() => ({ DSH_HOME: '/registry-home' })) as never)

    expect(harnessHomeEnvironment(ctx)).toEqual({ DSH_HOME: '/registry-home' })
  })
})

describe('harnessHomeEnvironment — the public-facts fallback', () => {
  it('resolves DSH_HOME through dsh-home-paths and the profile through profileContext', () => {
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'fallback-profile', dir: '/fallback-profile-dir' } as never)
    vi.stubEnv('DSH_HOME', '/stub-home')
    try {
      // No `shellEnv` service at all: a custom composition outside dsh-base.
      expect(harnessHomeEnvironment(ctx)).toEqual({
        DSH_HOME: '/stub-home',
        DSH_PROFILE: 'fallback-profile',
        DSH_PROFILE_DIR: '/fallback-profile-dir',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('falls back for the keys a registry snapshot does not carry', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', registry(() => ({})) as never)
    ctx.provide('profileContext', { name: 'fallback-profile', dir: '/fallback-profile-dir' } as never)
    vi.stubEnv('DSH_HOME', '/stub-home')
    try {
      expect(harnessHomeEnvironment(ctx)).toEqual({
        DSH_HOME: '/stub-home',
        DSH_PROFILE: 'fallback-profile',
        DSH_PROFILE_DIR: '/fallback-profile-dir',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('survives a contributor that throws on the spawn-time partial execution', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', {
      collect: () => {
        throw new Error('contributor needs a full tool execution')
      },
    } as never)
    ctx.provide('profileContext', { name: 'fallback-profile', dir: '/fallback-profile-dir' } as never)
    vi.stubEnv('DSH_HOME', '/stub-home')
    try {
      // A third-party contributor must not be able to take every PTY spawn
      // down: the home facts do not depend on its contribution.
      expect(harnessHomeEnvironment(ctx)).toEqual({
        DSH_HOME: '/stub-home',
        DSH_PROFILE: 'fallback-profile',
        DSH_PROFILE_DIR: '/fallback-profile-dir',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('calls collect with an empty execution (the home facts do not read it)', () => {
    const ctx = new Context()
    const shellEnv = registry(() => ({ DSH_HOME: '/registry-home' }))
    ctx.provide('shellEnv', shellEnv as never)

    harnessHomeEnvironment(ctx)

    expect(shellEnv.collect).toHaveBeenCalledWith({})
  })
})

describe('withHarnessHome — one spec, one extra env layer', () => {
  it('keeps the base overlay and the rest of the spec, and merges the home facts last', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', registry(() => ({ DSH_HOME: '/registry-home' })) as never)
    const spec: SubprocessTerminalSpawnSpec = {
      argv: ['fish', '--no-config', '-i'],
      cwd: '/ws',
      env: { TERM: 'dumb', PAGER: 'cat', DSH_HOME: '/stale-inherited' },
      rows: 40,
      cols: 160,
      terminalType: 'dumb',
      graceMs: 3000,
    }

    const merged = withHarnessHome(spec, ctx)

    expect(merged.env).toEqual({ TERM: 'dumb', PAGER: 'cat', DSH_HOME: '/registry-home' })
    expect(merged.argv).toEqual(spec.argv)
    expect(merged.terminalType).toBe('dumb')
    // The original spec is not mutated.
    expect(spec.env?.['DSH_HOME']).toBe('/stale-inherited')
  })
})

interface BackendHarness {
  readonly ctx: Context
  readonly spawned: SubprocessTerminalSpawnSpec[]
  readonly initializations: number[]
  readonly session: { initialize: (signal?: AbortSignal) => Promise<void>, close: ReturnType<typeof vi.fn>, pid: number }
  readonly backend: HarnessHomeTerminalBackend
}

/**
 * Mount the backend the way the bundle patch does, with the official seams
 * doubled: `ctx.subprocess.spawnTerminal` (our injection point) and the session
 * factory. Everything else the inherited `spawn()` needs is provided as the
 * minimal service double the official fence/argv path reads.
 */
function mountBackend(): BackendHarness {
  const ctx = new Context()
  const spawned: SubprocessTerminalSpawnSpec[] = []
  const initializations: number[] = []
  const terminate = vi.fn()
  const session = {
    pid: 4242,
    initialize: vi.fn(async () => {
      initializations.push(1)
    }),
    close: vi.fn(async () => {}),
  }
  ctx.provide('shellEnv', registry(() => ({ DSH_HOME: '/registry-home', DSH_PROFILE: 'p', DSH_PROFILE_DIR: '/p' })) as never)
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/ws' }) } as never)
  ctx.provide('sandbox', { confine: vi.fn() } as never)
  ctx.provide('terminals', { hasOwnerActivity: () => false } as never)
  ctx.provide('sessionProjections', { stateOf: () => undefined } as never)
  ctx.provide('subprocess', {
    spawnTerminal: vi.fn(async (spec: SubprocessTerminalSpawnSpec) => {
      spawned.push(spec)
      return { terminate } as unknown as SubprocessTerminalHandle
    }),
  } as never)
  const backend = new HarnessHomeTerminalBackend(
    ctx,
    // The schema's output IS the resolved config (schemastery materializes
    // every default); the published type for the ctor is the official
    // `ResolvedConfig`, which `@deepseek-ai/dsh-terminal-bash` does not export.
    (Config({ shellPath: 'fish', shellArgs: ['--no-config', '-i', '-C', 'setup'], timeoutMs: 1000 }) as unknown as ConstructorParameters<typeof BashTerminalBackend>[1]),
    (() => session) as unknown as NonNullable<ConstructorParameters<typeof HarnessHomeTerminalBackend>[2]>,
  )
  return { ctx, spawned, initializations, session, backend }
}

function ownerSpec(ctx: Context) {
  return {
    owner: { id: 'pty-owner', ctx, session: { header: { cwd: '/ws' } } },
    sessionId: 'pty-session-1',
    signal: new AbortController().signal,
  }
}

describe('HarnessHomeTerminalBackend over the inherited official spawn()', () => {
  it('spawns the configured fish argv and adds the home contract to the child environment', async () => {
    const harness = mountBackend()

    const session = await harness.backend.spawn(ownerSpec(harness.ctx) as never)

    expect(session).toBe(harness.session)
    // No spawn() override: the configured argv reaches the provider unchanged.
    expect(harness.spawned[0]?.argv).toEqual(['fish', '--no-config', '-i', '-C', 'setup'])
    expect(harness.spawned[0]?.terminalType).toBe('dumb')
    expect(harness.spawned[0]?.cwd).toBe('/ws')
    // Full access needs no confinement call, exactly like the official backend.
    expect(harness.ctx.get('sandbox')?.confine).not.toHaveBeenCalled()
    // The base overlay is intact AND the home contract is layered on top. The
    // bash-dialect keys (`PS1`, `PROMPT_COMMAND`,
    // `BASH_SILENCE_DEPRECATION_WARNING`) are the official overlay verbatim —
    // inert under fish, whose prompt comes from the `-C` setup — and are
    // asserted precisely because they prove the overlay is the official one,
    // not a re-implementation.
    expect(harness.spawned[0]?.env).toEqual({
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      DSH_SHELL: '1',
      DSH_SESSION_ID: 'pty-owner',
      DSH_PTY_SESSION_ID: 'pty-session-1',
      PS1: 'dsh> ',
      PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"; PS1=\'dsh> \'',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      DSH_HOME: '/registry-home',
      DSH_PROFILE: 'p',
      DSH_PROFILE_DIR: '/p',
    })
    // Readiness is the inherited `session.initialize()` path (the `-C` prompt
    // setup argv is the whole startup), never a submitted setup line.
    expect(harness.initializations).toHaveLength(1)
  })

  it('hands the session factory the resolved official config (backendType shell, defaults materialized)', async () => {
    const harness = mountBackend()

    await harness.backend.spawn(ownerSpec(harness.ctx) as never)

    const internals = harness.backend as unknown as BackendInternals
    expect(internals.type).toBe('shell')
    expect(internals.config.backendType).toBe('shell')
    expect(internals.config.shellPath).toBe('fish')
    expect(internals.config.rows).toBe(40)
  })
})

describe('terminal.js config surface and activation', () => {
  it('re-exports the OFFICIAL Config schema object, not a copy', () => {
    expect(Config).toBe(OfficialConfig)
    // The official default the real lane asserts through listBackends().
    expect(Config({}).backendType).toBe('shell')
  })

  it('declares the official inject list verbatim', () => {
    expect(inject).toEqual(officialInject)
  })

  it('registers the home-carrying backend on apply, with cordis-resolved defaults', () => {
    const ctx = new Context()
    const registered: unknown[] = []
    ctx.provide('terminals', { registerBackend: (backend: unknown) => registered.push(backend) } as never)

    // A row config exactly like the patch's: no `backendType`, no `env`.
    apply(ctx, { shellPath: 'fish', shellArgs: ['--no-config', '-i', '-C', 'setup'], timeoutMs: 300000 })

    expect(registered).toHaveLength(1)
    expect(registered[0]).toBeInstanceOf(HarnessHomeTerminalBackend)
    expect(registered[0]).toBeInstanceOf(BashTerminalBackend)
    const internals = registered[0] as BackendInternals
    expect(internals.type).toBe('shell')
    expect(internals.config.rows).toBe(40)
  })
})
