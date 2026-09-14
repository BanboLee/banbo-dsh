import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRtkShellHarness, installFakeRtkPathHooks, READ_ONLY_SANDBOX } from './helpers.js'

installFakeRtkPathHooks()

function expectSandboxBoom(error: unknown): void {
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) {
    return
  }
  expect(error.message).toBe('sandbox-boom')
  expect(error.message).not.toContain('rtk rewrite failed')
}

describe('foreground lifecycle', () => {
  it('preserves aborted runs through the abort signal', async () => {
    process.env.FAKE_RTK_MODE = 'passthrough'
    const { shell, calls } = await createRtkShellHarness()
    const controller = new AbortController()
    const spec = shell.resolve({ command: 'sleep 30', signal: controller.signal })
    const promise = shell.run(spec)
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1)

    // The delegated executor settles caller cancellation differently per
    // containment path: with a user systemd scope (author machines) run()
    // resolves {aborted: true}; on containerized runners the fallback
    // containment path (no systemd inside the runner container) rejects the
    // run promise with the AbortError reason instead. Both prove the abort
    // terminated the run, so accept either settlement shape while keeping
    // the cancel call itself strict.
    let abortError: unknown
    try {
      controller.abort()
    } catch (error) {
      abortError = error
      console.error('[abort-lifecycle] controller.abort() threw synchronously:', error)
    }
    expect(abortError).toBeUndefined()

    let outcome: { readonly aborted: boolean; readonly timedOut: boolean } | undefined
    let rejection: unknown
    try {
      outcome = await promise
    } catch (error) {
      rejection = error
      console.error('[abort-lifecycle] run promise rejected:', error)
    }

    if (outcome !== undefined) {
      expect(outcome.aborted).toBe(true)
      expect(outcome.timedOut).toBe(false)
    } else {
      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).name).toBe('AbortError')
    }
  })
})

describe('background lifecycle (start)', () => {
  it('starts a rewritten command and preserves the process lifecycle', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell } = await createRtkShellHarness()
    const proc = shell.start(shell.resolve({ command: 'rewrite printf done' }))

    expect(proc.status).toBe('running')
    await proc.done
    expect(proc.exitCode).toBe(0)
    expect(proc.signal).toBeNull()
    const read = proc.readOutput()
    expect(read.delta).toBe('rtk printf done\n')
    expect(read.lossy).toBe(false)
    expect(proc.sandbox).toEqual(READ_ONLY_SANDBOX)
  })

  it('starts an ask rewrite without prefixing RTK text to its first read', async () => {
    process.env.FAKE_RTK_MODE = 'ask'
    const { shell } = await createRtkShellHarness()
    const proc = shell.start(shell.resolve({ command: 'rewrite printf done' }))

    await proc.done
    expect(proc.exitCode).toBe(3)
    expect(proc.readOutput()).toEqual({ delta: 'rtk printf done\n', lossy: false })
  })

  it('uses the resolved workdir and effective environment for background rewrites', async () => {
    process.env.FAKE_RTK_MODE = 'context'
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-rtk-background-context-'))
    try {
      const { shell } = await createRtkShellHarness()
      const proc = shell.start(shell.resolve({
        command: 'context',
        workdir,
        env: { RTK_CONTEXT: 'request-env' },
        dshEnv: { DSH_RTK_CONTEXT: 'dsh-env' },
      }))

      await proc.done
      expect(proc.exitCode).toBe(0)
      expect(proc.readOutput()).toEqual({ delta: `${workdir}:request-env:dsh-env\n`, lossy: false })
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('keeps the pinned oracle when a background request replaces PATH', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const { shell, calls } = await createRtkShellHarness()
    const proc = shell.start(shell.resolve({ command: 'git status', env: { PATH: '/usr/bin:/bin' } }))

    await proc.done
    expect(proc.status).toBe('killed')
    expect(calls).toHaveLength(0)
    expect(proc.readOutput().delta).toContain('denied by rule')
  })

  it('fails closed in start() on deny, settling as killed with a note and zero delegate calls', async () => {
    process.env.FAKE_RTK_MODE = 'deny'
    const { shell, calls } = await createRtkShellHarness()
    const proc = shell.start(shell.resolve({ command: 'git status' }))

    await proc.done
    expect(proc.status).toBe('killed')
    expect(calls).toHaveLength(0)
    const read = proc.readOutput()
    expect(read.delta).toContain('denied by rule')
  })

  it('throws the delegated provider error synchronously from start() when the sandbox provider fails (passthrough)', async () => {
    process.env.FAKE_RTK_MODE = 'passthrough'
    const { shell } = await createRtkShellHarness({}, () => {
      throw new Error('sandbox-boom')
    })

    let caught: unknown
    try {
      shell.start(shell.resolve({ command: 'true' }))
    } catch (error) {
      caught = error
    }
    expectSandboxBoom(caught)
  })

  it('throws the delegated provider error synchronously from start() when the sandbox provider fails (rewrite)', async () => {
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell } = await createRtkShellHarness({}, () => {
      throw new Error('sandbox-boom')
    })

    let caught: unknown
    try {
      shell.start(shell.resolve({ command: 'true' }))
    } catch (error) {
      caught = error
    }
    expectSandboxBoom(caught)
  })
})
