import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { toStreamChunks } from '../stream.js'

/**
 * A terminal pi-ai `error` event in the shape `toStreamChunks` consumes.
 * `errorMessage` is what `mapStopReason`/`classifyPiAiError` classify on.
 */
function errorEvent(errorMessage: string) {
  return [{
    type: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: 'pi-ai-session',
      model: 'demo-model',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      stopReason: 'error',
      errorMessage,
      timestamp: 0,
    },
  }]
}

/** Drain one pi-ai event stream through the harness chunk translation. */
async function drain(events: unknown[]): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = []
  for await (const chunk of toStreamChunks(events as never)) chunks.push(chunk as Record<string, unknown>)
  return chunks
}

function finishOf(chunks: Array<Record<string, unknown>>) {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  if (finish === undefined) throw new Error('no finish chunk emitted')
  return finish
}

describe('@banbolee/dsh-llm-pi-ai-with-session error classification', () => {
  it('maps a context-window-exceeded provider error to CONTEXT_WINDOW_EXCEEDED', async () => {
    const chunks = await drain(errorEvent(
      'This model maximum context length is 128000 tokens. You requested 130000 tokens.',
    ))

    const reason = finishOf(chunks).reason as { kind?: string; failure?: { code?: string } }
    expect(reason.kind).toBe('error')
    expect(reason.failure?.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
  })

  it('maps a quota-exhausted provider error to QUOTA_EXCEEDED', async () => {
    const chunks = await drain(errorEvent('insufficient_quota'))

    const reason = finishOf(chunks).reason as { kind?: string; failure?: { code?: string } }
    expect(reason.kind).toBe('error')
    expect(reason.failure?.code).toBe(QUOTA_EXCEEDED_CODE)
  })

  it('maps a rate-limit provider error to RATE_LIMIT, not QUOTA', async () => {
    const chunks = await drain(errorEvent('429 You are being rate limited'))

    const reason = finishOf(chunks).reason as { kind?: string; failure?: { code?: string } }
    expect(reason.kind).toBe('error')
    expect(reason.failure?.code).toBe('RATE_LIMIT')
  })
})
