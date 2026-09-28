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
 * One model entry in a mirrored provider profile: only the fields this plugin
 * reads.
 * @typedef {object} ProviderModelProfile
 * @property {string} id - model id served by the source route.
 * @property {string} [name] - human-readable model name.
 * @property {number} [contextWindow] - source-declared context capacity.
 * @property {number} [maxTokens] - source-declared output cap.
 * @property {Array<import('@deepseek-ai/dsh-llm').ModelModality>} [input] - declared input modalities, when the profile states them.
 * @property {any} [reasoningEfforts] - source-declared level → wire spelling map, or `false`.
 */

/**
 * One mirrored llm-pi-ai provider profile, as far as this plugin reads it.
 * @typedef {object} ProviderProfile
 * @property {string} [apiKeyEnv] - credential reference or environment variable holding the API key.
 * @property {string} [baseURL] - gateway base URL inherited by the route.
 * @property {string} [displayName] - human-readable provider name.
 * @property {Record<string, string | null>} [headers] - deployment headers merged beside the session header.
 * @property {Array<import('@deepseek-ai/dsh-llm').ModelModality>} [defaultInput] - provider-wide default input modalities.
 * @property {string} [reasoning] - default reasoning effort.
 * @property {number} [maxRequestImageBytes] - base64 request bound that triggers IMAGE_OFFLOAD_REQUIRED.
 * @property {number} [requestImagePixelBudget] - total-pixel budget per request image.
 * @property {number} [requestImageMaxBytes] - encoded-byte target per request image.
 * @property {number} [timeoutMs] - provider-level request timeout forwarded to pi-ai.
 * @property {number} [streamIdleTimeoutMs] - provider-idle interval enforced while a stream read is outstanding.
 * @property {import('@deepseek-ai/dsh-llm').RetryPolicyConfig} [retryPolicy] - provider-owned model-request retry policy.
 * @property {ProviderModelProfile[]} [models] - served model catalog.
 */

/**
 * Exact request-version target of one durable image: aspect-preserving integer
 * dimensions within the route's pixel budget, plus the encoded-byte target.
 * @typedef {{ width: number, height: number, maxBytes: number }} RequestImageTarget
 */

/**
 * Durable attachment service surface request-image preparation consumes.
 * Structurally declared because this plugin takes no direct `dsh-attachment`
 * dependency: occurrences the surface marked offloaded are never read.
 * @typedef {object} RequestImageReader
 * @property {(ref: any, target: RequestImageTarget, signal?: AbortSignal) => Promise<any>} readImageRequest
 * @property {(ref: any) => string | undefined} [imageHostPath]
 */

/**
 * Image conversion inputs for one request, resolved from the mirrored source
 * provider profile.
 * @typedef {object} ImageRequestContext
 * @property {RequestImageReader} attachments
 * @property {(ref: any) => { readonlyPath: string } | undefined} resolveImageAccess
 * @property {number | undefined} maxRequestImageBytes
 * @property {{ maxPixels: number, maxBytes: number }} requestImagePolicy
 */

/**
 * Catalog-declared input modalities for one mirrored source model, when the
 * installed pi-ai catalog knows the pair. The compat `getModel` is generated
 * with a literal provider/model catalog, so an arbitrary mirrored pair is
 * looked up through a loose call; an unknown pair yields nothing at runtime.
 * @param {string} source - mirrored source provider name.
 * @param {string} modelId - requested model id.
 * @returns {readonly ('text' | 'image')[] | undefined} catalog modalities, or undefined when the catalog does not know the pair.
 */
function catalogModelInput(source, modelId) {
  const lookup = /** @type {(provider: string, model: string) => { input?: readonly ('text' | 'image')[] } | undefined} */ (
    /** @type {unknown} */ (getModel)
  )
  return lookup(source, modelId)?.input
}

/**
 * Resolve effective model modalities from the source facts this wrapper
 * supports: a non-empty model declaration wins, then the installed catalog
 * entry, then the provider default, with text as the conservative floor.
 * @param {ProviderProfile} provider - source provider profile.
 * @param {string} source - mirrored source provider name.
 * @param {string} modelId - requested model id.
 * @returns {import('@deepseek-ai/dsh-llm').ModelModality[]} a detached effective modality list.
 */
export function resolveModelInput(provider, source, modelId) {
  const entry = provider.models?.find(model => model.id === modelId)
  if (Array.isArray(entry?.input) && entry.input.length > 0) return [...entry.input]
  const catalogInput = catalogModelInput(source, modelId)
  if (Array.isArray(catalogInput) && catalogInput.length > 0) return [...catalogInput]
  if (Array.isArray(provider.defaultInput) && provider.defaultInput.length > 0) return [...provider.defaultInput]
  return ['text']
}

/**
 * Build the pi-ai model descriptor for one mirrored source entry.
 * @param {Record<string, ProviderProfile> | undefined} providers - the source providers table (static or the latest settings snapshot), keyed by source provider.
 * @param {string} source - mirrored source provider name.
 * @param {string} modelId - requested model id.
 * @param {import('@earendil-works/pi-ai').ThinkingLevelMap | undefined} thinkingLevelMap - resolved pi-ai reasoning-level map.
 * @returns {import('@earendil-works/pi-ai').Model<'openai-completions'>} the model descriptor consumed by pi-ai.
 */
export function buildModel(providers, source, modelId, thinkingLevelMap) {
  const provider = providers?.[source] ?? {}
  const entry = provider.models?.find(model => model.id === modelId)
  return {
    id: modelId,
    name: entry?.name ?? modelId,
    api: 'openai-completions',
    provider: source,
    // A profile may carry no gateway URL (llm-pi-ai leaves it optional for
    // catalog-backed providers); the route then dispatches without one, exactly
    // as it did before this file was type-checked.
    baseUrl: /** @type {string} */ (provider.baseURL),
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
 * @param {any} provider - source provider profile.
 * @param {string} sessionHeader - configured session header name.
 * @param {unknown} sessionId - current request session id.
 * @returns {Record<string, string>} request headers.
 */
export function requestHeaders(provider, sessionHeader, sessionId) {
  return {
    ...provider.headers,
    [sessionHeader]: String(sessionId),
    ...attributionHeaders(),
  }
}

/**
 * Aspect-preserving integer dimensions within a hard total-pixel budget.
 *
 * Mirrors `@deepseek-ai/dsh-attachment`'s `requestImageDimensions`: the target
 * must keep the canonical geometry so a request-image variant stays identical
 * to the one the native llm-pi-ai adapter derives from the same occurrence.
 * @param {number} width - positive source width.
 * @param {number} height - positive source height.
 * @param {number} maxPixels - positive width-times-height cap.
 * @returns {{ width: number, height: number }} inward-rounded dimensions; small images are not enlarged.
 */
function requestImageDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * Deterministic request target for one source under the route budgets.
 * @param {any} ref - durable normalized attachment reference.
 * @param {{ maxPixels: number, maxBytes: number }} policy - route pixel and encoded-byte budgets.
 * @returns {RequestImageTarget} the target the attachment service derives one request version for.
 */
export function requestImageTarget(ref, policy) {
  return {
    ...requestImageDimensions(ref.width, ref.height, policy.maxPixels),
    maxBytes: policy.maxBytes,
  }
}

/**
 * Resolve image projection limits from one source provider.
 * @param {any} provider - source provider profile.
 * @param {any} attachments - mounted durable attachment service.
 * @param {any} fs - mounted filesystem service, when it can map host paths.
 * @returns {ImageRequestContext} image conversion inputs for the current request.
 */
export function imageContext(provider, attachments, fs) {
  const resolveImageAccess = typeof attachments.imageHostPath === 'function'
    && typeof fs?.processPathFromHostPath === 'function'
    ? (/** @type {any} */ ref) => resolveImageAttachmentAccess(
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
