/**
 * pi-ai model descriptors and request metadata inherited by session routes.
 *
 * @module @banbolee/dsh-llm-pi-ai-with-session/model
 */

import { attributionHeaders, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { getModel } from '@earendil-works/pi-ai/compat'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 32_768
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Resolve effective model modalities from the source facts this wrapper
 * supports: a non-empty model declaration wins, then the installed catalog
 * entry, then the provider default, with text as the conservative floor.
 * @param provider - source provider profile.
 * @param source - mirrored source provider name.
 * @param modelId - requested model id.
 * @returns a detached effective modality list.
 */
export function resolveModelInput(provider, source, modelId) {
  const entry = provider.models?.find(model => model.id === modelId)
  if (Array.isArray(entry?.input) && entry.input.length > 0) return [...entry.input]
  const catalogInput = getModel(source, modelId)?.input
  if (Array.isArray(catalogInput) && catalogInput.length > 0) return [...catalogInput]
  if (Array.isArray(provider.defaultInput) && provider.defaultInput.length > 0) return [...provider.defaultInput]
  return ['text']
}

/**
 * Build the pi-ai model descriptor for one mirrored source entry.
 * @param providers - the source providers table (static or the latest
 * settings snapshot), keyed by source provider.
 * @param source - mirrored source provider name.
 * @param modelId - requested model id.
 * @param thinkingLevelMap - resolved pi-ai reasoning-level map.
 * @returns the model descriptor consumed by pi-ai.
 */
export function buildModel(providers, source, modelId, thinkingLevelMap) {
  const provider = providers?.[source] ?? {}
  const entry = provider.models?.find(model => model.id === modelId)
  return {
    id: modelId,
    name: entry?.name ?? modelId,
    api: 'openai-completions',
    provider: source,
    baseUrl: provider.baseURL,
    reasoning: thinkingLevelMap === undefined ? false : true,
    input: resolveModelInput(provider, source, modelId),
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    cost: NO_COST,
    contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}

/**
 * Merge deployment headers, the live session header, and Harness attribution.
 * @param provider - source provider profile.
 * @param sessionHeader - configured session header name.
 * @param sessionId - current request session id.
 * @returns request headers.
 */
export function requestHeaders(provider, sessionHeader, sessionId) {
  return {
    ...provider.headers,
    [sessionHeader]: String(sessionId),
    ...attributionHeaders(),
  }
}

/**
 * Resolve image projection limits from one source provider.
 * @param provider - source provider profile.
 * @param attachments - mounted durable attachment service.
 * @param fs - mounted filesystem service, when it can map host paths.
 * @returns image conversion inputs for the current request.
 */
export function imageContext(provider, attachments, fs) {
  const resolveImageAccess = typeof attachments.imageHostPath === 'function'
    && typeof fs?.processPathFromHostPath === 'function'
    ? ref => resolveImageAttachmentAccess(
        attachments,
        hostPath => fs.processPathFromHostPath(hostPath),
        ref,
      )
    : () => undefined
  return {
    attachments,
    resolveImageAccess,
    maxRequestImageBytes: provider.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePolicy: {
      maxPixels: provider.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
      maxBytes: provider.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    },
  }
}
