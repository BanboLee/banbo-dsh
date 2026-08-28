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
    const { shell } = await createRtkShellHarness()
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
