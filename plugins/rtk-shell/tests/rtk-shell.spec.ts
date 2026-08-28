/**
 * Package-local contract tests for the `dsh-rtk-shell` shell provider.
 *
 * The suite boots the real DSH shell seam — Cordis + `SandboxPolicyService` +
 * the real `LocalSubprocessRuntime` — and mounts `RtkShellExecutor` on top of a
 * recording fake `ctx.sandbox` provider, so the delegated provider is the
 * genuine bash-sandbox executor (same boot shape as the upstream
 * `bash-sandbox/tests/sandbox.spec.ts`). RTK decisions come from the shared
 * fake `rtk` fixture through a temporary PATH prepended by this file; no
 * user-global `rtk` is ever touched.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import RtkShellExecutor, { RTK_ASK_NOTE, RtkDenyError, rtkRewriteDecision } from '../index.js'

const FIXTURES_BIN = fileURLToPath(new URL('../../../tests/fixtures/bin/', import.meta.url))
const ORIGINAL_PATH = process.env.PATH
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-shell-spec-'))

/** The Linux file-denial dialects the fake wraps carry (same as upstream sandbox tests). */
const UNIX_SIGNATURES = ['read-only file system', 'permission denied'] as const

/** The runner-failure rule the fake wrap carries (a fake-runner: error marks the sandbox failing). */
const RUNNER_FAILURE = [{ fatalSignatures: ['fake-runner: '] }] as const

/** A passthrough wrap: the caller's argv unchanged, asserted full — commands run unconfined, deterministically. */
function passthrough(argv: readonly string[]): ConfinedArgv {
  return { argv: [...argv], enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }
}

/** One recorded provider call: the argv handed over and the policy it rode with. */
interface ConfineCall {
  argv: string[]
  policy: SandboxPolicy
}

/**
 * Boot a context with a recording fake `ctx.sandbox` and the executor under
 * test on top of it. Every confine invocation is recorded into `calls` so the
 * tests can prove exactly what the delegated provider received.
 */
async function setup(config: { mode?: SandboxMode; workspaceRoot?: string; rewriteTimeoutMs?: number } = {}) {
  const { mode, workspaceRoot, ...execConfig } = config
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      calls.push({ argv: [...argv], policy })
      return passthrough(argv)
    }
  }
  const ctx = new Context()
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, {
    ...(mode !== undefined ? { mode } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(RtkShellExecutor, { graceMs: 200, ...execConfig })
  return { ctx, shell: ctx.shell as RtkShellExecutor, calls }
}

beforeAll(() => {
  // The fake `rtk` fixture must win over any user-global rtk, forever.
  process.env.PATH = `${FIXTURES_BIN}${delimiter}${ORIGINAL_PATH ?? ''}`
})

afterEach(() => {
  // Never leak a rewrite mode into the next test or the host environment.
  delete process.env.FAKE_RTK_MODE
})

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH ?? ''
  rmSync(spillDir, { recursive: true, force: true })
})

describe('resolve()', () => {
  it('fills spec fields through the inherited provider', async () => {
    const { shell } = await setup()
    const spec = shell.resolve({ command: 'git status' })
    expect(spec.command).toBe('git status')
    expect(typeof spec.workdir).toBe('string')
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(spec.stdoutMaxBytes).toBeGreaterThan(0)
    expect(spec.sandboxPolicy).toEqual({ mode: 'read-only', workspaceRoot: resolve(process.cwd()) })
  })

  it('carries workdir, env, stdin, timeout and signal through verbatim', async () => {
    const { shell } = await setup()
    const controller = new AbortController()
    const spec = shell.resolve({
      command: 'true',
      workdir: '/tmp',
      timeoutMs: 999,
      stdin: 'x',
      env: { FOO: 'bar' },
      signal: controller.signal,
    })
    expect(spec.workdir).toBe('/tmp')
    expect(spec.timeoutMs).toBe(999)
    expect(spec.stdin).toBe('x')
    expect(spec.env).toEqual({ FOO: 'bar' })
    expect(spec.signal).toBe(controller.signal)
  })
})

describe('exit 0 — rewrite', () => {
  it('rewrites a shell command before the delegated provider sees it', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell, calls } = await setup()
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    // The delegated provider received the rewritten command, not the original.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk git status'])
    // The delegate's own genuine outcome is preserved verbatim (the fake rtk
    // exits 1 for an unknown subcommand) — nothing is fabricated by the adapter.
    expect(result.exitCode).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stderr.text).toContain('unsupported subcommand')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('executes a rewritten command end to end and preserves its result facts', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell } = await setup()
    // Original "rewrite git status" rewrites to "rtk rewrite git status", which
    // the fake executes successfully — a clean end-to-end rewrite + run.
    const result = await shell.run(shell.resolve({ command: 'rewrite git status' }))

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('rtk git status\n')
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })
})

describe('exit 1 — passthrough', () => {
  it('delegates the original command unchanged and preserves every result fact', async () => {
    process.env.FAKE_RTK_MODE = 'passthrough'
    const { shell, calls } = await setup()
    const result = await shell.run(shell.resolve({ command: "printf 'hi\\n'" }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', "printf 'hi\\n'"])
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout.text).toBe('hi\n')
    expect(result.stderr.text).toBe('')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })
})

describe('exit 2 — deny', () => {
  it('fails closed with a deterministic error and zero delegate invocations', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const { shell, calls } = await setup()

    await expect(shell.run(shell.resolve({ command: 'git status' }))).rejects.toMatchObject({
      name: 'RtkDenyError',
      code: 'RTK_DENY',
      reason: expect.stringContaining('denied by rule'),
    })
    expect(calls).toHaveLength(0)
  })
})

describe('exit 3 — ask (rewrite-with-note)', () => {
  it('rewrites the command and records a deterministic approval note in stderr', async () => {
    process.env.FAKE_RTK_MODE = 'ask'
    const { shell, calls } = await setup()
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk git status'])
    // The deterministic note is observable on the result.
    expect(result.stderr.text).toContain(RTK_ASK_NOTE)
    // The delegate's own stderr is preserved alongside the appended note.
    expect(result.stderr.text).toContain('unsupported subcommand')
    expect(result.exitCode).toBe(1)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })
})

describe('graceful degradation', () => {
  it('fails open to passthrough when the rtk oracle times out', async () => {
    process.env.FAKE_RTK_MODE = 'timeout'
    const { shell, calls } = await setup({ rewriteTimeoutMs: 300 })
    const result = await shell.run(shell.resolve({ command: "printf 'still-ran\\n'" }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', "printf 'still-ran\\n'"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('still-ran\n')
  })

  it('routes oracle stdout verbatim even when it is not a valid command (malformed oracle output)', async () => {
    process.env.FAKE_RTK_MODE = 'malformed'
    const { shell, calls } = await setup()
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', 'not-a-command {{{ git status'])
    // The delegate produced a genuine bash syntax failure; facts are preserved.
    expect(result.signal).toBeNull()
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('preserves aborted runs through the abort signal', async () => {
    process.env.FAKE_RTK_MODE = 'passthrough'
    const { shell } = await setup()
    const controller = new AbortController()
    const spec = shell.resolve({ command: 'sleep 30', signal: controller.signal })
    const promise = shell.run(spec)
    setTimeout(() => controller.abort(), 100)
    const result = await promise

    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })
})

describe('background lifecycle (start)', () => {
  it('starts a rewritten command and preserves the process lifecycle', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell } = await setup()
    const proc = shell.start(shell.resolve({ command: 'rewrite printf done' }))

    expect(proc.status).toBe('running')
    await proc.done
    expect(proc.exitCode).toBe(0)
    expect(proc.signal).toBeNull()
    const read = proc.readOutput()
    expect(read.delta).toBe('rtk printf done\n')
    expect(read.lossy).toBe(false)
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('fails closed in start() on deny, settling as killed with a note and zero delegate calls', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const { shell, calls } = await setup()
    const proc = shell.start(shell.resolve({ command: 'git status' }))

    await proc.done
    expect(proc.status).toBe('killed')
    expect(calls).toHaveLength(0)
    const read = proc.readOutput()
    expect(read.delta).toContain('denied by rule')
  })
})

describe('the decision oracle', () => {
  it('maps exit 0/1/2/3 to the RtkRewriteDecision union', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    await expect(rtkRewriteDecision('git status', { timeoutMs: 2000 })).resolves.toEqual({
      kind: 'rewrite',
      command: 'rtk git status',
    })

    process.env.FAKE_RTK_MODE = 'passthrough'
    await expect(rtkRewriteDecision('git status', { timeoutMs: 2000 })).resolves.toEqual({ kind: 'passthrough' })

    process.env.FAKE_RTK_MODE = 'deny'
    await expect(rtkRewriteDecision('git status', { timeoutMs: 2000 })).resolves.toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('denied by rule'),
    })

    process.env.FAKE_RTK_MODE = 'ask'
    await expect(rtkRewriteDecision('git status', { timeoutMs: 2000 })).resolves.toMatchObject({
      kind: 'rewrite',
      command: 'rtk git status',
      note: RTK_ASK_NOTE,
    })
  })

  it('exposes a typed deny error', () => {
    const error = new RtkDenyError('no')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RtkDenyError')
    expect(error.code).toBe('RTK_DENY')
    expect(error.reason).toBe('no')
    expect(error.message).toBe('no')
  })
})
