import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import rtkShellPlugin, { Config, createGrepPostExecuteListener, inject, rtkPipeCompress } from '../index.js'
import { installFakeRtkPathHooks } from './helpers.js'

const FAKE_RTK = fileURLToPath(new URL('../../../tests/fixtures/bin/rtk', import.meta.url))
const INPUT = 'alpha\nbeta\n\ncharlie\n'

installFakeRtkPathHooks()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rtkPipeCompress()', () => {
  it('returns compressed grep output when rtk pipe succeeds', async () => {
    process.env.FAKE_RTK_PIPE_MODE = 'compress'

    const output = await rtkPipeCompress(INPUT)

    expect(output).toBe('[fake-rtk pipe -f grep] compressed 3 lines\n')
  })

  it('returns the original text when rtk pipe passes it through', async () => {
    process.env.FAKE_RTK_PIPE_MODE = 'passthrough'

    const output = await rtkPipeCompress(INPUT)

    expect(output).toBe(INPUT)
  })

  it('fails open when rtk pipe denies the input', async () => {
    process.env.FAKE_RTK_PIPE_MODE = 'deny'

    const output = await rtkPipeCompress(INPUT)

    expect(output).toBe(INPUT)
  })

  it('fails open within the custom timeout when rtk pipe hangs', async () => {
    process.env.FAKE_RTK_PIPE_MODE = 'timeout'
    const startedAt = performance.now()

    const output = await rtkPipeCompress(INPUT, { timeoutMs: 100 })

    expect(output).toBe(INPUT)
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  })

  it('fails open when rtk is missing', async () => {
    const output = await rtkPipeCompress(INPUT, { rtkBinary: '/definitely/missing/rtk' })

    expect(output).toBe(INPUT)
  })

  it('honors a custom rtk binary', async () => {
    process.env.FAKE_RTK_PIPE_MODE = 'compress'

    const output = await rtkPipeCompress(INPUT, { rtkBinary: FAKE_RTK })

    expect(output).toBe('[fake-rtk pipe -f grep] compressed 3 lines\n')
  })
})

describe('createGrepPostExecuteListener()', () => {
  it('compresses grep text after downstream listeners and preserves their contexts', async () => {
    process.env.FAKE_RTK_PIPE_MODE = 'compress'
    const listener = createGrepPostExecuteListener()
    const downstream = {
      kind: 'accept' as const,
      additionalContexts: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'spill recovery' }] }],
    }
    const next = vi.fn(async () => downstream)
    const result = {
      isError: false as const,
      value: { matches: [] },
      content: [{ type: 'text' as const, text: INPUT }],
    }

    const decision = await listener({ name: 'grep' }, result, next)

    expect(next).toHaveBeenCalledOnce()
    expect(decision).toEqual({
      kind: 'accept',
      content: [{ type: 'text', text: '[fake-rtk pipe -f grep] compressed 3 lines\n' }],
      additionalContexts: downstream.additionalContexts,
    })
  })

  it('returns a non-grep downstream decision unchanged', async () => {
    const listener = createGrepPostExecuteListener()
    const downstream = { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'blocked' }] }
    const next = vi.fn(async () => downstream)

    const decision = await listener(
      { name: 'glob' },
      { isError: false, value: [], content: [{ type: 'text', text: INPUT }] },
      next,
    )

    expect(next).toHaveBeenCalledOnce()
    expect(decision).toBe(downstream)
  })

  it.each([
    ['deny', {}],
    ['timeout', { timeoutMs: 100 }],
    ['ENOENT', { rtkBinary: '/definitely/missing/rtk' }],
  ])('returns the downstream decision unchanged when rtk pipe fails via %s', async (mode, options) => {
    process.env.FAKE_RTK_PIPE_MODE = mode
    const listener = createGrepPostExecuteListener(options)
    const downstream = { kind: 'accept' as const }
    const next = vi.fn(async () => downstream)

    const decision = await listener(
      { name: 'grep' },
      { isError: false, value: { matches: [] }, content: [{ type: 'text', text: INPUT }] },
      next,
    )

    expect(decision).toBe(downstream)
  })
})

describe('plugin registration', () => {
  function createApplyContext() {
    const on = vi.fn()
    const effect = vi.fn()
    const shell = {
      run: vi.fn(),
      start: vi.fn(),
    }
    return { ctx: { shell, on, effect }, on }
  }

  it('injects tools and prepends the post-execute listener by default', () => {
    const { ctx, on } = createApplyContext()

    rtkShellPlugin(ctx, {})

    expect(inject).toEqual(['shell', 'tools'])
    expect(on).toHaveBeenCalledWith('tools/post-execute', expect.any(Function), { prepend: true })
    expect(Config['~standard'].validate({}).value).toMatchObject({ grepCompress: true })
  })

  it('does not register compression when grepCompress is false', () => {
    const { ctx, on } = createApplyContext()

    rtkShellPlugin(ctx, { grepCompress: false })

    expect(on).not.toHaveBeenCalled()
  })
})
