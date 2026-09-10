/**
 * Session-header LLM adapter: a harness `LlmAdapter` that reuses pi-ai's
 * openai-completions wire implementation and stamps the live dsh session id
 * into a configurable request header.
 *
 * The adapter owns only configured routes; every request dispatches on the hit
 * route back to its source provider's gateway, credential, models, headers, and
 * reasoning defaults.
 *
 * @module dsh-llm-pi-ai-with-session/adapter
 */

import { contentHasImage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { assertSupportedImageRoles, toContext } from './context.js'
import { buildModel, imageContext, requestHeaders, resolveModelInput } from './model.js'
import { toStreamChunks } from './stream.js'

/** Reasoning efforts this adapter advertises by default, aligned with pi-ai ThinkingLevel. */
const DEFAULT_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

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

  routeFor(providerRoute) {
    const route = this.routeByName.get(providerRoute)
    if (route === undefined) {
      throw new LlmError(
        `dsh-llm-pi-ai-with-session: provider route "${String(providerRoute)}" is not configured`,
        'INVALID_REQUEST',
      )
    }
    if (this.config.providers?.[route.source] === undefined) {
      throw new LlmError(
        `dsh-llm-pi-ai-with-session: provider route "${providerRoute}" references missing llm-pi-ai provider "${route.source}"`,
        'INVALID_REQUEST',
      )
    }
    return route
  }

  providerInfo(provider) {
    const route = this.routeFor(provider)
    return { id: provider, name: route.displayName ?? this.config.providers?.[route.source]?.displayName ?? provider }
  }

  async resolveModel(provider, model) {
    const { source } = this.routeFor(provider)
    const entry = this.config.providers?.[source]?.models?.find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } },
      ...entry?.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens },
      inputModalities: resolveModelInput(this.config.providers?.[source] ?? {}, source, model),
      ...this.reasoningMetadata(source, entry) === undefined ? {} : { reasoning: this.reasoningMetadata(source, entry) },
    }
  }

  /**
   * The reasoning capability a route advertises, inherited from the mirrored
   * source provider: the default effort comes from the provider's `reasoning`,
   * and the offered levels from the source model's declared `reasoningEfforts`
   * (or the default list when the model declares none).
   * @param source - the mirrored source provider name.
   * @param entry - the mirrored source model entry, when one exists.
   */
  reasoningMetadata(source, entry) {
    const efforts = entry?.reasoningEfforts
    if (efforts === false) return undefined
    const ids = efforts === undefined || efforts === null
      ? DEFAULT_REASONING_EFFORTS
      : Object.keys(efforts)
    if (ids.length === 0) return undefined
    const sourceReasoning = this.config.providers?.[source]?.reasoning
    return {
      efforts: ids.map(id => ({ id, name: `${id.charAt(0).toUpperCase()}${id.slice(1)}` })),
      ...sourceReasoning === undefined ? {} : { defaultEffort: sourceReasoning },
    }
  }

  async listModels(provider) {
    const { source } = this.routeFor(provider)
    return (this.config.providers?.[source]?.models ?? []).map(entry => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      inputModalities: resolveModelInput(this.config.providers?.[source] ?? {}, source, entry.id),
    }))
  }

  async * stream(options) {
    const { source } = this.routeFor(options.provider)
    const provider = this.config.providers?.[source] ?? {}
    if (options.sessionId === undefined) {
      throw new LlmError(
        `dsh-llm-pi-ai-with-session: provider route "${options.provider}" requires a request session id`,
        'INVALID_REQUEST',
      )
    }
    const apiKey = await this.resolveApiKey(provider.apiKeyEnv)
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        `dsh-llm-pi-ai-with-session: no API key for provider route "${options.provider}"`
        + ` (mirrors llm-pi-ai provider "${source}"); set ${provider.apiKeyEnv ?? '<none>'} through the harness`
        + ' credentials service or in the environment',
        'MISSING_CREDENTIAL',
      )
    }
    const entry = provider.models?.find(candidate => candidate.id === options.model)
    const model = buildModel(this.config, source, options.model, thinkingLevelMapFromSource(entry))
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage) assertSupportedImageRoles(options.messages)
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`dsh-llm-pi-ai-with-session: model "${model.id}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? this.ctx?.get?.('attachments') : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError(
        'dsh-llm-pi-ai-with-session: image input requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    const context = await toContext(
      options,
      attachments === undefined ? undefined : imageContext(provider, attachments, this.ctx?.get?.('fs')),
    )
    const events = streamSimple(model, context, {
      apiKey,
      sessionId: String(options.sessionId),
      headers: requestHeaders(provider, this.config.sessionHeader, options.sessionId),
      maxRetries: 0,
      signal: options.signal,
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort },
    })
    yield* toStreamChunks(events, model.contextWindow)
  }
}
