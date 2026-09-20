/**
 * Per-request option passthrough for @banbolee/dsh-llm-pi-ai-with-session:
 * the source profile's `timeoutMs` must reach pi-ai's streamSimple options
 * beside the live session id and headers. The pi-ai compat module is mocked
 * so the exact option object is observable without a wire round-trip.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, userMessage } from './helpers.js'

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getModel: () => undefined,
  streamSimple: vi.fn(),
}))

import { streamSimple } from '@earendil-works/pi-ai/compat'

const streamSimpleMock = vi.mocked(streamSimple)

/** One terminal pi-ai event stream: a stop with empty-usage text. */
const doneEvents = {
  async *[Symbol.asyncIterator]() {
    yield {
      type: 'done',
      message: {
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        model: 'demo-model',
      },
    }
  },
}

describe('@banbolee/dsh-llm-pi-ai-with-session option passthrough', () => {
  beforeEach(() => {
    streamSimpleMock.mockReset()
  })

  it('forwards timeoutMs, the live session id, and headers to streamSimple', async () => {
    streamSimpleMock.mockReturnValue(doneEvents as never)
    const { stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'http://gateway.test/v1',
          timeoutMs: 900_000,
          models: [{ id: 'demo-model' }],
        },
      },
      routes: [{ route: 'demo-affinity', source: 'demo' }],
      credentials: { resolve: async () => ({ value: 'test-key' }) },
    })

    const chunks = await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [userMessage('hi')],
      sessionId: 'session-1',
    })

    expect(chunks.some(chunk => (chunk as { type?: string }).type === 'finish')).toBe(true)
    const options = streamSimpleMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined
    expect(options?.timeoutMs).toBe(900_000)
    expect(options?.sessionId).toBe('session-1')
    expect((options?.headers as Record<string, unknown> | undefined)?.['x-session-id']).toBe('session-1')
  })

  it('omits timeoutMs when the source profile sets none', async () => {
    streamSimpleMock.mockReturnValue(doneEvents as never)
    const { stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'http://gateway.test/v1',
          models: [{ id: 'demo-model' }],
        },
      },
      routes: [{ route: 'demo-affinity', source: 'demo' }],
      credentials: { resolve: async () => ({ value: 'test-key' }) },
    })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [userMessage('hi')],
      sessionId: 'session-1',
    })

    const options = streamSimpleMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined
    expect(options?.timeoutMs).toBeUndefined()
  })
})
