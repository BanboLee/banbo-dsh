import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RTK_ASK_NOTE } from '../index.js'
import { createRtkShellHarness, installFakeRtkPathHooks, READ_ONLY_SANDBOX } from './helpers.js'

installFakeRtkPathHooks()

describe('resolve()', () => {
  it('fills spec fields through the inherited provider', async () => {
    const { shell } = await createRtkShellHarness()
    const spec = shell.resolve({ command: 'git status' })
    expect(spec.command).toBe('git status')
    expect(typeof spec.workdir).toBe('string')
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(spec.stdoutMaxBytes).toBeGreaterThan(0)
    expect(spec.sandboxPolicy).toEqual({ mode: 'read-only', workspaceRoot: resolve(process.cwd()) })
  })

  it('carries workdir, env, stdin, timeout and signal through verbatim', async () => {
    const { shell } = await createRtkShellHarness()
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
    const { shell, calls } = await createRtkShellHarness()
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk git status'])
    expect(result.exitCode).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stderr.text).toContain('unsupported subcommand')
    expect(result.sandbox).toEqual(READ_ONLY_SANDBOX)
  })

  it('executes a rewritten command end to end and preserves its result facts', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell } = await createRtkShellHarness()
    const result = await shell.run(shell.resolve({ command: 'rewrite git status' }))

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('rtk git status\n')
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.sandbox).toEqual(READ_ONLY_SANDBOX)
  })
})

describe('exit 1 — passthrough', () => {
  it('delegates the original command unchanged and preserves every result fact', async () => {
    process.env.FAKE_RTK_MODE = 'passthrough'
    const { shell, calls } = await createRtkShellHarness()
    const result = await shell.run(shell.resolve({ command: "printf 'hi\\n'" }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', "printf 'hi\\n'"])
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout.text).toBe('hi\n')
    expect(result.stderr.text).toBe('')
    expect(result.sandbox).toEqual(READ_ONLY_SANDBOX)
  })
})

describe('exit 2 — deny', () => {
  it('fails closed with a deterministic error and zero delegate invocations', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const { shell, calls } = await createRtkShellHarness()

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
    const { shell, calls } = await createRtkShellHarness()
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk git status'])
    expect(result.stderr.text).toContain(RTK_ASK_NOTE)
    expect(result.stderr.text).toContain('unsupported subcommand')
    expect(result.exitCode).toBe(1)
    expect(result.sandbox).toEqual(READ_ONLY_SANDBOX)
  })
})
