/**
 * GenerateOptions → pi-ai Context conversion for the session wrapper adapter.
 *
 * @module dsh-llm-pi-ai-with-session/context
 */

import {
  contentHasImage,
  LlmError,
  offloadedImageText,
  offloadRequestImagesWithPolicy,
  requestImageHandleText,
} from '@deepseek-ai/dsh-llm'

/**
 * Join the text blocks of one harness message.
 * @param content - harness content blocks.
 * @returns the concatenated text.
 */
function flattenText(content) {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export function assertSupportedImageRoles(messages) {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `dsh-llm-pi-ai-with-session: image input is not supported in ${message.role} history`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

function collectImageRefs(content, refs) {
  for (const block of content) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

async function prepareRequestImages(messages, images, signal) {
  const refs = new Map()
  for (const message of messages) collectImageRefs(message.content, refs)
  const requestImages = new Map()
  await Promise.all([...refs.values()].map(async (ref) => {
    requestImages.set(
      ref.attachmentId,
      await images.attachments.readImageRequest(ref, images.requestImagePolicy, signal),
    )
  }))
  return requestImages
}

async function toPiUserContent(content, requestImages, resolveImageAccess) {
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
      continue
    }
    if (block.type === 'tool-result') {
      const nested = await toPiUserContent(block.content, requestImages, resolveImageAccess)
      if (typeof nested === 'string') {
        if (nested.length > 0) converted.push({ type: 'text', text: nested })
      } else {
        converted.push(...nested)
      }
    }
  }
  if (converted.every(block => block.type === 'text')) return converted.map(block => block.text).join('')
  return converted
}

/**
 * Reconstruct a pi-ai assistant message from durable harness content. The
 * harness keeps tool-call arguments as raw JSON strings; pi-ai wants them
 * parsed, so a malformed payload degrades to an empty object.
 * @param message - a harness assistant message.
 * @returns the pi-ai assistant message.
 */
function toPiAssistant(message) {
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
        throw new LlmError('dsh-llm-pi-ai-with-session: assistant image output is not supported', 'UNSUPPORTED_CONTENT')
      default:
        // Unknown merge-extensible block: not representable in pi-ai history.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-llm-pi-ai-with-session',
    provider: message.source?.provider ?? 'dsh-llm-pi-ai-with-session',
    model: message.source?.model ?? 'dsh-llm-pi-ai-with-session',
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
 * Convert one harness user message into pi-ai messages. Text goes into a
 * single user message; each tool result becomes its own toolResult message.
 * @param message - a harness user-role message.
 * @param toolNames - tool-call id → name map recovered from assistant turns.
 * @returns the pi-ai messages.
 */
async function toPiUserMessages(message, toolNames, requestImages, resolveImageAccess) {
  const results = message.content.filter(block => block.type === 'tool-result')
  const regular = message.content.filter(block => block.type !== 'tool-result')
  const messages = []
  const content = await toPiUserContent(regular, requestImages, resolveImageAccess)
  if (content.length > 0 || results.length === 0) {
    messages.push({ role: 'user', content, timestamp: 0 })
  }
  for (const result of results) {
    const nested = await toPiUserContent(result.content, requestImages, resolveImageAccess)
    messages.push({
      role: 'toolResult',
      toolCallId: result.toolCallId,
      toolName: toolNames.get(result.toolCallId) ?? 'unknown',
      content: typeof nested === 'string'
        ? [{ type: 'text', text: nested || '(no output)' }]
        : nested,
      isError: result.isError ?? false,
      timestamp: 0,
    })
  }
  return messages
}

/**
 * Convert a harness request into the pi-ai Context vocabulary.
 *
 * Tool-call names are recovered from preceding assistant turns; the system
 * prompt travels through `options.system` (pi-ai's single `systemPrompt`
 * slot), and any in-history system messages are folded into user messages to
 * preserve order — the harness sends the system prompt via `options.system`.
 *
 * @param options - the harness request.
 * @param images - durable attachment service and request-image policy.
 * @returns the pi-ai context (`tools` omitted when the request declares none).
 */
export async function toContext(options, images) {
  assertSupportedImageRoles(options.messages)
  const requestMessages = images === undefined
    ? options.messages
    : offloadRequestImagesWithPolicy(options.messages, {
        representation: 'base64',
        ...images.maxRequestImageBytes === undefined ? {} : { maxBytes: images.maxRequestImageBytes },
        byteQuantum: 1,
        byteLength: ref => Math.min(ref.bytes, images.requestImagePolicy.maxBytes),
        placeholder: ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)),
      })
  const requestImages = images === undefined
    ? new Map()
    : await prepareRequestImages(requestMessages, images, options.signal)
  const exactMessages = images === undefined
    ? requestMessages
    : offloadRequestImagesWithPolicy(requestMessages, {
        representation: 'base64',
        ...images.maxRequestImageBytes === undefined ? {} : { maxBytes: images.maxRequestImageBytes },
        byteQuantum: 1,
        byteLength: ref => requestImages.get(ref.attachmentId).bytes,
        placeholder: ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)),
      })
  const toolNames = new Map()
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
    messages.push(...await toPiUserMessages(message, toolNames, requestImages, images?.resolveImageAccess))
  }
  const context = {
    ...options.system === undefined ? {} : { systemPrompt: options.system },
    messages,
  }
  const tools = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  if (tools !== undefined && tools.length > 0) context.tools = tools
  return context
}
