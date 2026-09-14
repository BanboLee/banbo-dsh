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

const DEMO_ROUTE = [{ route: 'demo-affinity', source: 'demo', displayName: 'Demo Affinity' }]

describe('@banbolee/dsh-llm-pi-ai-with-session adapter', () => {
  it('sends the live session id in the configured header on the LLM request', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(1)
    expect(gateway.headers[0]?.['x-session-id']).toBe('session-1')
    expect(chunks.some(chunk => (chunk as { type?: string }).type === 'finish')).toBe(true)
  })

  it('fails before the gateway request when the request carries no session id', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({ provider: 'demo-affinity', model: 'demo-model', messages: MESSAGES })

    expect(gateway.headers).toHaveLength(0)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
    expect(reason?.failure?.code).toBe('INVALID_REQUEST')
  })

  it('uses a configurable header name', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({
      providers: demoProviders(gateway.url),
      routes: DEMO_ROUTE,
      pluginConfig: { sessionHeader: 'x-dsh-session' },
    })

    await stream({
      provider: 'demo-affinity',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    await stream({
      provider: 'demo-affinity',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    const userAgent = gateway.headers[0]?.['user-agent']
    expect(userAgent).toBeDefined()
    expect(String(userAgent)).toMatch(/^deepseek-harness\//)
  })

  it('forwards source provider headers beside the live session header', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          headers: { 'x-source-header': 'source-value', 'x-session-id': 'stale-static' },
          models: [{ id: 'demo-model' }],
        },
      },
      routes: DEMO_ROUTE,
    })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-from-request',
    })

    expect(gateway.headers).toHaveLength(1)
    expect(gateway.headers[0]?.['x-source-header']).toBe('source-value')
    expect(gateway.headers[0]?.['x-session-id']).toBe('session-from-request')
  })

  it('translates text SSE events into harness stream chunks', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'demo-affinity',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'demo-affinity',
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

  it('registers the explicitly declared provider route on the llm service', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const providers = await ctx.llm.listProviders()
    expect(providers).toContainEqual({ id: 'demo-affinity', name: 'Demo Affinity' })
  })

  it('does not register undeclared source providers', async () => {
    const deepseek = await mockGateway([{ events: textEvents }])
    const light = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'deepseek-key')
    stubApiKey('LIGHT_API_KEY', 'light-key')
    const { ctx } = await createHarness({
      providers: {
        deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: deepseek.url, models: [{ id: 'deepseek-v4-pro' }] },
        light: { apiKeyEnv: 'LIGHT_API_KEY', baseURL: light.url, models: [{ id: 'gpt-5.5' }] },
      },
      routes: [{ route: 'light-affinity', source: 'light', displayName: 'Light Affinity' }],
    })

    const providers = await ctx.llm.listProviders()
    const ids = providers.map(entry => entry.id)
    expect(ids).not.toContain('deepseek-session')
    expect(ids).not.toContain('deepseek-affinity')
    expect(ids).toEqual(['light-affinity'])
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
      routes: [
        { route: 'deepseek-affinity', source: 'deepseek' },
        { route: 'light-affinity', source: 'light' },
      ],
    })

    await stream({
      provider: 'deepseek-affinity',
      model: 'deepseek-v4-pro',
      messages: MESSAGES,
      sessionId: 'session-d',
    })
    await stream({
      provider: 'light-affinity',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'demo-affinity',
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
      routes: DEMO_ROUTE,
      credentials,
    })

    await stream({
      provider: 'demo-affinity',
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
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    await stream({
      provider: 'demo-affinity',
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
      routes: DEMO_ROUTE,
      credentials,
    })

    const chunks = await stream({
      provider: 'demo-affinity',
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
      routes: DEMO_ROUTE,
    })

    const chunks = await stream({
      provider: 'demo-affinity',
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

  it('fails with NO_ADAPTER for an undeclared route', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'nope-affinity',
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

  it('fails plugin registration when a declared route references a missing source provider', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    await expect(createHarness({
      providers: demoProviders(gateway.url),
      routes: [{ route: 'missing-affinity', source: 'missing' }],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(gateway.headers).toHaveLength(0)
  })

  it('does not let pi-ai retry provider HTTP failures internally', async () => {
    const gateway = await mockGateway([
      { status: 500, body: '{"error":{"message":"boom"}}' },
      { events: textEvents },
    ])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
    })

    expect(gateway.headers).toHaveLength(1)
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    const reason = (finish as { reason?: { kind?: string } } | undefined)?.reason
    expect(reason?.kind).toBe('error')
  })

  it('passes the reasoning effort through to the request body', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    await stream({
      provider: 'demo-affinity',
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
    const { ctx } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const resolved = await ctx.llm.resolveModelInfo('demo-affinity', 'demo-model')
    expect(resolved.name).toBe('Demo Model')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('inherits image input from an installed source catalog model', async () => {
    const { ctx } = await createHarness({
      providers: {
        openai: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'http://gateway.test',
          models: [{ id: 'gpt-4o' }],
        },
      },
      routes: [{ route: 'openai-affinity', source: 'openai' }],
    })

    expect((await ctx.llm.resolveModelInfo('openai-affinity', 'gpt-4o')).inputModalities)
      .toEqual(['text', 'image'])
  })

  it('sends user images with the live session header when the source model declares image input', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const attachment = {
      attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      attachment,
      data: Uint8Array.of(1),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    }))
    const { ctx, stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          models: [{ id: 'demo-model', input: ['text', 'image'] }],
        },
      },
      routes: DEMO_ROUTE,
    })
    ctx.provide('attachments', { readImageRequest })

    expect((await ctx.llm.resolveModelInfo('demo-affinity', 'demo-model')).inputModalities)
      .toEqual(['text', 'image'])

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', attachment },
        ],
        id: 'm-img',
        source: { kind: 'user' },
      }],
      sessionId: 'session-image',
    })

    expect(readImageRequest).toHaveBeenCalledWith(attachment, {
      maxPixels: 2048 * 2048,
      maxBytes: 1024 * 1024,
    }, undefined)
    expect(gateway.headers[0]?.['x-session-id']).toBe('session-image')
    expect(JSON.stringify(gateway.requests[0])).toContain('data:image/png;base64,AQ==')
  })

  it('inherits provider default image input when settings materialize an empty model input', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const attachment = {
      attachmentId: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      attachment,
      data: Uint8Array.of(2),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    }))
    const { ctx, stream } = await createSettingsHarness({
      demo: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: gateway.url,
        defaultInput: ['text', 'image'],
        models: [{ id: 'demo-model' }],
      },
    }, { routes: DEMO_ROUTE })
    ctx.provide('attachments', { readImageRequest })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment }],
        id: 'm-default-input',
        source: { kind: 'user' },
      }],
      sessionId: 'session-default-input',
    })

    expect((await ctx.llm.resolveModelInfo('demo-affinity', 'demo-model')).inputModalities)
      .toEqual(['text', 'image'])
    expect(readImageRequest).toHaveBeenCalledOnce()
    expect(JSON.stringify(gateway.requests[0])).toContain('data:image/png;base64,Ag==')
  })

  it('keeps a mapped attachment path when an image is offloaded by the request budget', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const attachment = {
      attachmentId: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      mediaType: 'image/png',
      bytes: 9,
      width: 1,
      height: 1,
    }
    const readImageRequest = vi.fn(async () => {
      throw new Error('offloaded images must not be read')
    })
    const { ctx, stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          maxRequestImageBytes: 4,
          models: [{ id: 'demo-model', input: ['text', 'image'] }],
        },
      },
      routes: DEMO_ROUTE,
    })
    ctx.provide('attachments', { imageHostPath: () => '/host/image.png', readImageRequest })
    ctx.provide('fs', { processPathFromHostPath: () => '/sandbox/image.png' })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment }],
        id: 'm-offloaded-image',
        source: { kind: 'user' },
      }],
      sessionId: 'session-offloaded-image',
    })

    expect(readImageRequest).not.toHaveBeenCalled()
    expect(JSON.stringify(gateway.requests[0])).toContain('/sandbox/image.png')
    expect(JSON.stringify(gateway.requests[0])).not.toContain('No local normalized image path is available')
  })

  it('keeps a mapped path when exact encoded bytes exceed the request budget', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const attachment = {
      attachmentId: 'sha256:abababababababababababababababababababababababababababababababab',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: 'sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
      attachment,
      data: Uint8Array.of(1, 2, 3, 4, 5),
      mediaType: 'image/png',
      bytes: 5,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    }))
    const { ctx, stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          maxRequestImageBytes: 4,
          models: [{ id: 'demo-model', input: ['text', 'image'] }],
        },
      },
      routes: DEMO_ROUTE,
    })
    ctx.provide('attachments', { imageHostPath: () => '/host/image.png', readImageRequest })
    ctx.provide('fs', { processPathFromHostPath: () => '/sandbox/image.png' })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment }],
        id: 'm-exact-offload',
        source: { kind: 'user' },
      }],
      sessionId: 'session-exact-offload',
    })

    expect(readImageRequest).toHaveBeenCalledOnce()
    expect(JSON.stringify(gateway.requests[0])).toContain('/sandbox/image.png')
    expect(JSON.stringify(gateway.requests[0])).not.toContain('data:image/png')
  })

  it('projects user images to text when the mirrored model is text-only', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const chunks = await stream({
      provider: 'demo-affinity',
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

    expect(gateway.headers).toHaveLength(1)
    expect(JSON.stringify(gateway.requests[0])).toContain('image omitted because this model accepts text only')
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    expect((finish as { reason?: { kind?: string } } | undefined)?.reason?.kind).toBe('stop')
  })

  for (const role of ['assistant', 'system'] as const) {
    it(`projects ${role} images to text for a text-only model`, async () => {
      const gateway = await mockGateway([{ events: textEvents }])
      stubApiKey('DEEPSEEK_API_KEY', 'test-key')
      const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

      const chunks = await stream({
        provider: 'demo-affinity',
        model: 'demo-model',
        messages: [{
          role,
          content: [{
            type: 'image',
            attachment: {
              attachmentId: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
              bytes: 1,
              mimeType: 'image/png',
            },
          }],
          id: `m-img-${role}`,
          source: role === 'assistant'
            ? { kind: 'model', provider: 'demo-affinity', model: 'demo-model' }
            : { kind: 'system' },
        }],
        sessionId: `session-${role}-projection`,
      })

      expect(JSON.stringify(gateway.requests[0])).toContain('image omitted because this model accepts text only')
      const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
      expect((finish as { reason?: { kind?: string } } | undefined)?.reason?.kind).toBe('stop')
    })
  }

  for (const role of ['assistant', 'system'] as const) {
    it(`rejects ${role} images on an image-capable route before requiring attachments`, async () => {
      const gateway = await mockGateway([{ events: textEvents }])
      stubApiKey('DEEPSEEK_API_KEY', 'test-key')
      const { stream } = await createHarness({
        providers: {
          demo: {
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            baseURL: gateway.url,
            models: [{ id: 'demo-model', input: ['text', 'image'] }],
          },
        },
        routes: DEMO_ROUTE,
      })

      const chunks = await stream({
        provider: 'demo-affinity',
        model: 'demo-model',
        messages: [{
          role,
          content: [{ type: 'image', attachment: { attachmentId: 'a', bytes: 1, mimeType: 'image/png' } }],
          id: `m-img-unsupported-${role}`,
          source: role === 'assistant'
            ? { kind: 'model', provider: 'demo-session', model: 'demo-model' }
            : { kind: 'system' },
        }],
        sessionId: `session-unsupported-${role}`,
      })

      expect(gateway.headers).toHaveLength(0)
      const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
      const reason = (finish as { reason?: { kind?: string; failure?: { code?: string } } } | undefined)?.reason
      expect(reason?.kind).toBe('error')
      expect(reason?.failure?.code).toBe('UNSUPPORTED_CONTENT')
    })
  }

  it('stays dormant (zero routes) when the providers table is empty', async () => {
    const { ctx } = await createHarness({ providers: demoProviders('http://gateway.test'), routes: [] })

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
      routes: DEMO_ROUTE,
    })

    const resolved = await ctx.llm.resolveModelInfo('demo-affinity', 'demo-model')
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
      routes: DEMO_ROUTE,
    })

    const resolved = await ctx.llm.resolveModelInfo('demo-affinity', 'demo-model')
    const efforts = resolved.reasoning?.efforts?.map((entry: { id?: string }) => entry.id) ?? []
    expect(efforts).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
  })

  it('keeps the default effort list when the source model declares no reasoningEfforts', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { ctx } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    const resolved = await ctx.llm.resolveModelInfo('demo-affinity', 'demo-model')
    const efforts = resolved.reasoning?.efforts?.map((entry: { id?: string }) => entry.id) ?? []
    expect(efforts).toContain('off')
    expect(efforts).toContain('max')
  })

  it('sends an xhigh reasoning effort to the gateway instead of clamping it down', async () => {
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({ providers: demoProviders(gateway.url), routes: DEMO_ROUTE })

    await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: MESSAGES,
      sessionId: 'session-1',
      reasoningEffort: 'xhigh',
    })

    const body = gateway.requests[0] as { reasoning_effort?: string }
    expect(body.reasoning_effort).toBe('xhigh')
  })
})

describe('@banbolee/dsh-llm-pi-ai-with-session settings mirror (way B)', () => {
  it('mirrors providers registered under the llm-pi-ai settings namespace', async () => {
    const deepseek = await mockGateway([{ events: textEvents }])
    const light = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'deepseek-key')
    stubApiKey('LIGHT_API_KEY', 'light-key')
    const { ctx, stream } = await createSettingsHarness({
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: deepseek.url, models: [{ id: 'deepseek-v4-pro' }] },
      light: {
        apiKeyEnv: 'LIGHT_API_KEY',
        baseURL: light.url,
        models: [{ id: 'gpt-5.5', input: ['text', 'image'] }],
      },
    }, { routes: [{ route: 'light-affinity', source: 'light', displayName: 'Light Affinity' }] })

    const providers = await ctx.llm.listProviders()
    const ids = providers.map(entry => entry.id)
    expect(ids).toEqual(['light-affinity'])
    expect((await ctx.llm.resolveModelInfo('light-affinity', 'gpt-5.5')).inputModalities)
      .toEqual(['text', 'image'])

    await stream({
      provider: 'light-affinity',
      model: 'gpt-5.5',
      messages: MESSAGES,
      sessionId: 'session-mirror',
    })
    expect(light.headers).toHaveLength(1)
    expect(light.headers[0]?.['x-session-id']).toBe('session-mirror')
  })
})
