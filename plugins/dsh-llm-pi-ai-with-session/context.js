/**
 * GenerateOptions → pi-ai Context conversion for the session wrapper adapter.
 *
 * Image handling follows the harness request-image contract: an occurrence the
 * durable surface marked `offloaded` becomes deterministic placeholder text and
 * is never read, while retained occurrences that exceed the route's request
 * budget fail the call with `IMAGE_OFFLOAD_REQUIRED`, naming how many more of
 * the oldest occurrences must be offloaded — an adapter never offloads on its
 * own (dsh-compaction-image-offload records the decision and retries).
 *
 * @module @banbolee/dsh-llm-pi-ai-with-session/context
 */

import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import { requestImageTarget } from './model.js'

/**
 * Join the text blocks of one harness message.
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} content - harness content blocks.
 * @returns {string} the concatenated text.
 */
function flattenText(content) {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Reject image input in a history role pi-ai cannot represent. Tool results
 * are their own role since 0.1.7, so they carry images exactly like user
 * content does; the native dsh-llm-pi-ai adapter accepts the same two roles.
 * @param {readonly import('@deepseek-ai/dsh-llm').RequestMessage[]} messages - the request history.
 */
export function assertSupportedImageRoles(messages) {
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `@banbolee/dsh-llm-pi-ai-with-session: image input is not supported in ${message.role} history`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/**
 * Collect the durable image references one request must resolve, in message
 * order. An occurrence the surface already marked offloaded keeps its text
 * placeholder and is never read.
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} content - harness content blocks.
 * @param {Map<string, any>} refs - attachment-id → durable reference map to fill.
 */
function collectImageRefs(content, refs) {
  for (const block of content) {
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
  }
}

/**
 * Prepare the deterministic request version of every retained image. The
 * attachment service derives one version per attachment id under the route's
 * pixel and encoded-byte budgets.
 * @param {readonly import('@deepseek-ai/dsh-llm').RequestMessage[]} messages - the request history.
 * @param {import('./model.js').ImageRequestContext} images - image conversion inputs.
 * @param {AbortSignal | undefined} signal - request cancellation.
 * @returns {Promise<Map<string, any>>} attachment-id → request-image version.
 */
async function prepareRequestImages(messages, images, signal) {
  const refs = new Map()
  for (const message of messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const prepared = await Promise.all(orderedRefs.map(ref => images.attachments.readImageRequest(
    ref,
    requestImageTarget(ref, images.requestImagePolicy),
    signal,
  )))
  const requestImages = new Map()
  for (const [index, ref] of orderedRefs.entries()) requestImages.set(ref.attachmentId, prepared[index])
  return requestImages
}

/**
 * Convert one harness content list into pi-ai user content: text joins into a
 * single string, an image contributes its deterministic handle text plus the
 * inline base64 request version, and blocks pi-ai cannot represent are dropped.
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} content - harness content blocks.
 * @param {Map<string, any>} requestImages - attachment-id → request-image version.
 * @param {(ref: any) => { readonlyPath: string } | undefined} resolveImageAccess - current execution-world access resolver.
 * @returns {string | Array<import('@earendil-works/pi-ai').TextContent | import('@earendil-works/pi-ai').ImageContent>} the pi-ai content.
 */
function toPiUserContent(content, requestImages, resolveImageAccess) {
  /** @type {Array<import('@earendil-works/pi-ai').TextContent | import('@earendil-works/pi-ai').ImageContent>} */
  const converted = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) converted.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const image = requestImages.get(block.attachment.attachmentId)
      converted.push({
        type: 'text',
        text: requestImageHandleText(block.attachment, image, resolveImageAccess?.(block.attachment)),
      })
      converted.push({ type: 'image', data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType })
    }
  }
  if (converted.every(block => block.type === 'text')) return converted.map(block => block.text).join('')
  return converted
}

/**
 * Reconstruct a pi-ai assistant message from durable harness content. The
 * harness keeps tool-call arguments as raw JSON strings; pi-ai wants them
 * parsed, so a malformed payload degrades to an empty object.
 * @param {import('@deepseek-ai/dsh-llm').AssistantMessage} message - a durable assistant message.
 * @returns {import('@earendil-works/pi-ai').AssistantMessage} the pi-ai assistant message.
 */
function toPiAssistant(message) {
  /** @type {Array<import('@earendil-works/pi-ai').TextContent | import('@earendil-works/pi-ai').ThinkingContent | import('@earendil-works/pi-ai').ToolCall>} */
  const content = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        let argumentsParsed = {}
        try {
          const parsed = JSON.parse(block.arguments)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            argumentsParsed = parsed
          }
        } catch {
          // keep {}
        }
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: argumentsParsed })
        break
      }
      case 'image':
        // Defense in depth: the adapter already rejects image input up front;
        // an assistant image reaching here still fails loudly, never silently.
        throw new LlmError('@banbolee/dsh-llm-pi-ai-with-session: assistant image output is not supported', 'UNSUPPORTED_CONTENT')
      default:
        // Unknown merge-extensible block: not representable in pi-ai history.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    api: '@banbolee/dsh-llm-pi-ai-with-session',
    provider: message.source?.provider ?? '@banbolee/dsh-llm-pi-ai-with-session',
    model: message.source?.model ?? '@banbolee/dsh-llm-pi-ai-with-session',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/**
 * Convert one durable tool-role message into its pi-ai toolResult message.
 * @param {import('@deepseek-ai/dsh-llm').ToolResultMessage} message - a durable tool-result message.
 * @param {Map<string, string>} toolNames - tool-call id → name map recovered from assistant turns.
 * @param {Map<string, any>} requestImages - attachment-id → request-image version.
 * @param {(ref: any) => { readonlyPath: string } | undefined} resolveImageAccess - current execution-world access resolver.
 * @returns {import('@earendil-works/pi-ai').ToolResultMessage} the pi-ai tool result.
 */
function toPiToolResult(message, toolNames, requestImages, resolveImageAccess) {
  const nested = toPiUserContent(message.content, requestImages, resolveImageAccess)
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof nested === 'string'
      ? [{ type: 'text', text: nested || '(no output)' }]
      : nested,
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/**
 * Convert a harness request into the pi-ai Context vocabulary.
 *
 * Tool-call names are recovered from preceding assistant turns; the system
 * prompt travels through `options.system` (pi-ai's single `systemPrompt`
 * slot), and any in-history system messages are folded into user messages to
 * preserve order — the harness sends the system prompt via `options.system`.
 *
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - the harness request.
 * @param {import('./model.js').ImageRequestContext | undefined} images - durable attachment service and request-image budgets.
 * @returns {Promise<import('@earendil-works/pi-ai').Context>} the pi-ai context (`tools` omitted when the request declares none).
 */
export async function toContext(options, images) {
  assertSupportedImageRoles(options.messages)
  const resolveImageAccess = images?.resolveImageAccess ?? (() => undefined)
  const requestImages = images === undefined
    ? new Map()
    : await prepareRequestImages(options.messages, images, options.signal)
  if (images?.maxRequestImageBytes !== undefined) {
    const offloadImages = requiredImageOffload(options.messages, {
      representation: 'base64',
      maxBytes: images.maxRequestImageBytes,
    }, block => requestImages.get(block.attachment.attachmentId).bytes)
    if (offloadImages > 0) {
      throw new LlmError(
        `@banbolee/dsh-llm-pi-ai-with-session: request images exceed the ${images.maxRequestImageBytes}-byte`
        + ` base64 bound; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
  }
  const exactMessages = images === undefined
    ? options.messages
    : projectOffloadedImages(options.messages, ref => offloadedImageText(ref, resolveImageAccess(ref)))
  const toolNames = new Map()
  /** @type {import('@earendil-works/pi-ai').Message[]} */
  const messages = []
  for (const message of exactMessages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    if (message.role === 'tool') {
      messages.push(toPiToolResult(message, toolNames, requestImages, resolveImageAccess))
      continue
    }
    if (message.role === 'developer') {
      // The runtime strips developer messages for a route that declares no
      // toolUpdate; one reaching this adapter is not representable in pi-ai.
      throw new LlmError(
        '@banbolee/dsh-llm-pi-ai-with-session: developer messages are not representable in pi-ai history',
        'UNSUPPORTED_CONTENT',
      )
    }
    messages.push({
      role: 'user',
      content: toPiUserContent(message.content, requestImages, resolveImageAccess),
      timestamp: 0,
    })
  }
  const tools = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    ...options.system === undefined ? {} : { systemPrompt: options.system },
    messages,
    ...tools === undefined || tools.length === 0 ? {} : { tools },
  }
}
