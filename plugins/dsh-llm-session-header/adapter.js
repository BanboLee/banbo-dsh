/**
 * Session-header LLM adapter: a harness `LlmAdapter` that reuses pi-ai's
 * openai-completions wire implementation and stamps the live dsh session id
 * into a configurable request header.
 *
 * @module dsh-llm-session-header/adapter
 */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { toContext } from './context.js'
import { toStreamChunks } from './stream.js'

/** Zero-cost model descriptor (pricing is not a concern of this plugin). */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 32_768

/** Reasoning efforts this adapter advertises by default, aligned with pi-ai ThinkingLevel. */
const DEFAULT_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Build the pi-ai Model descriptor for one request model id. The descriptor
 * carries the route's gateway and the openai-completions wire protocol, so
 * pi-ai's `streamSimple` dispatches to the OpenAI-compatible implementation
 * without any provider registration of its own.
 * @param config - plugin configuration.
 * @param modelId - the request's model id (passthrough when not configured).
 * @returns a pi-ai Model descriptor.
 */
function buildModel(config, modelId) {
  const entry = config.models?.find(model => model.id === modelId)
  return {
    id: modelId,
    name: entry?.name ?? modelId,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl: config.baseURL,
    reasoning: true,
    input: ['text'],
    cost: NO_COST,
    contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}

/**
 * The adapter's fixed header set plus the live session header.
 * @param config - plugin configuration.
 * @param sessionId - the request's session id, when present.
 * @returns the request headers.
 */
function requestHeaders(config, sessionId) {
  return {
    ...sessionId === undefined ? {} : { [config.sessionHeader]: String(sessionId) },
    ...attributionHeaders(),
  }
}

/**
 * An `LlmAdapter` whose requests carry the live session id in a configured
 * HTTP header. Message serialization and event translation delegate to pi-ai's
 * openai-completions implementation; this adapter only assembles the Model
 * descriptor, converts the harness request into pi-ai's Context vocabulary,
 * injects the session header, and maps the event stream back to harness
 * chunks.
 */
export class SessionHeaderAdapter extends LlmAdapter {
  /** @param config - validated plugin configuration. */
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: this.config.provider }
  }

  async resolveModel(provider, model) {
    const entry = this.config.models?.find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } },
      ...entry?.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens },
      ...this.reasoningMetadata() === undefined ? {} : { reasoning: this.reasoningMetadata() },
    }
  }

  /** The reasoning capability this route advertises, if any. */
  reasoningMetadata() {
    const efforts = this.config.reasoningEfforts ?? DEFAULT_REASONING_EFFORTS
    if (efforts.length === 0) return undefined
    return {
      efforts: efforts.map(id => ({ id, name: `${id.charAt(0).toUpperCase()}${id.slice(1)}` })),
      ...this.config.reasoning === undefined ? {} : { defaultEffort: this.config.reasoning },
    }
  }

  async listModels(provider) {
    return (this.config.models ?? []).map(entry => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      inputModalities: ['text'],
    }))
  }

  async * stream(options) {
    const apiKey = this.config.apiKeyEnv === undefined
      ? undefined
      : process.env[this.config.apiKeyEnv]
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        `dsh-llm-session-header: no API key for provider route "${options.provider}";`
        + ` set ${this.config.apiKeyEnv ?? '<none>'} in the environment`,
        'MISSING_CREDENTIAL',
      )
    }
    const model = buildModel(this.config, options.model)
    const context = toContext(options)
    const events = streamSimple(model, context, {
      apiKey,
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      headers: requestHeaders(this.config, options.sessionId),
      signal: options.signal,
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort },
    })
    yield* toStreamChunks(events)
  }
}
