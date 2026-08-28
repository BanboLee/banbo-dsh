import { describe, expect, it } from 'vitest'
import { RTK_ASK_NOTE, RtkDenyError, rtkRewriteDecision } from '../index.js'
import { createRtkShellHarness, installFakeRtkPathHooks, READ_ONLY_SANDBOX } from './helpers.js'

installFakeRtkPathHooks()

describe('graceful degradation', () => {
  it('fails open to passthrough when the rtk oracle times out', async () => {
    process.env.FAKE_RTK_MODE = 'timeout'
    const { shell, calls } = await createRtkShellHarness({ rewriteTimeoutMs: 300 })
    const result = await shell.run(shell.resolve({ command: "printf 'still-ran\\n'" }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', "printf 'still-ran\\n'"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('still-ran\n')
  })

  it('routes oracle stdout verbatim even when it is not a valid command', async () => {
    process.env.FAKE_RTK_MODE = 'malformed'
    const { shell, calls } = await createRtkShellHarness()
    const result = await shell.run(shell.resolve({ command: 'git status' }))

    expect(calls[0]?.argv).toEqual(['bash', '-c', 'not-a-command {{{ git status'])
    expect(result.signal).toBeNull()
    expect(result.sandbox).toEqual(READ_ONLY_SANDBOX)
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
