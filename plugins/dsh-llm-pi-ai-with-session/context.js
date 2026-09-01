/**
 * GenerateOptions → pi-ai Context conversion for the session wrapper adapter.
 *
 * @module dsh-llm-pi-ai-with-session/context
 */

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
        throw new Error('dsh-llm-pi-ai-with-session: assistant image output is not supported')
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
function toPiUserMessages(message, toolNames) {
  const results = message.content.filter(block => block.type === 'tool-result')
  const regular = message.content.filter(block => block.type !== 'tool-result')
  const messages = []
  const text = flattenText(regular)
  if (text.length > 0 || results.length === 0) {
    messages.push({ role: 'user', content: text, timestamp: 0 })
  }
  for (const result of results) {
    const nested = flattenText(result.content)
    messages.push({
      role: 'toolResult',
      toolCallId: result.toolCallId,
      toolName: toolNames.get(result.toolCallId) ?? 'unknown',
      content: [{ type: 'text', text: nested || '(no output)' }],
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
 * @returns the pi-ai context (`tools` omitted when the request declares none).
 */
export function toContext(options) {
  const toolNames = new Map()
  const messages = []
  for (const message of options.messages) {
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
    messages.push(...toPiUserMessages(message, toolNames))
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
