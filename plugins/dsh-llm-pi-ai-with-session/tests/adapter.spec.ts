import { describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  createSettingsHarness,
  installGatewayHooks,
  mockGateway,
  stubApiKey,
  textEvents,
  toolEvents,
  userMessage,
  type CredentialsStub,
} from './helpers.js'

installGatewayHooks()

const MESSAGES = [userMessage('hello')]

/** A single-provider providers table mirroring an llm-pi-ai profile. */
function demoProviders(baseURL: string, apiKeyEnv = 'DEEPSEEK_API_KEY') {
  return {
    demo: {
      apiKeyEnv,
      baseURL,
      models: [{ id: 'demo-model', name: 'Demo Model', contextWindow: 1_000_000, maxTokens: 128_000 }],
    },
  }
}

describe('dsh-llm-pi-ai-with-session adapter', () => {
  it('sends the live session id in the configured header on the LLM request', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    await stream({ provider: 'demo-session', model: 'demo-model', messages: MESSAGES })

    expect(gateway.headers).toHaveLength(1)
    expect(gateway.headers[0]?.['x-session-id']).toBeUndefined()
  })

  it('uses a configurable header name', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({
      providers: demoProviders(gateway.url),
      pluginConfig: { sessionHeader: 'x-dsh-session' },
    })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-2',
    })

    expect(gateway.headers[0]?.['x-dsh-session']).toBe('session-2')
    expect(gateway.headers[0]?.['x-session-id']).toBeUndefined()
  })

  it('sends the configured model id and serialized messages in the request body', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    const body = gateway.requests[0] as { model?: string; messages?: unknown[]; stream?: boolean }
    expect(body.model).toBe('demo-model')
    expect(body.stream).toBe(true)
    expect(body.messages).toHaveLength(1)
  })

  it('attaches the harness attribution user-agent alongside the session header', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
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

  it('registers the mirrored provider route on the llm service', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({ providers: demoProviders(gateway.url) })

    const providers = await ctx.llm.listProviders()
    expect(providers.some(entry => entry.id === 'demo-session')).toBe(true)
  })

  it('mirrors every llm-pi-ai provider into its own suffixed route', async () => {
    const deepseek = await mockGateway([{ events: textEvents }])
    const light = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'deepseek-key')
    stubApiKey('LIGHT_API_KEY', 'light-key')
    const { ctx } = await createHarness({
      providers: {
        deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: deepseek.url, models: [{ id: 'deepseek-v4-pro' }] },
        light: { apiKeyEnv: 'LIGHT_API_KEY', baseURL: light.url, models: [{ id: 'gpt-5.5' }] },
      },
    })

    const providers = await ctx.llm.listProviders()
    const ids = providers.map(entry => entry.id)
    expect(ids).toContain('deepseek-session')
    expect(ids).toContain('light-session')
  })

  it('routes each mirrored provider to its own gateway with its own api key', async () => {
    const deepseekGateway = await mockGateway([{ events: textEvents }])
    const lightGateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'deepseek-key')
    stubApiKey('LIGHT_API_KEY', 'light-key')
    const { stream } = await createHarness({
      providers: {
        deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: deepseekGateway.url, models: [{ id: 'deepseek-v4-pro' }] },
        light: { apiKeyEnv: 'LIGHT_API_KEY', baseURL: lightGateway.url, models: [{ id: 'gpt-5.5' }] },
      },
    })

    await stream({
      provider: 'deepseek-session',
      model: 'deepseek-v4-pro',
      messages: MESSAGES,
      sessionId: 'session-d',
    })
    await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-l',
    })

    expect(deepseekGateway.headers).toHaveLength(1)
    expect(deepseekGateway.headers[0]?.['x-session-id']).toBe('session-d')
    expect(String(deepseekGateway.headers[0]?.['authorization'])).toContain('deepseek-key')
    expect(lightGateway.headers).toHaveLength(1)
    expect(lightGateway.headers[0]?.['x-session-id']).toBe('session-l')
    expect(String(lightGateway.headers[0]?.['authorization'])).toContain('light-key')
  })

  it('fails with MISSING_CREDENTIAL when the mirrored provider api key env is unset', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('resolves the api key through the credentials service ahead of process.env', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'env-key')
    const credentials: CredentialsStub = { resolve: vi.fn(async () => ({ value: 'cred-key' })) }
    const { stream } = await createHarness({
      providers: demoProviders(gateway.url),
      credentials,
    })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(credentials.resolve).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(gateway.headers).toHaveLength(1)
    expect(String(gateway.headers[0]?.['authorization'])).toContain('cred-key')
    expect(String(gateway.headers[0]?.['authorization'])).not.toContain('env-key')
  })

  it('falls back to process.env when no credentials service is available', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'env-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(1)
    expect(String(gateway.headers[0]?.['authorization'])).toContain('env-key')
  })

  it('fails with MISSING_CREDENTIAL when neither the credentials service nor process.env yields a key', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    const credentials: CredentialsStub = { resolve: vi.fn(async () => undefined) }
    const { stream } = await createHarness({
      providers: demoProviders(gateway.url),
      credentials,
    })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(credentials.resolve).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('keeps the existing behavior when the provider declares no apiKeyEnv', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    const { stream } = await createHarness({
      providers: { demo: { baseURL: gateway.url, models: [{ id: 'demo-model' }] } },
    })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('fails with a clear error for a route that mirrors no provider', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'nope-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('NO_ADAPTER')
  })

  it('passes the reasoning effort through to the request body', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
      reasoningEffort: 'high',
    })

    const body = gateway.requests[0] as { reasoning_effort?: string }
    expect(body.reasoning_effort).toBe('high')
  })

  it('resolves mirrored model metadata through the adapter', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({ providers: demoProviders(gateway.url) })

    const resolved = await ctx.llm.resolveModelInfo('demo-session', 'demo-model')
    expect(resolved.name).toBe('Demo Model')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('fails loudly with UNSUPPORTED_CONTENT when a user message carries an image', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', attachment: { attachmentId: 'a', bytes: 1, mimeType: 'image/png' } },
        ],
        id: 'm-img',
        source: { kind: 'user' },
      }],
      sessionId: 'session-1',
    })

    // The image must never reach the gateway: the adapter rejects it up front.
    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('UNSUPPORTED_CONTENT')
  })

  it('fails loudly with UNSUPPORTED_CONTENT when an assistant message carries an image', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    const chunks = await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: [{
        role: 'assistant',
        content: [{ type: 'image', attachment: { attachmentId: 'a', bytes: 1, mimeType: 'image/png' } }],
        id: 'm-img-assistant',
        source: { kind: 'model', provider: 'demo-session', model: 'demo-model' },
      }],
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('UNSUPPORTED_CONTENT')
  })

  it('stays dormant (zero routes) when the providers table is empty', async () => {
    const { ctx } = await createHarness({ providers: {} })

    const providers = await ctx.llm.listProviders()
    expect(providers).toHaveLength(0)
  })

  it('uses the source provider reasoning as the default effort', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          reasoning: 'xhigh',
          models: [{ id: 'demo-model' }],
        },
      },
    })

    const resolved = await ctx.llm.resolveModelInfo('demo-session', 'demo-model')
    expect(resolved.reasoning?.defaultEffort).toBe('xhigh')
  })

  it('advertises the source model reasoningEfforts dict as the route efforts (no plugin-side reasoning config)', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          models: [{
            id: 'demo-model',
            reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
          }],
        },
      },
    })

    const resolved = await ctx.llm.resolveModelInfo('demo-session', 'demo-model')
    const efforts = resolved.reasoning?.efforts?.map((entry: { id?: string }) => entry.id) ?? []
    expect(efforts).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
  })

  it('keeps the default effort list when the source model declares no reasoningEfforts', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({ providers: demoProviders(gateway.url) })

    const resolved = await ctx.llm.resolveModelInfo('demo-session', 'demo-model')
    const efforts = resolved.reasoning?.efforts?.map((entry: { id?: string }) => entry.id) ?? []
    expect(efforts).toContain('off')
    expect(efforts).toContain('max')
  })

  it('sends an xhigh reasoning effort to the gateway instead of clamping it down', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url) })

    await stream({
      provider: 'demo-session',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
      reasoningEffort: 'xhigh',
    })

    const body = gateway.requests[0] as { reasoning_effort?: string }
    expect(body.reasoning_effort).toBe('xhigh')
  })
})

describe('dsh-llm-pi-ai-with-session settings mirror (way B)', () => {
  it('mirrors providers registered under the llm-pi-ai settings namespace', async () => {
    const deepseek = await mockGateway([{ events: textEvents }])
    const light = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'deepseek-key')
    stubApiKey('LIGHT_API_KEY', 'light-key')
    const { ctx, stream } = await createSettingsHarness({
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: deepseek.url, models: [{ id: 'deepseek-v4-pro' }] },
      light: { apiKeyEnv: 'LIGHT_API_KEY', baseURL: light.url, models: [{ id: 'gpt-5.5' }] },
    })

    const providers = await ctx.llm.listProviders()
    const ids = providers.map(entry => entry.id)
    expect(ids).toContain('deepseek-session')
    expect(ids).toContain('light-session')

    await stream({
      provider: 'light-session',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-mirror',
    })
    expect(light.headers).toHaveLength(1)
    expect(light.headers[0]?.['x-session-id']).toBe('session-mirror')
  })
})
