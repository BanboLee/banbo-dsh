import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMutationCollector } from '../collector.js'
import { createDiagnosticsCoordinator } from '../coordinator.js'
import { compareEligibleTargets, renderDiagnostics } from '../render.js'
import { DiagnosticsRuntime } from '../runtime.js'
import { DEFAULT_CONFIG } from './helpers.js'

// ---------------------------------------------------------------------------
// Todo 5 coordinator tests. The coordinator is the post-execute augment
// transaction owner: real three-parameter `tools/post-execute` waterfall
// wiring, eligibility (extension + canonical workspace + contains), the
// one-shot final stat/deadline/generation gate, the active augment registry
// and the `retiredIo` late-final-stat registry, the single aggregate context,
// and the strict stop-admission/abort/await cleanup ownership.
//
// The runtime is a controllable fake (no subprocesses); the collector and the
// renderer are the real implementations. The waterfall is driven through a
// real Cordis `ctx.waterfall` chain registered with `ctx.on`.
// ---------------------------------------------------------------------------

interface FakeTarget {
  readonly targetKey: string
  readonly displayPath: string
}

interface FakeExec {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: { readonly session: { readonly header: { readonly cwd?: string } } }
  readonly signal: AbortSignal
}

interface FakeFs {
  readonly resolve: ReturnType<typeof vi.fn>
  readonly stat: ReturnType<typeof vi.fn>
  readonly contains: ReturnType<typeof vi.fn>
  readonly fileUrl: ReturnType<typeof vi.fn>
  readonly processPath: ReturnType<typeof vi.fn>
  readonly readBytes: ReturnType<typeof vi.fn>
}

interface FakeRuntime {
  readonly diagnose: ReturnType<typeof vi.fn>
  readonly stopAdmission: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
}

type Outcome =
  | { readonly kind: 'ok'; readonly diagnostics: readonly unknown[]; readonly uri: string; readonly version: number }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unavailable'; readonly reason: string }

interface Harness {
  readonly ctx: Context
  readonly collector: ReturnType<typeof createMutationCollector>
  readonly runtime: FakeRuntime
  readonly fs: FakeFs
  readonly coordinator: ReturnType<typeof createDiagnosticsCoordinator>
  readonly config: typeof DEFAULT_CONFIG
  readonly workspaceTarget: FakeTarget
  /** Mutable monotonic clock fed to the coordinator's injected `now`. */
  readonly clock: { value: number }
}

function makeTarget(displayPath: string, targetKey = displayPath): FakeTarget {
  return { displayPath, targetKey }
}

function makeExec(cwd = '/ws', signal = new AbortController().signal): FakeExec {
  return {
    name: 'write',
    signal,
    agent: { session: { header: { cwd } } },
  }
}

function abortError(signal: AbortSignal): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  error.cause = signal.reason
  return error
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function trackAbortListeners(): { readonly count: () => number; readonly restore: () => void } {
  const originalAdd = AbortSignal.prototype.addEventListener
  const originalRemove = AbortSignal.prototype.removeEventListener
  const listeners = new Map<AbortSignal, Set<unknown>>()
  const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (
    this: AbortSignal,
    type: string,
    listener: any,
    options?: any,
  ) {
    if (type === 'abort') {
      let owned = listeners.get(this)
      if (owned === undefined) {
        owned = new Set()
        listeners.set(this, owned)
      }
      owned.add(listener)
    }
    return (originalAdd as any).call(this, type, listener, options)
  })
  const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener').mockImplementation(function (
    this: AbortSignal,
    type: string,
    listener: any,
    options?: any,
  ) {
    if (type === 'abort') listeners.get(this)?.delete(listener)
    return (originalRemove as any).call(this, type, listener, options)
  })
  return {
    count: () => [...listeners.values()].reduce((total, owned) => total + owned.size, 0),
    restore: () => {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    },
  }
}

function makeFs(): FakeFs {
  return {
    resolve: vi.fn(async (path: string) => ({ targetKey: `ws:${path}`, displayPath: path })),
    stat: vi.fn(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return { version: 'v1', type: 'file', size: 32 }
    }),
    contains: vi.fn(() => true),
    fileUrl: vi.fn((target: FakeTarget) => `file:///ws/${target.displayPath}`),
    processPath: vi.fn((target: FakeTarget) => target.displayPath),
    readBytes: vi.fn(async () => new Uint8Array()),
  }
}

function makeRuntime(): FakeRuntime {
  return {
    diagnose: vi.fn(async (
      _candidate: unknown,
      _workspace: unknown,
      _canonicalUri: string,
      signal: AbortSignal | undefined,
    ): Promise<Outcome> => {
      if (signal !== undefined && signal.aborted) return { kind: 'stale' }
      return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
    }),
    stopAdmission: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
}

function makeHarness(
  cwd = '/ws',
  now?: () => number,
  overrides: Record<string, unknown> = {},
): Harness {
  const ctx = new Context()
  const collector = createMutationCollector()
  const runtime = makeRuntime()
  const fs = makeFs()
  const clock = { value: 0 }
  const config = { ...DEFAULT_CONFIG, ...overrides } as Harness['config']
  const coordinator = createDiagnosticsCoordinator({
    collector,
    runtime,
    config,
    fs,
    now: now ?? (() => clock.value),
  })
  ;(ctx.on as unknown as (name: string, listener: unknown) => unknown)('tools/post-execute', coordinator.listener)
  return {
    ctx,
    collector,
    runtime,
    fs,
    coordinator,
    config,
    workspaceTarget: { targetKey: `ws:${cwd}`, displayPath: cwd },
    clock,
  }
}

// ---------------------------------------------------------------------------
// Composed harness: the REAL DiagnosticsRuntime (controllable fs/subprocess
// seams, no subprocesses) wired to the real collector and coordinator through
// a real Cordis context. Used by the unload stage matrix so the runtime-side
// phases (target stat, target read, admission/queue) are exercised under the
// plugin cleanup order, never faked with hand-sent fs/observed events.
// ---------------------------------------------------------------------------

interface ComposedSubprocess {
  readonly resolveExecutable: ReturnType<typeof vi.fn>
  readonly spawn: ReturnType<typeof vi.fn>
}

interface ComposedHarness {
  readonly ctx: Context
  readonly collector: ReturnType<typeof createMutationCollector>
  readonly runtime: DiagnosticsRuntime
  readonly coordinator: ReturnType<typeof createDiagnosticsCoordinator>
  readonly fs: FakeFs
  readonly subprocess: ComposedSubprocess
  readonly config: typeof DEFAULT_CONFIG
  readonly offPost: () => boolean
  readonly offObserved: () => boolean
}

function makeComposedFs(): FakeFs {
  return {
    resolve: vi.fn(async (path: string) => ({ targetKey: `ws:${path}`, displayPath: path })),
    stat: vi.fn(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return { version: 'v1', type: 'file', size: 32 }
    }),
    contains: vi.fn(() => true),
    fileUrl: vi.fn((target: FakeTarget) => `file:///ws/${target.displayPath}`),
    processPath: vi.fn((target: FakeTarget) => target.displayPath),
    readBytes: vi.fn(async () => new Uint8Array()),
  }
}

function makeComposedHarness(): ComposedHarness {
  const ctx = new Context()
  const collector = createMutationCollector()
  const fs = makeComposedFs()
  const subprocess: ComposedSubprocess = {
    resolveExecutable: vi.fn(async (command: string) => command),
    spawn: vi.fn(() => {
      throw new Error('unexpected spawn during unload matrix')
    }),
  }
  const config = { ...DEFAULT_CONFIG, settleMs: 20, timeoutMs: 5000 } as unknown as Harness['config']
  const runtime = new DiagnosticsRuntime({ fs, subprocess, config })
  const coordinator = createDiagnosticsCoordinator({ collector, runtime, config, fs })
  const offPost = (ctx.on as unknown as (name: string, listener: unknown) => () => boolean)(
    'tools/post-execute',
    coordinator.listener,
  )
  const offObserved = (ctx.on as unknown as (name: string, listener: unknown) => () => boolean)(
    'fs/observed',
    (target: unknown, observation: unknown, actor: unknown) => {
      collector.observe(actor, target, observation)
    },
  )
  return { ctx, collector, runtime, coordinator, fs, subprocess, config, offPost, offObserved }
}

/**
 * The plugin cleanup order, executed against the composed harness exactly as
 * `index.js` apply's single cleanup effect runs it: stop admission, dispose
 * both listeners, abort operations, await active augment promises, await
 * retired late-final-stat I/O, and only then dispose the runtime. Every stage
 * records its name so each matrix phase can assert the full sequence.
 * @param {ComposedHarness} harness - the composed harness.
 * @param {string[]} order - shared order recorder.
 */
async function unloadComposed(harness: ComposedHarness, order: string[]): Promise<void> {
  order.push('stopAdmission')
  harness.coordinator.stopAdmission()
  order.push('offPost')
  await Promise.resolve(harness.offPost())
  order.push('offObserved')
  await Promise.resolve(harness.offObserved())
  order.push('abortActiveOperations')
  harness.coordinator.abortActiveOperations()
  order.push('awaitActiveOperations')
  await harness.coordinator.awaitActiveOperations()
  order.push('awaitRetiredIo')
  await harness.coordinator.awaitRetiredIo()
  order.push('runtime.dispose')
  await harness.runtime.dispose()
}

const CLEANUP_ORDER = [
  'stopAdmission',
  'offPost',
  'offObserved',
  'abortActiveOperations',
  'awaitActiveOperations',
  'awaitRetiredIo',
  'runtime.dispose',
] as const

function drive(
  harness: Harness | ComposedHarness,
  exec: FakeExec,
  result: unknown,
  terminalNext: () => Promise<unknown>,
): Promise<unknown> {
  return (harness.ctx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<unknown>)(
    'tools/post-execute',
    exec,
    result,
    terminalNext,
  )
}

function observe(harness: Harness, exec: FakeExec, target: FakeTarget, version = 'v1'): void {
  harness.collector.observe(exec, target, { kind: 'present', version })
}

function acceptNext(): () => Promise<unknown> {
  return async () => ({ kind: 'accept' })
}

function noticeOf(decision: unknown): { readonly source: unknown; readonly content: readonly { readonly text: string }[] } | undefined {
  if (typeof decision !== 'object' || decision === null) return undefined
  const contexts = (decision as { additionalContexts?: readonly unknown[] }).additionalContexts
  if (contexts === undefined || contexts.length === 0) return undefined
  const last = contexts[contexts.length - 1]
  if (typeof last !== 'object' || last === null) return undefined
  return last as { readonly source: unknown; readonly content: readonly { readonly text: string }[] }
}

function fileLinesOf(text: string): readonly string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('File: '))
    .map((line) => line.slice('File: '.length))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('@banbolee/dsh-lsp-diagnostics coordinator waterfall contract', () => {
  it('registers a real three-parameter listener that preserves _result identity and calls next exactly once', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const result = { isError: false, content: [{ type: 'text', text: 'ok' }] }
    const calls: string[] = []
    const seen: unknown[] = []
    ;(harness.ctx.on as unknown as (name: string, listener: unknown) => unknown)(
      'tools/post-execute',
      async (e: unknown, r: unknown, next: () => Promise<unknown>) => {
        calls.push('before')
        seen.push(e, r)
        return next()
      },
    )
    ;(harness.ctx.on as unknown as (name: string, listener: unknown) => unknown)(
      'tools/post-execute',
      async (e: unknown, r: unknown, next: () => Promise<unknown>) => {
        calls.push('after')
        seen.push(e, r)
        return next()
      },
    )
    let terminalCalls = 0
    const decision = await drive(harness, exec, result, async () => {
      terminalCalls += 1
      calls.push('terminal')
      return { kind: 'accept' }
    })
    expect(terminalCalls).toBe(1)
    expect(calls).toEqual(['before', 'after', 'terminal'])
    // The coordinator listener sits between before and after: identity passes
    // through it unchanged (same exec and result objects on both sides).
    expect(seen[0]).toBe(exec)
    expect(seen[1]).toBe(result)
    expect(seen[2]).toBe(exec)
    expect(seen[3]).toBe(result)
    expect(decision).toEqual({ kind: 'accept' })
  })

  it('propagates a downstream throw unchanged while retiring the exec candidates', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    const candidate = { target, version: 'v1', generation: 1 }
    const boom = new Error('downstream exploded')
    await expect(drive(harness, exec, {}, async () => Promise.reject(boom))).rejects.toBe(boom)
    expect(harness.collector.take(exec)).toEqual([])
    expect(harness.collector.isCurrent(candidate)).toBe(false)
  })

  it('retires the exec candidates when downstream next() throws synchronously, propagating the identical error', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    const candidate = { target, version: 'v1', generation: 1 }
    const boom = new Error('synchronous downstream throw')
    // Cordis's waterfall invokes listeners directly, so a non-async downstream
    // listener can throw synchronously out of next(); the coordinator must
    // still take/retire the exec's candidates before the original error
    // propagates.
    await expect(
      drive(harness, exec, {}, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(harness.collector.take(exec)).toEqual([])
    expect(harness.collector.isCurrent(candidate)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a downstream throw after the coordinator with the same error object', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const boom = new Error('after the coordinator')
    ;(harness.ctx.on as unknown as (name: string, listener: unknown) => unknown)(
      'tools/post-execute',
      async (_e: unknown, _r: unknown, next: () => Promise<unknown>) => next(),
    )
    ;(harness.ctx.on as unknown as (name: string, listener: unknown) => unknown)(
      'tools/post-execute',
      async () => {
        throw boom
      },
    )
    await expect(drive(harness, exec, {}, acceptNext())).rejects.toBe(boom)
  })

  it('propagates the identical caller-abort rejection while downstream next() is pending, with candidate cleanup', async () => {
    // Historical F5 caller-abort proof: hold next() pending in the real
    // three-parameter waterfall, then let the caller signal abort and the
    // downstream reject with the SAME abort object (as the real ToolRuntime
    // does). The listener must rethrow that exact object — never a wrapped or
    // recreated error — and still retire the exec's candidates.
    const harness = makeHarness()
    const caller = new AbortController()
    const exec = makeExec('/ws', caller.signal)
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    const candidate = { target, version: 'v1', generation: 1 }
    // One fixed abort object shared by the downstream rejection and the
    // assertion: identity must survive the waterfall untouched.
    const boom = abortError(caller.signal)
    // The real ToolRuntime rejects the pending next() with an AbortError
    // derived from the caller signal when it aborts; the terminal listener
    // here behaves identically with the SAME pre-created object.
    const pending = drive(harness, exec, {}, () => new Promise<never>((_resolve, reject) => {
      caller.signal.addEventListener('abort', () => reject(boom), { once: true })
    }))
    // The listener has entered and is now blocked inside downstream next().
    await vi.advanceTimersByTimeAsync(0)
    caller.abort()
    await expect(pending).rejects.toBe(boom)
    // Candidate cleanup happens even though the augment never started.
    expect(harness.collector.take(exec)).toEqual([])
    expect(harness.collector.isCurrent(candidate)).toBe(false)
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns the original decision unchanged when the plugin-owned runtime fails', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    harness.runtime.diagnose.mockRejectedValueOnce(new Error('server exploded'))
    const decision = await drive(harness, exec, { isError: false, content: [] }, acceptNext())
    // Fail-open: the accept decision survives a plugin-owned runtime failure.
    expect(decision).toMatchObject({ kind: 'accept' })
    // A bounded unavailable notice is permitted for the eligible candidate.
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(notice!.content[0]!.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\nStatus: diagnostics unavailable (diagnostics unavailable)',
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans per-exec state and retires candidates for a non-accept decision without any I/O', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    const block = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    const decision = await drive(harness, exec, {}, async () => block)
    expect(decision).toBe(block)
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(harness.collector.take(exec)).toEqual([])
    expect(harness.collector.isCurrent({ target, version: 'v1', generation: 1 })).toBe(false)
  })

  it('handles an exec without candidates with zero I/O and zero residue', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles an already-aborted caller signal with zero I/O and zero residue', async () => {
    const harness = makeHarness()
    const controller = new AbortController()
    controller.abort()
    const exec = makeExec('/ws', controller.signal)
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(decision).toEqual({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    // A pre-aborted operation must not even derive the canonical URI or run
    // contains: zero workspace I/O of any kind before the early retirement.
    expect(harness.fs.fileUrl).not.toHaveBeenCalled()
    expect(harness.fs.contains).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target, version: 'v1', generation: 1 })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator eligibility', () => {
  it('admits every added canonical extension and rejects nearby noncanonical variants', async () => {
    const optionalServers = {
      clangd: {
        command: 'clangd',
        args: [],
        env: {},
        configuration: {},
        initializationOptions: null,
        extensionToLanguage: {
          '.c': 'c',
          '.cc': 'cpp',
          '.cpp': 'cpp',
          '.cxx': 'cpp',
          '.h': 'cpp',
          '.hh': 'cpp',
          '.hpp': 'cpp',
          '.hxx': 'cpp',
        },
      },
      rust: {
        command: 'rust-analyzer',
        args: [],
        env: {},
        configuration: {},
        initializationOptions: null,
        extensionToLanguage: { '.rs': 'rust' },
      },
      python: {
        command: 'pyright-langserver',
        args: ['--stdio'],
        env: {},
        configuration: {},
        initializationOptions: null,
        extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
      },
    }
    const harness = makeHarness('/ws', undefined, {
      servers: { ...DEFAULT_CONFIG.servers, ...optionalServers },
    })
    const exec = makeExec()
    const supported = ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'rs', 'py', 'pyi']
    for (const extension of supported) observe(harness, exec, makeTarget(`src/a.${extension}`, `f:${extension}`))
    for (const extension of ['cp', 'rust', 'pyx']) {
      observe(harness, exec, makeTarget(`src/a.${extension}`, `f:${extension}`))
    }

    await drive(harness, exec, {}, acceptNext())

    expect(harness.runtime.diagnose).toHaveBeenCalledTimes(supported.length)
    const diagnosedUris = harness.runtime.diagnose.mock.calls.map((call) => call[2])
    expect(diagnosedUris).toEqual(expect.arrayContaining(
      supported.map((extension) => `file:///ws/src/a.${extension}`),
    ))
  })

  it('silently drops unsupported extensions before any workspace or runtime work', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const mjs = makeTarget('src/a.mjs', 'f:mjs')
    const txt = makeTarget('notes.txt', 'f:txt')
    observe(harness, exec, mjs)
    observe(harness, exec, txt)
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(noticeOf(decision)).toBeUndefined()
  })

  it('silently ignores a missing or empty session cwd', async () => {
    for (const cwd of [undefined, '']) {
      const harness = makeHarness()
      const exec = { ...makeExec(), agent: { session: { header: { cwd } } } }
      const target = makeTarget('src/a.ts', 'f:a')
      observe(harness, exec, target)
      const decision = await drive(harness, exec, {}, acceptNext())
      expect(decision).toEqual({ kind: 'accept' })
      expect(harness.fs.resolve).not.toHaveBeenCalled()
      expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    }
  })

  it('silently ignores a workspace that cannot be resolved or is not a directory', async () => {
    for (const statValue of [undefined, { version: 'v', type: 'file', size: 1 }, { version: 'v', type: 'other' }]) {
      const harness = makeHarness()
      const exec = makeExec()
      const target = makeTarget('src/a.ts', 'f:a')
      observe(harness, exec, target)
      harness.fs.resolve.mockResolvedValueOnce({ targetKey: 'ws:/ws', displayPath: '/ws' })
      harness.fs.stat.mockResolvedValueOnce(statValue)
      const decision = await drive(harness, exec, {}, acceptNext())
      expect(decision).toEqual({ kind: 'accept' })
      expect(harness.runtime.diagnose).not.toHaveBeenCalled()
      expect(noticeOf(decision)).toBeUndefined()
    }
    // resolve rejection is also silent.
    const harness = makeHarness()
    const exec = makeExec()
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    harness.fs.resolve.mockRejectedValueOnce(new Error('no such cwd'))
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
  })

  it('silently drops targets outside the workspace but keeps eligible ones', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const inside = makeTarget('src/inside.ts', 'f:in')
    const outside = makeTarget('other.ts', 'f:out')
    observe(harness, exec, inside)
    observe(harness, exec, outside)
    harness.fs.contains.mockImplementation((_parent: FakeTarget, child: FakeTarget) => child.targetKey !== 'f:out')
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/inside.ts', version: 1 }
      },
    )
    const decision = await drive(harness, exec, {}, acceptNext())
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(fileLinesOf(notice!.content[0]!.text)).toEqual(['src/inside.ts'])
    expect(harness.runtime.diagnose).toHaveBeenCalledTimes(1)
  })

  it('diagnoses a sibling git worktree by resolving the workspace from the written target', async () => {
    const harness = makeHarness('/repo')
    const exec = makeExec('/repo')
    const worktreeTarget = makeTarget('/repo-worktree/pkg/a.go', 'f:worktree')
    const worktreeRoot = makeTarget('/repo-worktree', 'ws:/repo-worktree')
    observe(harness, exec, worktreeTarget)
    harness.fs.fileUrl.mockImplementation((target: FakeTarget) => `file://${target.displayPath}`)
    harness.fs.contains.mockImplementation((parent: FakeTarget, child: FakeTarget) => {
      return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
    })
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey === 'ws:/repo' || target.targetKey === 'ws:/repo-worktree') {
        return { version: 'ws-v', type: 'directory' }
      }
      if (target.targetKey === 'ws:/repo-worktree/.git') {
        return { version: 'git-v', type: 'file' }
      }
      if (target.targetKey === 'f:worktree') {
        return { version: 'v1', type: 'file', size: 32 }
      }
      return undefined
    })

    const decision = await drive(harness, exec, {}, acceptNext())

    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(fileLinesOf(notice!.content[0]!.text)).toEqual(['/repo-worktree/pkg/a.go'])
    expect(harness.runtime.diagnose).toHaveBeenCalledWith(
      expect.objectContaining({ target: worktreeTarget, version: 'v1', generation: 1 }),
      worktreeRoot,
      'file:///repo-worktree/pkg/a.go',
      expect.any(AbortSignal),
    )
  })

  it('canonicalizes the workspace exactly once and freezes renderPath/canonicalUri per eligible target', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    const b = makeTarget('src/b.ts', 'f:b')
    observe(harness, exec, a)
    observe(harness, exec, b)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(harness.fs.resolve).toHaveBeenCalledTimes(1)
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    const lines = fileLinesOf(notice!.content[0]!.text)
    expect(lines).toEqual(['src/a.ts', 'src/b.ts'])
    // URI is frozen exactly once per target and passed through to runtime;
    // neither scheduling nor runtime may call fs.fileUrl again for the target.
    expect(harness.fs.fileUrl.mock.calls.filter(([target]) => target === a)).toHaveLength(1)
    expect(harness.fs.fileUrl.mock.calls.filter(([target]) => target === b)).toHaveLength(1)
    expect(harness.runtime.diagnose).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), 'file:///ws/src/a.ts', expect.any(AbortSignal))
    expect(harness.runtime.diagnose).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), 'file:///ws/src/b.ts', expect.any(AbortSignal))
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator shared ordering', () => {
  it('diagnoses and renders in the shared (renderPath, targetKey, canonicalUri) order', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    // Raw displayPath order conflicts with the sanitized renderPath order:
    // 'b\r\nc.ts' sanitizes to 'b c.ts' while 'b c.ts' stays 'b c.ts', so the
    // raw UTF-16 order (b\r < b space) is NOT the scheduling order; the
    // shared three-column comparator ties them on renderPath and breaks on
    // targetKey.
    const crlf = makeTarget('b\r\nc.ts', 'key-1')
    const plain = makeTarget('b c.ts', 'key-0')
    // Supplementary code point: '\u{1D552}' sorts after plain ASCII by code
    // points, and its UTF-16 surrogate pair must not corrupt the comparator.
    const supplementary = makeTarget('\u{1D552}.ts', 'key-2')
    // Identical renderPath: targetKey then canonicalUri break the tie (the
    // pending map is keyed by targetKey, so the two targets must differ in
    // targetKey to coexist in one exec; the canonical URI is the final
    // comparator column).
    const tabA = makeTarget('d e.ts', 'key-3')
    const tabB = makeTarget('d e.ts', 'key-4')
    for (const target of [crlf, plain, supplementary, tabA, tabB]) observe(harness, exec, target)
    harness.fs.fileUrl.mockImplementation((target: FakeTarget) => {
      if (target === tabA) return 'file:///ws/alpha.ts'
      if (target === tabB) return 'file:///ws/beta.ts'
      return `file:///ws/${target.displayPath}`
    })
    const diagnosedKeys: string[] = []
    harness.runtime.diagnose.mockImplementation(
      async (candidate: { readonly target: FakeTarget }, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        diagnosedKeys.push(candidate.target.targetKey)
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    const decision = await drive(harness, exec, {}, acceptNext())
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    const rendered = fileLinesOf(notice!.content[0]!.text)
    // Both the diagnosis scheduling order and the renderer section order are
    // the shared comparator's order — never raw displayPath or UTF-16 order.
    // The collector's pending map is keyed by targetKey, so the identical
    // renderPath pair must carry distinct targetKeys to coexist in one exec;
    // canonicalUri is still the final comparator column (asserted below).
    // Code-point order: 'b c.ts' < 'd e.ts' < '\u{1D552}.ts'.
    expect(diagnosedKeys).toEqual(['key-0', 'key-1', 'key-3', 'key-4', 'key-2'])
    expect(rendered).toEqual(['b c.ts', 'b c.ts', 'd e.ts', 'd e.ts', '\u{1D552}.ts'])
    // The renderer defensively re-sorts with the identical comparator.
    const eligibleOf = (target: FakeTarget, uri: string) => ({
      renderPath: target.displayPath.replace(/\r\n/g, ' '),
      targetKey: target.targetKey,
      canonicalUri: uri,
    })
    expect(compareEligibleTargets(eligibleOf(crlf, 'file:///ws/x'), eligibleOf(plain, 'file:///ws/x'))).toBeGreaterThan(0)
    expect(compareEligibleTargets(eligibleOf(tabA, 'file:///ws/alpha.ts'), eligibleOf(tabB, 'file:///ws/beta.ts'))).toBeLessThan(0)
    expect(compareEligibleTargets(eligibleOf(supplementary, 'file:///ws/x'), eligibleOf(plain, 'file:///ws/x'))).toBeGreaterThan(0)
    // Same renderPath + same targetKey: canonicalUri is the decisive column.
    expect(
      compareEligibleTargets(
        { renderPath: 'd e.ts', targetKey: 'key-x', canonicalUri: 'file:///ws/alpha.ts' },
        { renderPath: 'd e.ts', targetKey: 'key-x', canonicalUri: 'file:///ws/beta.ts' },
      ),
    ).toBeLessThan(0)
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator aggregate context', () => {
  it('appends exactly one plugin notice and preserves existing contexts', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    const b = makeTarget('src/b.ts', 'f:b')
    observe(harness, exec, a)
    observe(harness, exec, b)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    const existing = { source: { kind: 'user' }, content: [{ type: 'text', text: 'downstream context' }] }
    const decision = await drive(harness, exec, {}, async () => ({ kind: 'accept', additionalContexts: [existing] }))
    const contexts = (decision as { additionalContexts?: readonly unknown[] }).additionalContexts
    expect(contexts).toBeDefined()
    expect(contexts!.length).toBe(2)
    expect(contexts![0]).toBe(existing)
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(notice!.source).toEqual({
      kind: 'plugin',
      plugin: '@banbolee/dsh-lsp-diagnostics',
      form: 'notice',
      summary: expect.stringContaining('[LSP diagnostics after write]'),
    })
    const text = notice!.content[0]!.text
    expect(text.startsWith('[LSP diagnostics after write]')).toBe(true)
    expect(fileLinesOf(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('renders the exact canonical aggregate with clean sections and a single title', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    const b = makeTarget('src/b.ts', 'f:b')
    observe(harness, exec, a)
    observe(harness, exec, b)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    const decision = await drive(harness, exec, {}, acceptNext())
    const text = noticeOf(decision)!.content[0]!.text
    expect(text).toBe('[LSP diagnostics after write]\nFile: src/a.ts\nStatus: clean\n\nFile: src/b.ts\nStatus: clean')
  })

  it('keeps the original decision result intact while appending the notice', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const target = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, target)
    const result = { isError: false, content: [{ type: 'text', text: 'written' }] }
    const decision = await drive(harness, exec, result, acceptNext())
    expect(decision).toMatchObject({ kind: 'accept' })
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect((decision as { additionalContexts?: readonly unknown[] }).additionalContexts!.length).toBe(1)
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator final gate', () => {
  it('commits stats-first when every final stat settles before the deadline', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(noticeOf(decision)).toBeDefined()
    expect(harness.fs.stat).toHaveBeenCalledTimes(2) // workspace + final stat
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats now === deadlineAt as deadline-first and still returns the decision without late stats', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    // Final stat never settles; the deadline timer fires at timeoutMs.
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<never>(() => {})
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs)
    const decision = await pending
    expect(decision).toMatchObject({ kind: 'accept' })
    // Deadline-first publishes the timeout aggregate and does not wait for the
    // late stat.
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(notice!.content[0]!.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\nStatus: diagnostics unavailable (timeout)',
    )
    // The gate never commits: the taken candidate is retired.
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
  })

  it('runs the full deadline transition when the monotonic clock reaches the deadline before the timer task', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    let releaseStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<{ version: string; type: string; size: number }>((resolve) => {
        releaseStat = resolve
      })
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    // The deadline decision must use the injected monotonic clock, not
    // Date.now(): real elapsed time alone trips the deadline.
    harness.clock.value = DEFAULT_CONFIG.timeoutMs
    releaseStat({ version: 'v1', type: 'file', size: 32 })
    const decision = await pending
    expect(noticeOf(decision)?.content[0]?.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\nStatus: diagnostics unavailable (timeout)',
    )
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out on real elapsed monotonic time even when the wall clock rolls back', async () => {
    const harness = makeHarness('/ws', undefined, { timeoutMs: 10, settleMs: 5 })
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    let releaseStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<{ version: string; type: string; size: number }>((resolve) => {
        releaseStat = resolve
      })
    })
    const startedAt = Date.now()
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    // 39ms of real (monotonic) elapsed time with a 10ms deadline, while the
    // wall clock is rolled back: a Date.now()-based deadline would still
    // commit stats-first, the monotonic clock must not.
    harness.clock.value = 39
    vi.setSystemTime(startedAt - 500)
    releaseStat({ version: 'v1', type: 'file', size: 32 })
    const decision = await pending
    expect(noticeOf(decision)?.content[0]?.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\nStatus: diagnostics unavailable (timeout)',
    )
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders deadline timeout only for still-current eligible candidates', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const current = makeTarget('src/current.ts', 'f:cur')
    observe(harness, exec, current)
    const otherExec = makeExec()
    // A newer observation for the same target lands while diagnosis is in
    // flight, so the taken candidate is stale when the deadline arrives.
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        harness.collector.observe(otherExec, current, { kind: 'present', version: 'v2' })
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/current.ts', version: 1 }
      },
    )
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<never>(() => {})
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs)
    const decision = await pending
    expect(decision).toMatchObject({ kind: 'accept' })
    // The stale candidate must be silently dropped: no timeout entry.
    expect(noticeOf(decision)).toBeUndefined()
  })

  it('registers unsettled final-stat records in retiredIo and removes them idempotently on late settle', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    let releaseStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<{ version: string; type: string; size: number }>((resolve) => {
        releaseStat = resolve
      })
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs)
    const decision = await pending
    expect(decision).toMatchObject({ kind: 'accept' })
    // Deadline-first publishes the timeout aggregate; the notice is the one
    // single context for this exec.
    expect(noticeOf(decision)).toBeDefined()
    // The late stat settles after the deadline: it must not publish anything
    // new and must be drained from retiredIo without unhandled rejections.
    releaseStat({ version: 'v1', type: 'file', size: 32 })
    await vi.advanceTimersByTimeAsync(0)
    await harness.coordinator.awaitRetiredIo()
    await harness.coordinator.awaitActiveOperations()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains a late rejection safely: no unhandled rejection and retiredIo empties', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    let rejectStat!: (reason: Error) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<never>((_resolve, reject) => {
        rejectStat = reject
      })
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const pending = drive(harness, exec, {}, acceptNext())
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs)
      await pending
      rejectStat(new Error('late failure'))
      await vi.advanceTimersByTimeAsync(0)
      await harness.coordinator.awaitRetiredIo()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it.each(['caller', 'cleanup'] as const)(
    'suppresses a deadline timeout when %s abort arrives while cooperative I/O settles',
    async (abortKind) => {
      const harness = makeHarness()
      const caller = new AbortController()
      const exec = makeExec('/ws', caller.signal)
      const a = makeTarget('src/a.ts', 'f:a')
      observe(harness, exec, a)
      let releaseDiagnosis!: () => void
      harness.runtime.diagnose.mockImplementation(
        async (_c: unknown, _w: unknown, _uri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
          await new Promise<void>((resolve) => { releaseDiagnosis = resolve })
          if (signal?.aborted === true) return { kind: 'stale' }
          return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
        },
      )
      const pending = drive(harness, exec, {}, acceptNext())
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs)
      if (abortKind === 'caller') caller.abort()
      else {
        harness.coordinator.stopAdmission()
        harness.coordinator.abortActiveOperations()
      }
      releaseDiagnosis()
      const decision = await pending
      expect(noticeOf(decision)).toBeUndefined()
      expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
      await harness.coordinator.awaitActiveOperations()
      await harness.coordinator.awaitRetiredIo()
    },
  )

  it('never publishes after the gate is closed by a caller abort', async () => {
    const harness = makeHarness()
    const controller = new AbortController()
    const exec = makeExec('/ws', controller.signal)
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    let releaseStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<{ version: string; type: string; size: number }>((resolve) => {
        releaseStat = resolve
      })
    })
    const pending = drive(harness, exec, {}, acceptNext())
    // Let the augment start and reach the final stat, then abort the caller.
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    const decision = await pending
    expect(decision).toMatchObject({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    // The late stat settles after the abort: only the retiredIo observer
    // drains it, never a publish.
    releaseStat({ version: 'v1', type: 'file', size: 32 })
    await vi.advanceTimersByTimeAsync(0)
    await harness.coordinator.awaitRetiredIo()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never publishes after cleanup abort and drains both registries', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    let releaseStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<{ version: string; type: string; size: number }>((resolve) => {
        releaseStat = resolve
      })
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    harness.coordinator.stopAdmission()
    harness.coordinator.abortActiveOperations()
    const decision = await pending
    expect(decision).toMatchObject({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    releaseStat({ version: 'v1', type: 'file', size: 32 })
    await vi.advanceTimersByTimeAsync(0)
    await harness.coordinator.awaitActiveOperations()
    await harness.coordinator.awaitRetiredIo()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('silently drops a candidate superseded by a later observation during diagnosis', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    const takenCandidate = { target: a, version: 'v1', generation: 1 }
    const otherExec = makeExec()
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        // A concurrent mutation lands while diagnosis is in flight.
        harness.collector.observe(otherExec, a, { kind: 'present', version: 'v2' })
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return { version: 'v2', type: 'file', size: 32 }
    })
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(decision).toEqual({ kind: 'accept' })
    // The taken generation-1 candidate is no longer current; the final stat
    // version (v2) also mismatches, so nothing is published.
    expect(noticeOf(decision)).toBeUndefined()
    expect(harness.collector.isCurrent(takenCandidate)).toBe(false)
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator admission and registration', () => {
  it('refuses registration once admission is closed, retiring candidates synchronously', async () => {
    const harness = makeHarness()
    harness.coordinator.stopAdmission()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(harness.collector.take(exec)).toEqual([])
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
  })

  it('registers every augment before any workspace I/O (abort during listener entry is still awaited)', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    // Hold the terminal next: the listener has entered but the augment has
    // not yet been registered. stopAdmission closes admission; when the
    // decision arrives the coordinator must not begin a new transaction.
    let releaseNext!: () => void
    const nextGate = new Promise<void>((resolve) => {
      releaseNext = resolve
    })
    const pending = drive(harness, exec, {}, async () => {
      await nextGate
      return { kind: 'accept' }
    })
    harness.coordinator.stopAdmission()
    harness.coordinator.abortActiveOperations()
    let drained = false
    const awaiting = harness.coordinator.awaitActiveOperations().then(() => {
      drained = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)
    releaseNext()
    const decision = await pending
    await awaiting
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.fs.resolve).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    await harness.coordinator.awaitRetiredIo()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an augment stuck in workspace resolution on unload and drains registries', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    let releaseResolve!: (value: FakeTarget) => void
    harness.fs.resolve.mockImplementation(
      () =>
        new Promise<FakeTarget>((resolve) => {
          releaseResolve = resolve
        }),
    )
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    harness.coordinator.stopAdmission()
    harness.coordinator.abortActiveOperations()
    releaseResolve({ targetKey: 'ws:/ws', displayPath: '/ws' })
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    await harness.coordinator.awaitActiveOperations()
    await harness.coordinator.awaitRetiredIo()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('abort after natural settlement is a no-op', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    const decision = await drive(harness, exec, {}, acceptNext())
    expect(noticeOf(decision)).toBeDefined()
    harness.coordinator.abortActiveOperations()
    harness.coordinator.abortActiveOperations()
    await harness.coordinator.awaitActiveOperations()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stopAdmission and cleanup are idempotent', async () => {
    const harness = makeHarness()
    harness.coordinator.stopAdmission()
    harness.coordinator.stopAdmission()
    harness.coordinator.abortActiveOperations()
    await harness.coordinator.awaitActiveOperations()
    await harness.coordinator.awaitRetiredIo()
    expect(harness.runtime.stopAdmission).toHaveBeenCalledTimes(2)
  })

  it('does not abort active operations at stop admission; only the abort step does', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    let capturedSignal: AbortSignal | undefined
    let releaseDiagnosis!: () => void
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _uri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        capturedSignal = signal
        await new Promise<void>((resolve) => {
          releaseDiagnosis = resolve
        })
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    expect(capturedSignal?.aborted).toBe(false)
    // stop admission only closes the gate; the documented order aborts active
    // operations later, after both listener disposers have run.
    harness.coordinator.stopAdmission()
    expect(capturedSignal?.aborted).toBe(false)
    harness.coordinator.abortActiveOperations()
    expect(capturedSignal?.aborted).toBe(true)
    releaseDiagnosis()
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    await harness.coordinator.awaitActiveOperations()
    await harness.coordinator.awaitRetiredIo()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an augment stuck in the workspace stat on unload and drains registries', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    let releaseWorkspaceStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) {
        return new Promise<{ version: string; type: string; size: number }>((resolve) => {
          releaseWorkspaceStat = resolve
        })
      }
      return { version: 'v1', type: 'file', size: 32 }
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    harness.coordinator.stopAdmission()
    harness.coordinator.abortActiveOperations()
    releaseWorkspaceStat({ version: 'ws-v', type: 'directory', size: 0 })
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(harness.runtime.diagnose).not.toHaveBeenCalled()
    expect(harness.fs.contains).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    await harness.coordinator.awaitActiveOperations()
    await harness.coordinator.awaitRetiredIo()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator cleanup ownership', () => {
  it('cleans up an unload racing the final stat, with runtime.dispose only after quiescence', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockImplementation(
      async (_c: unknown, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
      },
    )
    let releaseStat!: (value: { version: string; type: string; size: number }) => void
    harness.fs.stat.mockImplementation(async (target: FakeTarget) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      return new Promise<{ version: string; type: string; size: number }>((resolve) => {
        releaseStat = resolve
      })
    })
    const pending = drive(harness, exec, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    harness.coordinator.stopAdmission()
    harness.coordinator.abortActiveOperations()
    const decision = await pending
    expect(decision).toMatchObject({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    releaseStat({ version: 'v1', type: 'file', size: 32 })
    await vi.advanceTimersByTimeAsync(0)
    await harness.coordinator.awaitActiveOperations()
    await harness.coordinator.awaitRetiredIo()
    // The coordinator itself never disposes the runtime; that is the entry's
    // final cleanup step after both registries are empty.
    expect(harness.runtime.dispose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves zero caller/cleanup abort-listener residue on every terminal path', async () => {
    const runCase = async (kind: 'no-candidate' | 'non-accept' | 'stats-first' | 'deadline' | 'caller' | 'cleanup') => {
      const tracked = trackAbortListeners()
      try {
        const harness = makeHarness()
        const caller = new AbortController()
        const exec = makeExec('/ws', caller.signal)
        if (kind !== 'no-candidate') observe(harness, exec, makeTarget(`src/${kind}.ts`, `f:${kind}`))
        if (kind === 'deadline' || kind === 'caller' || kind === 'cleanup') {
          harness.runtime.diagnose.mockImplementation(
            async (_c: unknown, _w: unknown, _uri: string, signal: AbortSignal | undefined) =>
              abortable(new Promise<Outcome>(() => {}), signal),
          )
        }
        const pending = drive(
          harness,
          exec,
          {},
          kind === 'non-accept' ? async () => ({ kind: 'block' }) : acceptNext(),
        )
        await vi.advanceTimersByTimeAsync(0)
        if (kind === 'deadline') await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs)
        if (kind === 'caller') caller.abort()
        if (kind === 'cleanup') {
          harness.coordinator.stopAdmission()
          harness.coordinator.abortActiveOperations()
        }
        await pending
        await harness.coordinator.awaitActiveOperations()
        await harness.coordinator.awaitRetiredIo()
        expect(tracked.count(), kind).toBe(0)
        expect(vi.getTimerCount(), kind).toBe(0)
      } finally {
        tracked.restore()
      }
    }
    for (const kind of ['no-candidate', 'non-accept', 'stats-first', 'deadline', 'caller', 'cleanup'] as const) {
      await runCase(kind)
    }
  })

  it('leaves zero residue when the operation disposer and cleanup are repeated on a live operation', async () => {
    const tracked = trackAbortListeners()
    try {
      const harness = makeHarness()
      const caller = new AbortController()
      const exec = makeExec('/ws', caller.signal)
      const a = makeTarget('src/a.ts', 'f:a')
      observe(harness, exec, a)
      let releaseDiagnosis!: () => void
      harness.runtime.diagnose.mockImplementation(
        async (_c: unknown, _w: unknown, _uri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
          await new Promise<void>((resolve) => {
            releaseDiagnosis = resolve
          })
          if (signal?.aborted === true) return { kind: 'stale' }
          return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/a.ts', version: 1 }
        },
      )
      const pending = drive(harness, exec, {}, acceptNext())
      await vi.advanceTimersByTimeAsync(0)
      // Repeated cleanup cycles against the live operation: stop admission,
      // abort, and both await barriers are all idempotent, and the operation's
      // deadline timer + caller/cleanup relay listeners reach zero residue.
      harness.coordinator.stopAdmission()
      harness.coordinator.stopAdmission()
      harness.coordinator.abortActiveOperations()
      harness.coordinator.abortActiveOperations()
      harness.coordinator.abortActiveOperations()
      releaseDiagnosis()
      const decision = await pending
      expect(decision).toEqual({ kind: 'accept' })
      expect(noticeOf(decision)).toBeUndefined()
      await harness.coordinator.awaitActiveOperations()
      await harness.coordinator.awaitActiveOperations()
      await harness.coordinator.awaitRetiredIo()
      await harness.coordinator.awaitRetiredIo()
      expect(tracked.count()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      tracked.restore()
    }
  })

  it('leaves zero timer residue after every terminal path', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    await drive(harness, exec, {}, acceptNext())
    expect(vi.getTimerCount()).toBe(0)
    // A second exec leaves no cross-exec residue either.
    const exec2 = makeExec()
    observe(harness, exec2, makeTarget('src/b.ts', 'f:b'))
    await drive(harness, exec2, {}, acceptNext())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes a single aggregate for a mixed diagnostics+clean exec', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    const b = makeTarget('src/b.ts', 'f:b')
    observe(harness, exec, a)
    observe(harness, exec, b)
    harness.runtime.diagnose.mockImplementation(
      async (candidate: { readonly target: FakeTarget }, _w: unknown, _canonicalUri: string, signal: AbortSignal | undefined): Promise<Outcome> => {
        if (signal !== undefined && signal.aborted) return { kind: 'stale' }
        if (candidate.target.targetKey === 'f:a') {
          return {
            kind: 'ok',
            diagnostics: [
              {
                uri: 'file:///ws/src/a.ts',
                range: { start: { line: 12, character: 4 }, end: { line: 12, character: 9 } },
                severity: 'error',
                severityRank: 0,
                code: 'TS2322',
                source: 'typescript',
                message: "Type 'string' is not assignable to type 'number'.",
              },
            ],
            uri: 'file:///ws/src/a.ts',
            version: 1,
          }
        }
        return { kind: 'ok', diagnostics: [], uri: 'file:///ws/src/b.ts', version: 1 }
      },
    )
    const decision = await drive(harness, exec, {}, acceptNext())
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(notice!.content[0]!.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\n- error 13:5-13:10 source="typescript" code="TS2322" Type \'string\' is not assignable to type \'number\'.\n\nFile: src/b.ts\nStatus: clean\n\nFix these diagnostics before considering the change complete.',
    )
    // The renderer receives the same strict entries the coordinator built.
    const entries = [
      {
        renderPath: 'src/a.ts',
        targetKey: 'f:a',
        canonicalUri: 'file:///ws/src/a.ts',
        kind: 'diagnostics' as const,
        diagnostics: [
          {
            uri: 'file:///ws/src/a.ts',
            range: { start: { line: 12, character: 4 }, end: { line: 12, character: 9 } },
            severity: 'error' as const,
            severityRank: 0,
            code: 'TS2322',
            source: 'typescript',
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ],
      },
      { renderPath: 'src/b.ts', targetKey: 'f:b', canonicalUri: 'file:///ws/src/b.ts', kind: 'clean' as const },
    ]
    const rendered = renderDiagnostics(entries, harness.config)
    expect(rendered.text).toBe(notice!.content[0]!.text)
    expect(rendered.diagnosticCount).toBe(1)
    expect(rendered.fileCount).toBe(2)
  })

  it('reports plugin-owned unavailable through the aggregate when the runtime returns unavailable', async () => {
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockResolvedValue({ kind: 'unavailable', reason: 'server not found' })
    const decision = await drive(harness, exec, {}, acceptNext())
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(notice!.content[0]!.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\nStatus: diagnostics unavailable (server not found)',
    )
  })

  it('uses the bounded read path on the runtime side with the shared eligibility (smoke)', async () => {
    // The coordinator owns eligibility; the runtime owns the bounded read.
    // This smoke proves the two compose: an unknown-size read error maps to a
    // bounded unavailable reason through the coordinator's gate.
    const harness = makeHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    observe(harness, exec, a)
    harness.runtime.diagnose.mockResolvedValue({ kind: 'unavailable', reason: 'document too large' })
    const decision = await drive(harness, exec, {}, acceptNext())
    const notice = noticeOf(decision)
    expect(notice).toBeDefined()
    expect(notice!.content[0]!.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\nStatus: diagnostics unavailable (document too large)',
    )
  })
})

describe('@banbolee/dsh-lsp-diagnostics coordinator unload stage matrix (real runtime composition)', () => {
  // The REAL DiagnosticsRuntime is composed with the real collector and
  // coordinator through a real Cordis context; the runtime-side phases of the
  // unload matrix (contains before/after, target stat, target read, runtime
  // admission/queue) are exercised under the exact plugin cleanup order —
  // stop admission → off listeners → abort → await active → await retired →
  // runtime.dispose — and each phase must end with zero I/O/context residue.
  // No fs/observed event is hand-sent to fake the composition.

  it('unloads before the contains loop: zero contains and zero runtime work', async () => {
    const harness = makeComposedHarness()
    const caller = new AbortController()
    caller.abort()
    const exec = makeExec('/ws', caller.signal)
    const a = makeTarget('src/a.ts', 'f:a')
    harness.collector.observe(exec, a, { kind: 'present', version: 'v1' })
    const pending = drive(harness, exec, {}, acceptNext())
    const order: string[] = []
    await unloadComposed(harness, order)
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    // A pre-aborted operation must not even derive the canonical URI or reach
    // the contains loop: zero workspace I/O of any kind before retirement.
    expect(harness.fs.fileUrl).not.toHaveBeenCalled()
    expect(harness.fs.contains).not.toHaveBeenCalled()
    expect(harness.fs.readBytes).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(order).toEqual([...CLEANUP_ORDER])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unloads between the contains checks of two candidates: one contains, no admission, full cleanup order', async () => {
    const harness = makeComposedHarness()
    const caller = new AbortController()
    const exec = makeExec('/ws', caller.signal)
    const a = makeTarget('src/a.ts', 'f:a')
    const b = makeTarget('src/b.ts', 'f:b')
    harness.collector.observe(exec, a, { kind: 'present', version: 'v1' })
    harness.collector.observe(exec, b, { kind: 'present', version: 'v1' })
    // contains is a synchronous seam with no abort signal, so the only way a
    // caller abort can land "between" the coordinator's pre- and post-contains
    // checks is while the first contains call runs. The post-contains signal
    // check must then stop the loop: candidate B never reaches its contains
    // check or any runtime admission.
    let containsCalls = 0
    harness.fs.contains.mockImplementation(() => {
      containsCalls += 1
      if (containsCalls === 1) caller.abort()
      return true
    })
    const pending = drive(harness, exec, {}, acceptNext())
    // Let the augment begin and reach the eligibility loop: the caller abort
    // fires synchronously inside the first contains call, and the
    // coordinator's post-contains signal check must stop the loop.
    await vi.advanceTimersByTimeAsync(0)
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    expect(containsCalls).toBe(1)
    expect(harness.fs.readBytes).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(harness.collector.isCurrent({ target: b, version: 'v1', generation: 1 })).toBe(false)
    // The plugin cleanup still runs the full order afterwards, with zero
    // residue: the abort already retired everything and no timer remains.
    const order: string[] = []
    await unloadComposed(harness, order)
    expect(order).toEqual([...CLEANUP_ORDER])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unloads during the runtime target stat: aborted read returns stale, zero further I/O', async () => {
    const harness = makeComposedHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    harness.collector.observe(exec, a, { kind: 'present', version: 'v1' })
    let rejectStat!: (reason: Error) => void
    const statGate = new Promise<{ version: string; type: string; size: number }>((_resolve, reject) => {
      rejectStat = reject
    })
    harness.fs.stat.mockImplementation(async (target: FakeTarget, signal?: AbortSignal) => {
      if (target.targetKey.startsWith('ws:')) return { version: 'ws-v', type: 'directory' }
      // The target stat holds until the cleanup abort arrives, exactly like
      // the real fs seam rejecting on its operation signal.
      signal?.addEventListener('abort', () => rejectStat(abortError(signal)), { once: true })
      return statGate
    })
    const pending = drive(harness, exec, {}, acceptNext())
    // Let the augment reach the runtime's readDocument target stat.
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.fs.resolve).toHaveBeenCalledTimes(1)
    const order: string[] = []
    await unloadComposed(harness, order)
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    expect(harness.fs.readBytes).not.toHaveBeenCalled()
    expect(harness.subprocess.spawn).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(order).toEqual([...CLEANUP_ORDER])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unloads during the runtime bounded read: readBytes aborted, no spawn, no context', async () => {
    const harness = makeComposedHarness()
    const exec = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    harness.collector.observe(exec, a, { kind: 'present', version: 'v1' })
    let rejectRead!: (reason: Error) => void
    const readGate = new Promise<Uint8Array>((_resolve, reject) => {
      rejectRead = reject
    })
    harness.fs.readBytes.mockImplementation((_target: FakeTarget, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => rejectRead(abortError(signal)), { once: true })
      return readGate
    })
    const pending = drive(harness, exec, {}, acceptNext())
    // The augment reads the document (stat resolves) and parks on readBytes.
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.fs.readBytes).toHaveBeenCalledTimes(1)
    const order: string[] = []
    await unloadComposed(harness, order)
    const decision = await pending
    expect(decision).toEqual({ kind: 'accept' })
    expect(noticeOf(decision)).toBeUndefined()
    expect(harness.subprocess.spawn).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(order).toEqual([...CLEANUP_ORDER])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unloads with a second diagnosis queued behind a held first lifecycle: queue aborts without reading', async () => {
    const harness = makeComposedHarness()
    const first = makeExec()
    const second = makeExec()
    const a = makeTarget('src/a.ts', 'f:a')
    const b = makeTarget('src/b.ts', 'f:b')
    harness.collector.observe(first, a, { kind: 'present', version: 'v1' })
    harness.collector.observe(second, b, { kind: 'present', version: 'v1' })
    let rejectRead!: (reason: Error) => void
    const readGate = new Promise<Uint8Array>((_resolve, reject) => {
      rejectRead = reject
    })
    harness.fs.readBytes.mockImplementation((_target: FakeTarget, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => rejectRead(abortError(signal)), { once: true })
      return readGate
    })
    // Both augments admit to the same (provider, workspace) runtime tail: the
    // first parks on its bounded read, the second queues behind it.
    const firstPending = drive(harness, first, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    const secondPending = drive(harness, second, {}, acceptNext())
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.fs.readBytes).toHaveBeenCalledTimes(1)
    const order: string[] = []
    await unloadComposed(harness, order)
    const [firstDecision, secondDecision] = await Promise.all([firstPending, secondPending])
    expect(firstDecision).toEqual({ kind: 'accept' })
    expect(secondDecision).toEqual({ kind: 'accept' })
    expect(noticeOf(firstDecision)).toBeUndefined()
    expect(noticeOf(secondDecision)).toBeUndefined()
    // The queued diagnosis never ran its lifecycle: no second read, no spawn.
    expect(harness.fs.readBytes).toHaveBeenCalledTimes(1)
    expect(harness.subprocess.spawn).not.toHaveBeenCalled()
    expect(harness.collector.isCurrent({ target: a, version: 'v1', generation: 1 })).toBe(false)
    expect(harness.collector.isCurrent({ target: b, version: 'v1', generation: 1 })).toBe(false)
    expect(order).toEqual([...CLEANUP_ORDER])
    expect(vi.getTimerCount()).toBe(0)
  })
})
