/**
 * Session-header LLM adapter: a harness `LlmAdapter` that reuses pi-ai's
 * openai-completions wire implementation and stamps the live dsh session id
 * into a configurable request header.
 *
 * The adapter owns only configured routes; every request dispatches on the hit
 * route back to its source provider's gateway, credential, models, headers, and
 * reasoning defaults.
 *
 * @module @banbolee/dsh-llm-pi-ai-with-session/adapter
 */

import { contentHasImage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { assertSupportedImageRoles, toContext } from './context.js'
import { buildModel, imageContext, requestHeaders, resolveModelInput } from './model.js'
import { toStreamChunks } from './stream.js'

/** Reasoning efforts this adapter advertises by default, aligned with pi-ai ThinkingLevel. */
const DEFAULT_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Default maximum provider-idle interval while one stream read is outstanding,
 * matching the official dsh-llm-pi-ai default so both route families behave
 * alike when the source profile does not set `streamIdleTimeoutMs`.
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Every thinking level pi-ai knows, in its precedence order. Levels absent
 * from the advertised efforts are pinned to `null` (unsupported) in the wire
 * map so the advertised and wire capabilities never diverge.
 */
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The wire dispatch for reasoning levels: each advertised level maps to its
 * own spelling (so xhigh/max are actually sendable), every other level is
 * pinned to `null`. `off` stays absent — pi-ai reads that as "supported, send
 * nothing", the correct dispatch where not thinking is the parameter's absence.
 * @param efforts - advertised reasoning effort ids.
 * @returns the pi-ai `thinkingLevelMap`, or `undefined` when nothing is advertised.
 */
function buildThinkingLevelMap(efforts) {
  if (efforts.length === 0) return undefined
  const map = {}
  for (const level of ALL_THINKING_LEVELS) {
    if (efforts.includes(level)) {
      if (level !== 'off') map[level] = level
    } else {
      map[level] = null
    }
  }
  return map
}

/**
 * The pi-ai `thinkingLevelMap` for a source model, inherited verbatim from its
 * declared `reasoningEfforts` dict (level → wire spelling; an undeclared level
 * is pinned unsupported, `off` with no value stays absent). When the model
 * declares nothing the default effort list applies; `false` disables reasoning.
 * @param entry - the mirrored source model entry, when one exists.
 * @returns the pi-ai `thinkingLevelMap`, or `undefined` when reasoning is off.
 */
function thinkingLevelMapFromSource(entry) {
  const efforts = entry?.reasoningEfforts
  if (efforts === undefined) return buildThinkingLevelMap(DEFAULT_REASONING_EFFORTS)
  if (efforts === false) return undefined
  const map = {}
  for (const level of ALL_THINKING_LEVELS) {
    if (efforts[level] === undefined) {
      map[level] = null
    } else if (efforts[level] !== null) {
      map[level] = efforts[level]
    }
  }
  return map
}

/**
 * An `LlmAdapter` whose requests carry the live session id in a configured
 * HTTP header, dispatching each route back to its mirrored source provider.
 * Message serialization and event translation delegate to pi-ai's
 * openai-completions implementation; this adapter only assembles the Model
 * descriptor, converts the harness request into pi-ai's Context vocabulary,
 * injects the session header, and maps the event stream back to harness
 * chunks.
 */
export class SessionHeaderAdapter extends LlmAdapter {
  /**
   * @param config - validated plugin configuration. The harness context may
   * ride along as `config.ctx` (injected by `apply`) so the credentials
   * service is resolved lazily at request time; a pre-resolved
   * `config.credentials` reference is honoured too. When neither yields a
   * service the adapter falls back to `process.env`, like the native
   * dsh-llm-pi-ai adapter does without a credentials seam.
   */
  constructor(config) {
    super()
    this.config = config
    this.credentials = config.credentials
    this.ctx = config.ctx
    this.routeByName = new Map(config.routes.map(route => [route.route, route]))
  }

  /**
   * The current mirrored source profiles. The plugin config either carries a
   * static `providers` table (explicit local injection) or a live getter
   * (settings-backed) returning the latest accepted snapshot, so every
   * per-request fact — timeouts, headers, models — is internally consistent.
   * @returns the providers table keyed by source provider.
   */
  providersOf() {
    const providers = this.config.providers
    return typeof providers === 'function' ? providers() : providers
  }

  /**
   * Return one request/configuration snapshot. Callers that cross an async
   * boundary must keep passing this object instead of calling `providersOf()`
   * again, so a settings write cannot mix generations inside one LLM call.
   * @returns the providers table keyed by source provider.
   */
  providersSnapshot() {
    return this.providersOf() ?? {}
  }

  /**
   * Return the retry policy the mirrored source profile configures, resolved
   * exactly as dsh-llm-pi-ai resolves it. A source profile without
   * `retryPolicy` returns `undefined`, so the registry applies its normal
   * defaults (five retries).
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns the resolved policy, or `undefined` for the registry defaults.
   */
  providerRetryPolicy(provider) {
    const providers = this.providersSnapshot()
    const route = this.routeByName.get(provider)
    if (route === undefined) return undefined
    const profile = providers[route.source]
    if (profile?.retryPolicy === undefined) return undefined
    return resolveRetryPolicy(profile.retryPolicy, `llm-pi-ai-with-session: provider "${provider}" retryPolicy`)
  }

  /**
   * Resolve the API key for one mirrored provider, mirroring dsh-llm-pi-ai's
   * priority: the harness credentials service when it is available, otherwise
   * the process environment. The service is looked up lazily on every call so
   * a service mounted after this plugin applies is still honoured. A
   * reference that yields nothing usable resolves to `undefined`; the caller
   * turns that into MISSING_CREDENTIAL.
   * @param ref - the mirrored provider's `apiKeyEnv` reference, when set.
   * @returns the resolved key, or `undefined` when nothing usable is found.
   */
  async resolveApiKey(ref) {
    if (ref === undefined) return undefined
    const credentials = this.credentials
      ?? this.ctx?.get?.('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[ref]
    if (hit !== undefined && hit.length > 0) return hit
    return undefined
  }

  routeFor(providerRoute, providers = this.providersSnapshot()) {
    const route = this.routeByName.get(providerRoute)
    if (route === undefined) {
      throw new LlmError(
        `@banbolee/dsh-llm-pi-ai-with-session: provider route "${String(providerRoute)}" is not configured`,
        'INVALID_REQUEST',
      )
    }
    if (providers[route.source] === undefined) {
      throw new LlmError(
        `@banbolee/dsh-llm-pi-ai-with-session: provider route "${providerRoute}" references missing llm-pi-ai provider "${route.source}"`,
        'INVALID_REQUEST',
      )
    }
    return route
  }

  providerInfo(provider) {
    const providers = this.providersSnapshot()
    const route = this.routeFor(provider, providers)
    return { id: provider, name: route.displayName ?? providers[route.source]?.displayName ?? provider }
  }

  resolveModelFromSnapshot(provider, model, providers) {
    const { source } = this.routeFor(provider, providers)
    const sourceProvider = providers[source] ?? {}
    const entry = sourceProvider.models?.find(candidate => candidate.id === model)
    const reasoning = this.reasoningMetadata(source, entry, providers)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } },
      ...entry?.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens },
      inputModalities: resolveModelInput(sourceProvider, source, model),
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  async resolveModel(provider, model) {
    return this.resolveModelFromSnapshot(provider, model, this.providersSnapshot())
  }

  /**
   * The reasoning capability a route advertises, inherited from the mirrored
   * source provider: the default effort comes from the provider's `reasoning`,
   * and the offered levels from the source model's declared `reasoningEfforts`
   * (or the default list when the model declares none).
   * @param source - the mirrored source provider name.
   * @param entry - the mirrored source model entry, when one exists.
   * @param providers - provider snapshot to read default reasoning from.
   */
  reasoningMetadata(source, entry, providers = this.providersSnapshot()) {
    const efforts = entry?.reasoningEfforts
    if (efforts === false) return undefined
    const ids = efforts === undefined || efforts === null
      ? DEFAULT_REASONING_EFFORTS
      : Object.keys(efforts)
    if (ids.length === 0) return undefined
    const sourceReasoning = providers[source]?.reasoning
    return {
      efforts: ids.map(id => ({ id, name: `${id.charAt(0).toUpperCase()}${id.slice(1)}` })),
      ...sourceReasoning === undefined ? {} : { defaultEffort: sourceReasoning },
    }
  }

  async listModels(provider) {
    const providers = this.providersSnapshot()
    const { source } = this.routeFor(provider, providers)
    const sourceProvider = providers[source] ?? {}
    return (sourceProvider.models ?? []).map(entry => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      inputModalities: resolveModelInput(sourceProvider, source, entry.id),
    }))
  }

  async prepareCall(provider, model) {
    const providers = this.providersSnapshot()
    return {
      model: this.resolveModelFromSnapshot(provider, model, providers),
      stream: options => this.streamWithSnapshot(options, providers),
    }
  }

  async * stream(options) {
    yield* this.streamWithSnapshot(options, this.providersSnapshot())
  }

  async * streamWithSnapshot(options, providers) {
    const { source } = this.routeFor(options.provider, providers)
    const provider = providers[source] ?? {}
    if (options.sessionId === undefined) {
      throw new LlmError(
        `@banbolee/dsh-llm-pi-ai-with-session: provider route "${options.provider}" requires a request session id`,
        'INVALID_REQUEST',
      )
    }
    const apiKey = await this.resolveApiKey(provider.apiKeyEnv)
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        `@banbolee/dsh-llm-pi-ai-with-session: no API key for provider route "${options.provider}"`
        + ` (mirrors llm-pi-ai provider "${source}"); set ${provider.apiKeyEnv ?? '<none>'} through the harness`
        + ' credentials service or in the environment',
        'MISSING_CREDENTIAL',
      )
    }
    const entry = provider.models?.find(candidate => candidate.id === options.model)
    const model = buildModel(providers, source, options.model, thinkingLevelMapFromSource(entry))
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage) assertSupportedImageRoles(options.messages)
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`@banbolee/dsh-llm-pi-ai-with-session: model "${model.id}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? this.ctx?.get?.('attachments') : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError(
        '@banbolee/dsh-llm-pi-ai-with-session: image input requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    const context = await toContext(
      options,
      attachments === undefined ? undefined : imageContext(provider, attachments, this.ctx?.get?.('fs')),
    )
    const streamIdleTimeoutMs = provider.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    const events = streamSimple(model, context, {
      apiKey,
      sessionId: String(options.sessionId),
      headers: requestHeaders(provider, this.config.sessionHeader, options.sessionId),
      maxRetries: 0,
      signal: watchdog.signal,
      ...provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort },
    })
    const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
        if (timeout !== undefined) throw timeout
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(
          `llm-pi-ai-with-session: stream idle timeout after ${streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('llm-pi-ai-with-session: request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('llm-pi-ai-with-session stream consumer stopped')
      if (!exhausted) {
        try {
          await iterator.return(undefined)
        } catch {
          // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
        }
      }
      watchdog[Symbol.dispose]()
    }
  }
}
