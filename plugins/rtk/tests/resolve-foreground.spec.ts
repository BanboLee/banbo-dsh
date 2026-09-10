import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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

describe('oracle execution context', () => {
  it('uses the resolved workdir and effective dsh environment for foreground rewrites', async () => {
    process.env.FAKE_RTK_MODE = 'context'
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-rtk-context-'))
    try {
      const { shell } = await createRtkShellHarness()
      const result = await shell.run(shell.resolve({
        command: 'context',
        workdir,
        env: { RTK_CONTEXT: 'request-env' },
        dshEnv: { DSH_RTK_CONTEXT: 'dsh-env' },
      }))

      expect(result.exitCode).toBe(0)
      expect(result.stdout.text).toBe(`${workdir}:request-env:dsh-env\n`)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('does not let request PATH replace the pinned rewrite oracle', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const shadowDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-shadow-'))
    const marker = join(shadowDir, 'invoked')
    const shadow = join(shadowDir, 'rtk')
    writeFileSync(shadow, [
      '#!/usr/bin/env bash',
      'printf shadow > "$RTK_SHADOW_MARKER"',
      'exit 1',
      '',
    ].join('\n'))
    chmodSync(shadow, 0o755)
    try {
      const { shell, calls } = await createRtkShellHarness()

      await expect(shell.run(shell.resolve({
        command: 'git status',
        env: {
          PATH: `${shadowDir}${delimiter}${process.env.PATH ?? ''}`,
          RTK_SHADOW_MARKER: marker,
        },
      }))).rejects.toMatchObject({ code: 'RTK_DENY' })
      expect(existsSync(marker)).toBe(false)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(shadowDir, { recursive: true, force: true })
    }
  })

  it('resolves a relative rtkBinary independently of each command workdir', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-rtk-relative-'))
    try {
      const { shell, calls } = await createRtkShellHarness({ rtkBinary: './tests/fixtures/bin/rtk' })

      await expect(shell.run(shell.resolve({ command: 'git status', workdir })))
        .rejects.toMatchObject({ code: 'RTK_DENY' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
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

describe('exit 3 — ask (silent rewrite)', () => {
  it('rewrites the command without adding RTK text to stderr', async () => {
    process.env.FAKE_RTK_MODE = 'ask'
    const { shell, calls } = await createRtkShellHarness({ askNote: 'legacy profile note' })
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk git status'])
    expect(result.stderr.text).toBe('fake-rtk: unsupported subcommand "git" (only "rewrite" and "pipe")\n')
    expect(result.exitCode).toBe(1)
    expect(result.sandbox).toEqual(READ_ONLY_SANDBOX)
  })
})
