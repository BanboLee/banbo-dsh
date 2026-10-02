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
 *   - the fallback (`resolveDshHome()` + `ctx.get('profileContext')`) is used
 *     ONLY when the `shellEnv` service is not mounted. Once it is, that
 *     registry is the ONLY source — exactly the facts it declares, with no
 *     per-key borrowing from the ambient env or the profile context — and a
 *     `collect` error PROPAGATES (the one-shot path collects fail-loud too, and
 *     a swallowed error would quietly spawn on the ambient `DSH_HOME`);
 *   - the injection happens through the official constructor's `spawnTerminal`
 *     seam and lands in `spec.env` — the layer the subprocess provider applies
 *     after `scrubbedParentEnv()`. The end-to-end case drives the inherited
 *     `spawn()` itself, so it also proves nothing else was overridden: the
 *     configured argv reaches the provider unchanged, `terminalType` stays
 *     `dumb`, no confinement runs under `danger-full-access`, and the session
 *     factory receives the resolved official config;
 *   - the config surface and the inject list ARE the official ones — the same
 *     schema object, the same inject list, and the same EFFECTIVE config: the
 *     parity block below drives the official `apply` and this one with the same
 *     inputs and compares the registered config byte for byte, plus the
 *     validation outcome (error text included) for invalid inputs.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply as officialApply,
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
  readonly config: {
    readonly backendType: string
    readonly rows: number
    readonly shellPath: string
    readonly shellArgs: readonly string[]
  }
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
      // This is the ONLY case the public-facts fallback exists for.
      expect(harnessHomeEnvironment(ctx)).toEqual({
        DSH_HOME: '/stub-home',
        DSH_PROFILE: 'fallback-profile',
        DSH_PROFILE_DIR: '/fallback-profile-dir',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is the only source when mounted: keys its snapshot omits are NOT borrowed', () => {
    const ctx = new Context()
    // A registry declaring only the home, a `profileContext` that COULD supply
    // the missing pair, and an ambient home that COULD supply the rest: none of
    // them may leak in, because the mounted registry is the only source.
    ctx.provide('shellEnv', registry(() => ({ DSH_HOME: '/registry-home' })) as never)
    ctx.provide('profileContext', { name: 'context-profile', dir: '/context-profile-dir' } as never)
    vi.stubEnv('DSH_HOME', '/ambient-home')
    try {
      expect(harnessHomeEnvironment(ctx)).toEqual({ DSH_HOME: '/registry-home' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is the only source when mounted: an empty snapshot exports nothing, not the ambient home', () => {
    const ctx = new Context()
    // The official registry ALWAYS declares DSH_HOME (its constructor resolves
    // one), so an empty snapshot means a foreign implementation; its silence is
    // respected instead of being filled in from another source.
    ctx.provide('shellEnv', registry(() => ({})) as never)
    ctx.provide('profileContext', { name: 'context-profile', dir: '/context-profile-dir' } as never)
    vi.stubEnv('DSH_HOME', '/ambient-home')
    try {
      expect(harnessHomeEnvironment(ctx)).toEqual({})
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('propagates a collect error instead of resolving another home (fail loud, like the one-shot path)', () => {
    const ctx = new Context()
    ctx.provide('shellEnv', {
      collect: () => {
        throw new Error('contributor needs a full tool execution')
      },
    } as never)
    ctx.provide('profileContext', { name: 'fallback-profile', dir: '/fallback-profile-dir' } as never)
    // An ambient home that differs from the registry's would be exactly the
    // drift a swallowed error would reintroduce.
    vi.stubEnv('DSH_HOME', '/ambient-wrong')
    try {
      expect(() => harnessHomeEnvironment(ctx)).toThrow('contributor needs a full tool execution')
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
 * @param {{ collect?: () => Record<string, string> }} [options] - override the mounted registry's `collect`.
 */
function mountBackend(options: { collect?: () => Record<string, string> } = {}): BackendHarness {
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
  const defaultCollect = () => ({ DSH_HOME: '/registry-home', DSH_PROFILE: 'p', DSH_PROFILE_DIR: '/p' })
  ctx.provide('shellEnv', registry(options.collect ?? defaultCollect) as never)
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

  it('fails the spawn when the mounted registry throws (never a silent ambient home)', async () => {
    const harness = mountBackend({
      collect: () => {
        throw new Error('collect boom')
      },
    })
    vi.stubEnv('DSH_HOME', '/ambient-wrong')
    try {
      await expect(harness.backend.spawn(ownerSpec(harness.ctx) as never)).rejects.toThrow('collect boom')
      // The throw happens inside the `spawnTerminal` seam, before any PTY is
      // allocated: nothing to clean up, and no session on the wrong home.
      expect(harness.spawned).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
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

  it('materializes the official dialect defaults for an empty config (never undefined/[])', () => {
    const ctx = new Context()
    const registered: unknown[] = []
    ctx.provide('terminals', { registerBackend: (backend: unknown) => registered.push(backend) } as never)

    apply(ctx, {})

    const internals = registered[0] as BackendInternals
    expect(internals.config.shellPath).toBe('/bin/bash')
    expect(internals.config.shellArgs).toEqual(['--noprofile', '--norc', '-i'])
  })

  it('rejects an invalid duration exactly as the official backend does', () => {
    const ctx = new Context()
    ctx.provide('terminals', { registerBackend: () => {} } as never)

    // The reviewer-visible case: without the validation step this row used to
    // register successfully with `timeoutMs: 0`.
    expect(() => apply(ctx, { timeoutMs: 0 })).toThrow('terminal-bash: timeoutMs must be a positive safe integer')
  })
})

/**
 * Parity with the official `apply`. The official package exports no
 * `resolveConfig`/`validateConfig`, so the official side is driven through its
 * own public `apply` with a throwaway `terminals` registry that records the
 * backend it registers — from there the effective config is read directly.
 * Both sides therefore take the same path the loader takes, and any upstream
 * drift (defaults, validation order, error text) turns these cases red.
 *
 * The loader step is explicit in the harness: cordis resolves the plugin's
 * exported `Config` schema BEFORE calling `apply`, and the official `apply`
 * depends on that (`resolveConfig` does not materialize `backendType`; a raw
 * `{}` reaches its validator with `backendType: undefined`). Feeding both
 * `apply`s `Config(input)` compares them at their real entry point.
 */
const PARITY_CONFIGS = [
  ['the schema defaults', {}],
  ['an empty shellPath and shellArgs (dialect defaults, not empty strings)', { shellPath: '', shellArgs: [] }],
  ['the bundle patch row config', { shellPath: 'fish', shellArgs: ['--no-config', '-i', '-C', 'setup'], timeoutMs: 300000 }],
  ['a pwsh dialect', { shellDialect: 'pwsh' }],
  ['a backendType override', { backendType: 'fish', shellPath: 'fish' }],
] as const

const INVALID_CONFIGS = [
  ['a zero duration', { timeoutMs: 0 }],
  ['an empty backendType', { backendType: '' }],
  ['a negative tail grace', { promptTailGraceMs: -1 }],
  ['maxReadBytes above scrollbackMaxBytes', { maxReadBytes: 1024, scrollbackMaxBytes: 512 }],
  ['a handoff grace below one poll', { handoffGraceMs: 10, pollIntervalMs: 50 }],
] as const

interface CapturedBackend {
  readonly type: string
  readonly config: unknown
}

/** The backend the OFFICIAL `apply` registers for the loader-resolved `config`. */
function officialApplyCapture(config: unknown): CapturedBackend {
  const registered: CapturedBackend[] = []
  const ctx = { terminals: { registerBackend: (backend: CapturedBackend) => registered.push(backend) } }
  officialApply(ctx as never, Config(config as never) as never)
  const backend = registered[0]
  if (backend === undefined) throw new Error('the official apply registered no backend')
  return backend
}

/** The backend THIS module's `apply` registers for the loader-resolved `config`. */
function ourApplyCapture(config: unknown): CapturedBackend {
  const ctx = new Context()
  const registered: CapturedBackend[] = []
  ctx.provide('terminals', { registerBackend: (backend: unknown) => registered.push(backend as CapturedBackend) } as never)
  apply(ctx, Config(config as never) as never)
  const backend = registered[0]
  if (backend === undefined) throw new Error('terminal.js apply registered no backend')
  return backend
}

/** The thrown message, or `undefined` when `run` did not throw. */
function captureError(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('terminal.js is in config parity with the official apply', () => {
  it.each(PARITY_CONFIGS)('registers a byte-identical effective config for %s', (_label, input) => {
    const official = officialApplyCapture(input)
    const ours = ourApplyCapture(input)
    expect(ours.type).toBe(official.type)
    expect(ours.config).toEqual(official.config)
  })

  it.each(INVALID_CONFIGS)('fails %s exactly as the official validator fails it', (_label, input) => {
    const officialError = captureError(() => officialApplyCapture(input))
    const ourError = captureError(() => ourApplyCapture(input))
    // Guard the fixture itself: a case the OFFICIAL apply accepts would make
    // the parity claim vacuous.
    expect(officialError, 'the fixture must be invalid for the official apply too').not.toBeUndefined()
    expect(ourError).toBe(officialError)
  })
})
