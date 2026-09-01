import { describe, expect, it } from 'vitest'
import {
  createHarness,
  installGatewayHooks,
  mockGateway,
  stubApiKey,
  textEvents,
  toolEvents,
  userMessage,
} from './helpers.js'

installGatewayHooks()

const MESSAGES = [userMessage('hello')]

describe('dsh-llm-session-header adapter', () => {
  it('sends the live session id in the configured header on the LLM request', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    const chunks = await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(1)
    expect(gateway.headers[0]?.['x-session-id']).toBe('session-1')
    expect(chunks.some(chunk => (chunk as { type?: string }).type === 'finish')).toBe(true)
  })

  it('omits the session header when the request carries no session id', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    await stream({ provider: 'light-session', model: 'gpt-5.5', messages: MESSAGES })

    expect(gateway.headers).toHaveLength(1)
    expect(gateway.headers[0]?.['x-session-id']).toBeUndefined()
  })

  it('uses a configurable header name', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({
      baseURL: gateway.url,
      pluginConfig: { sessionHeader: 'x-dsh-session' },
    })

    await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-2',
    })

    expect(gateway.headers[0]?.['x-dsh-session']).toBe('session-2')
    expect(gateway.headers[0]?.['x-session-id']).toBeUndefined()
  })

  it('sends the configured model id and serialized messages in the request body', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    const body = gateway.requests[0] as { model?: string; messages?: unknown[]; stream?: boolean }
    expect(body.model).toBe('gpt-5.5')
    expect(body.stream).toBe(true)
    expect(body.messages).toHaveLength(1)
  })

  it('attaches the harness attribution user-agent alongside the session header', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    const userAgent = gateway.headers[0]?.['user-agent']
    expect(userAgent).toBeDefined()
    expect(String(userAgent)).toMatch(/^deepseek-harness\//)
  })

  it('translates text SSE events into harness stream chunks', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    const chunks = await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    const types = chunks.map(chunk => (chunk as { type?: string }).type)
    expect(types).toContain('block-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('block-end')
    expect(types).toContain('usage')
    expect(types).toContain('finish')

    const textDelta = chunks.find(chunk => (chunk as { type?: string }).type === 'text-delta')
    expect((textDelta as { text?: string } | undefined)?.text).toBe('hello')
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    expect((finish as { reason?: unknown } | undefined)?.reason).toEqual({ kind: 'stop' })
  })

  it('translates tool-call SSE events into tool-call harness chunks', async () => {
    const gateway = await mockGateway([{ events: toolEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    const chunks = await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    const types = chunks.map(chunk => (chunk as { type?: string }).type)
    expect(types).toContain('block-start')
    expect(types).toContain('tool-call-delta')
    expect(types).toContain('block-end')
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    expect((finish as { reason?: unknown } | undefined)?.reason).toEqual({ kind: 'tool-calls' })
  })

  it('registers the configured provider route on the llm service', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({ baseURL: gateway.url })

    const providers = await ctx.llm.listProviders()
    expect(providers.some(entry => entry.id === 'light-session')).toBe(true)
  })

  it('fails with MISSING_CREDENTIAL when the api key env var is unset', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    const { stream } = await createHarness({ baseURL: gateway.url })

    const chunks = await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('passes the reasoning effort through to the request body', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ baseURL: gateway.url })

    await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-1',
      reasoningEffort: 'high',
    })

    const body = gateway.requests[0] as { reasoning_effort?: string }
    expect(body.reasoning_effort).toBe('high')
  })

  it('resolves configured model metadata through the adapter', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({
      baseURL: gateway.url,
      pluginConfig: {
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000 }],
      },
    })

    const resolved = await ctx.llm.resolveModelInfo('light-session', 'gpt-5.5')
    expect(resolved.name).toBe('GPT-5.5')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })
})
