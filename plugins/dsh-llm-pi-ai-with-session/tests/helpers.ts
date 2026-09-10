/**
 * Test helpers for dsh-llm-pi-ai-with-session: a local openai-completions mock
 * gateway plus harness assemblies that mount LlmRuntime and the plugin.
 *
 * Two assembly styles mirror the two injection paths the plugin supports:
 * - `createHarness({ providers })` passes the llm-pi-ai-shaped providers table
 *   directly as the plugin config (way A) — exercises adapter dispatch without
 *   any settings service.
 * - `createSettingsHarness(providers)` mounts a minimal in-memory settings
 *   provider plus a stub plugin that registers the `llm-pi-ai` namespace, so
 *   the plugin reads providers through `ctx.settings.get('llm-pi-ai')` (way B).
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { afterEach, vi } from 'vitest'
import sessionHeaderPlugin from '../index.js'

/** One plain user message with the given text. */
export function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }] satisfies ContentBlock[],
    source: { kind: 'user' },
  })
}

/**
 * One provider profile in the llm-pi-ai `providers` dict shape. Only the fields
 * this plugin mirrors are meaningful here; extra fields are tolerated.
 */
export interface ProviderProfile {
  apiKeyEnv?: string
  baseURL: string
  api?: string
  reasoning?: string
  displayName?: string
  headers?: Record<string, string | null>
  defaultInput?: string[]
  maxRequestImageBytes?: number
  requestImagePixelBudget?: number
  requestImageMaxBytes?: number
  models?: Array<{
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    input?: string[]
    reasoningEfforts?: Record<string, string | null> | false
  }>
}

export interface MockGateway {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
}

const servers: Server[] = []

/** Close every mock gateway opened since the last call; run from each spec. */
export async function closeMockGateways(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/**
 * A minimal complete text generation in pi-ai's chat-completions SSE shape:
 * role preamble, one content delta, a terminal stop with usage, then [DONE].
 */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** A complete tool-use generation: name + arguments delta + stop. */
export const toolEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
  '[DONE]',
]

/**
 * Local openai-completions gateway stand-in: replays scripted SSE behaviors per
 * request and records every request's url, parsed body, and headers.
 */
export async function mockGateway(scripts: {
  status?: number
  events?: string[]
  body?: string
  headers?: Record<string, string>
}[]): Promise<MockGateway> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      const script = scripts.shift() ?? { status: 500, body: 'script exhausted' }
      if (script.status !== undefined && script.status !== 200) {
        response.writeHead(script.status, { 'content-type': 'application/json', ...script.headers })
        response.end(script.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of script.events ?? []) {
        response.write(`data: ${event}\n\n`)
      }
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, requests, headers }
}

/** The harness credentials service shape the adapter consumes. */
export interface CredentialsStub {
  resolve: (ref: string) => Promise<{ value?: string } | undefined>
}

export interface SessionHeaderHarnessConfig {
  /**
   * llm-pi-ai-shaped providers table passed straight into the plugin config as
   * `providers` (way A). Every key becomes a route named `<key><suffix>`.
   */
  providers?: Record<string, ProviderProfile>
  routes?: Array<{ route: string; source: string; displayName?: string }>
  /** Extra plugin config merged over the providers (sessionHeader/suffix/...). */
  pluginConfig?: Record<string, unknown>
  /**
   * Stub credentials service registered on the context before the plugin
   * mounts, so the adapter resolves keys through the harness seam.
   */
  credentials?: CredentialsStub
}

export interface SessionHeaderHarness {
  ctx: Context
  /** Drain one stream call through ctx.llm and return the raw chunks. */
  stream: (options: Record<string, unknown>) => Promise<unknown[]>
}

/** Mount LlmRuntime + the session wrapper plugin (way A: providers in config). */
export async function createHarness(config: SessionHeaderHarnessConfig = {}): Promise<SessionHeaderHarness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  if (config.credentials !== undefined) ctx.provide('credentials', config.credentials)
  await ctx.plugin(sessionHeaderPlugin, {
    ...(config.providers === undefined ? {} : { providers: config.providers }),
    ...(config.routes === undefined ? {} : { routes: config.routes }),
    ...(config.pluginConfig === undefined ? {} : config.pluginConfig),
  })
  return {
    ctx,
    stream: async (options) => {
      const chunks: unknown[] = []
      for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
      return chunks
    },
  }
}

/** Standard vitest setup for gateway-based specs: close servers, unset env. */
export function installGatewayHooks(): void {
  afterEach(async () => {
    await closeMockGateways()
    vi.unstubAllEnvs()
  })
}

/** Stub the api key env var for one spec. */
export function stubApiKey(name: string, value: string): void {
  vi.stubEnv(name, value)
}

// ---------------------------------------------------------------------------
// Way B: in-memory settings provider + a stub plugin registering the
// `llm-pi-ai` namespace, so `ctx.settings.get('llm-pi-ai')` resolves.
// ---------------------------------------------------------------------------

/** The settings namespace llm-pi-ai owns; the mirror source. */
export const LLM_PI_AI_NS = 'llm-pi-ai'

/** Minimal in-memory settings provider: stores one raw document in memory. */
export class MemorySettingsProvider extends SettingsProvider {
  readonly writable = true

  private doc: Record<string, unknown>

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx)
    this.doc = config
  }

  protected async load(): Promise<Record<string, unknown>> {
    return this.doc
  }

  protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = section
  }
}

/** Loose schema for the stub llm-pi-ai namespace: a dict of provider profiles. */
export const llmPiAiSchema = z.object({
  providers: z.dict(z.object({
    apiKeyEnv: z.string(),
    baseURL: z.string().required(),
    api: z.string(),
    reasoning: z.string(),
    displayName: z.string(),
    headers: z.dict(z.union([z.string(), z.const(null)])),
    defaultInput: z.array(z.union(['text', 'image'])).default(['text']),
    maxRequestImageBytes: z.number(),
    requestImagePixelBudget: z.number(),
    requestImageMaxBytes: z.number(),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      contextWindow: z.number(),
      maxTokens: z.number(),
      input: z.array(z.union(['text', 'image'])),
    })),
  })).default({}),
})

/**
 * Minimal llm-pi-ai stand-in: registers the `llm-pi-ai` settings namespace so
 * `ctx.settings.get('llm-pi-ai')` resolves. The plugin config acts as the
 * composition base layer, so `{ providers }` passed here is what the session
 * wrapper plugin will read back through the settings service.
 */
export const stubLlmPiAiPlugin = {
  name: 'stub-llm-pi-ai',
  inject: ['settings'],
  apply(ctx: Context, config: { providers?: Record<string, ProviderProfile> }): void {
    ctx.settings.register(LLM_PI_AI_NS, llmPiAiSchema, { base: config ?? {} })
  },
}

/**
 * Mount the full way-B path: LlmRuntime + in-memory settings provider + the
 * stub llm-pi-ai namespace plugin + the session wrapper plugin with no
 * providers in its own config. The wrapper must mirror what the stub's
 * settings section supplies.
 */
export async function createSettingsHarness(
  providers: Record<string, ProviderProfile>,
  pluginConfig: Record<string, unknown> = {},
): Promise<SessionHeaderHarness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettingsProvider, {})
  await ctx.plugin(stubLlmPiAiPlugin, { providers })
  await ctx.plugin(sessionHeaderPlugin, pluginConfig)
  return {
    ctx,
    stream: async (options) => {
      const chunks: unknown[] = []
      for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
      return chunks
    },
  }
}
