/**
 * Test helpers for @banbolee/dsh-llm-pi-ai-with-session: a local openai-completions mock
 * gateway plus harness assemblies that mount LlmRuntime and the plugin.
 *
 * Two assembly styles mirror the two injection paths the plugin supports:
 * - `createHarness({ providers })` passes the llm-pi-ai-shaped providers table
 *   directly as the plugin config (way A) — exercises adapter dispatch without
 *   any settings service.
 * - `createSettingsHarness(providers)` mounts an in-memory settings-service
 *   stand-in plus a stub plugin whose Config declares the `llm-pi-ai`
 *   namespace, so the plugin mirrors `ctx.settings.describe()` (way B).
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type ModelModality,
} from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor, SettingsNamespace } from '@deepseek-ai/dsh-settings'
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
  defaultInput?: ModelModality[]
  maxRequestImageBytes?: number
  requestImagePixelBudget?: number
  requestImageMaxBytes?: number
  timeoutMs?: number
  streamIdleTimeoutMs?: number
  retryPolicy?: {
    mode?: string
    maxRetries?: number
    retryableCodes?: string[]
    backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
  }
  models?: Array<{
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    input?: ModelModality[]
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
  /** Delay before writing the response, in milliseconds (idle-timeout tests). */
  delayMs?: number
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
      const respond = () => {
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
      }
      if (script.delayMs !== undefined) {
        setTimeout(respond, script.delayMs)
      } else {
        respond()
      }
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

/**
 * One test request. The specs build plain fixture objects whose durable-message
 * ids and session ids are unbranded, so this envelope names only the fields a
 * spec sets and {@link toGenerateOptions} crosses the branded boundary once.
 */
export interface TestStreamOptions {
  provider: string
  model: string
  messages: unknown[]
  sessionId?: string
  reasoningEffort?: string
  maxTokens?: number
  temperature?: number
}

export interface SessionHeaderHarness {
  ctx: Context
  /** The wrapper plugin's fiber, so specs can unload it and assert route release. */
  fiber: Fiber
  /** Drain one stream call through ctx.llm and return the raw chunks. */
  stream: (options: TestStreamOptions) => Promise<unknown[]>
}

/**
 * Forward one test fixture into the fully assembled harness request: the specs
 * build durable-message literals with unbranded ids and session ids, so the
 * fixture payload crosses the branded boundary through this one cast.
 */
export function toGenerateOptions(options: TestStreamOptions): GenerateOptions {
  return {
    provider: options.provider,
    model: options.model,
    messages: options.messages as GenerateOptions['messages'],
    ...options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId as NonNullable<GenerateOptions['sessionId']> },
    ...options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: options.reasoningEffort as NonNullable<GenerateOptions['reasoningEffort']> },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
  }
}

/** Drain one request through the llm service, collecting every chunk. */
async function drainStream(ctx: Context, options: TestStreamOptions): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of ctx.llm.stream(toGenerateOptions(options))) chunks.push(chunk)
  return chunks
}

/**
 * Mount the wrapper plugin with a raw, partially specified config. Cordis runs
 * the plugin's `Config.validate` before `apply`, so the specs keep exercising
 * default materialization; the cast only bridges the declared (resolved) config
 * type of the plugin signature.
 */
async function mountSessionHeaderPlugin(ctx: Context, raw: Record<string, unknown>): Promise<Fiber> {
  const fiber = ctx.plugin(sessionHeaderPlugin, raw as unknown as Parameters<typeof sessionHeaderPlugin>[1])
  await fiber
  return fiber
}

/** Mount LlmRuntime + the session wrapper plugin (way A: providers in config). */
export async function createHarness(config: SessionHeaderHarnessConfig = {}): Promise<SessionHeaderHarness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  if (config.credentials !== undefined) ctx.provide('credentials', config.credentials)
  const fiber = await mountSessionHeaderPlugin(ctx, {
    ...(config.providers === undefined ? {} : { providers: config.providers }),
    ...(config.routes === undefined ? {} : { routes: config.routes }),
    ...(config.pluginConfig === undefined ? {} : config.pluginConfig),
  })
  return { ctx, fiber, stream: options => drainStream(ctx, options) }
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
// Way B: an in-memory settings-service stand-in plus a stub plugin whose Config
// declares the `llm-pi-ai` namespace, so the mirror path reads it through
// `ctx.settings.describe()`.
// ---------------------------------------------------------------------------

/** The settings namespace llm-pi-ai owns; the mirror source. */
export const LLM_PI_AI_NS = 'llm-pi-ai'

/**
 * Project one in-memory section the way `SettingsForms.describe()` projects a
 * profile entry: only fields whose nearest ancestor declares `volatile` are
 * exposed, and an entry with no such field is omitted entirely. Mirrors the
 * (unexported) `volatileForm`/`projectForm` helpers of dsh-settings.
 */
function projectVolatile(schema: any, value: unknown): unknown {
  if (schema?.meta?.volatile === true) return value
  if (schema?.type !== 'object' || value === null || typeof value !== 'object') return undefined
  const projected: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(schema.dict ?? {})) {
    if (!(key in value)) continue
    const field = projectVolatile(child, Reflect.get(value, key))
    if (field !== undefined) projected[key] = field
  }
  return Object.keys(projected).length === 0 ? undefined : projected
}

/**
 * In-memory stand-in for the harness settings service.
 *
 * 0.1.7 deleted the `SettingsProvider` base class and `SettingsForms.get()`: a
 * plugin's profile entry is now its own Config, and the read path is
 * `describe()`, which reports each active entry's live value projected onto the
 * fields that entry declares volatile. This double implements that surface over
 * an in-memory document, including the change notification the real service
 * derives from its own revision bookkeeping: `describe()` advances an entry's
 * revision and emits `settings/document-updated` once its raw section moved,
 * and each write ends in `describe()` exactly like `SettingsForms.write()`.
 */
export class MemorySettingsForms extends Service {
  private readonly ownerContext: Context
  private readonly entries = new Map<string, { schema: unknown; document: unknown; raw?: string; revision: number }>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
    this.ownerContext = ctx
  }

  /** The Loader's half of the contract: mount one profile entry with its schema and live config. */
  mount(ns: string, schema: unknown, document: unknown): void {
    this.entries.set(ns, { schema, document, revision: 0 })
  }

  describe(): SettingsDescriptor[] {
    const descriptors: SettingsDescriptor[] = []
    for (const [ns, entry] of this.entries) {
      const value = projectVolatile(entry.schema, entry.document)
      if (value === undefined) continue
      const raw = JSON.stringify(entry.document ?? null)
      const revision = entry.revision + Number(entry.raw !== raw)
      if (entry.raw !== raw) this.ownerContext.emit('settings/document-updated', ns as SettingsNamespace, revision)
      entry.raw = raw
      entry.revision = revision
      descriptors.push({
        ns: ns as SettingsNamespace,
        autoGenerate: true,
        schema: entry.schema,
        value,
        revision,
        applies: 'live',
      })
    }
    return descriptors
  }

  /** Merge editable fields into one entry's config. */
  async update(ns: string, patch: object): Promise<void> {
    const entry = this.require(ns)
    entry.document = { ...(entry.document as object), ...patch }
    this.describe()
  }

  /** Reset one entry's live fields to the supplied section. */
  async replace(ns: string, section: object): Promise<void> {
    this.require(ns).document = section
    this.describe()
  }

  private require(ns: string): { schema: unknown; document: unknown; raw?: string; revision: number } {
    const entry = this.entries.get(ns)
    if (entry === undefined) throw new Error(`settings: namespace "${ns}" is not mounted`)
    return entry
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
    timeoutMs: z.number(),
    streamIdleTimeoutMs: z.number(),
    // Pass-through: the official llm-pi-ai schema validates retryPolicy; this
    // stub only mirrors the value, so a declared-but-absent policy must not be
    // materialized into an invalid shape (schemastery would otherwise turn an
    // absent object into { retryableCodes: [], backoff: {} } and break
    // resolveRetryPolicy's mode check).
    retryPolicy: z.any(),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      contextWindow: z.number(),
      maxTokens: z.number(),
      input: z.array(z.union(['text', 'image'])),
    })),
  })).default({}).volatile(),
})

/**
 * Minimal llm-pi-ai stand-in: declares the `llm-pi-ai` settings entry with the
 * providers dict volatile, exactly as the real plugin's Config exposes it. The
 * Loader owns this mounting in a real run; the in-memory settings double models
 * it here so `ctx.settings.describe()` reports the namespace. The plugin config
 * acts as the composition base layer, so `{ providers }` passed here is what
 * the session wrapper plugin mirrors.
 */
export const stubLlmPiAiPlugin = {
  name: 'stub-llm-pi-ai',
  inject: ['settings'],
  apply(ctx: Context, config: { providers?: Record<string, ProviderProfile> }): void {
    (ctx.settings as unknown as MemorySettingsForms).mount(LLM_PI_AI_NS, llmPiAiSchema, config ?? {})
  },
}

/**
 * Mount the full way-B path: LlmRuntime + the in-memory settings stand-in + the
 * stub llm-pi-ai namespace plugin + the session wrapper plugin with no
 * providers in its own config. The wrapper must mirror what the stub's settings
 * entry supplies.
 */
export async function createSettingsHarness(
  providers: Record<string, ProviderProfile>,
  pluginConfig: Record<string, unknown> = {},
): Promise<SessionHeaderHarness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettingsForms)
  await ctx.plugin(stubLlmPiAiPlugin, { providers })
  const fiber = await mountSessionHeaderPlugin(ctx, pluginConfig)
  return { ctx, fiber, stream: options => drainStream(ctx, options) }
}
