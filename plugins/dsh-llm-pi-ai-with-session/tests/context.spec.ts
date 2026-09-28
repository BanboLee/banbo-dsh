/**
 * Direct coverage for the message-vocabulary conversion of
 * `@banbolee/dsh-llm-pi-ai-with-session/context`: tool-role results (their call
 * identity, recovered tool name, outcome, text, and images) and the developer
 * branch. The adapter-level specs drive the same code through a mock gateway;
 * these assertions pin the exact pi-ai shapes without a wire round-trip.
 */

import { describe, expect, it, vi } from 'vitest'
import { toContext } from '../context.js'
import { installGatewayHooks, mockGateway, stubApiKey, textEvents, toGenerateOptions, createHarness } from './helpers.js'

installGatewayHooks()

/** One assistant tool call whose result the tool-role message answers. */
const assistantCall = {
  role: 'assistant',
  content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/tmp/x"}' }],
  id: 'm-assistant',
  source: { kind: 'model', provider: 'demo-affinity', model: 'demo-model' },
}

/** One pi-ai toolResult message, read through a fixture-friendly shape. */
interface ToolResultView {
  role?: string
  toolCallId?: string
  toolName?: string
  content?: Array<{ type?: string, text?: string, data?: string, mimeType?: string }>
  isError?: boolean
  timestamp?: number
}

/** Convert one fixture request and return the pi-ai messages it produced. */
async function convert(messages: unknown[], images?: Parameters<typeof toContext>[1]): Promise<unknown[]> {
  const context = await toContext(toGenerateOptions({
    provider: 'demo-affinity',
    model: 'demo-model',
    messages,
  }), images)
  return context.messages
}

describe('@banbolee/dsh-llm-pi-ai-with-session tool-role conversion', () => {
  it('converts a tool result with its call identity, recovered tool name, and text', async () => {
    const messages = await convert([
      assistantCall,
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'file body' }],
        id: 'm-tool',
        source: { kind: 'tool', callId: 'call_1' },
      },
    ])

    expect(messages).toHaveLength(2)
    const tool = messages[1] as ToolResultView
    expect(tool.role).toBe('toolResult')
    expect(tool.toolCallId).toBe('call_1')
    // The name is recovered from the preceding assistant tool call, never
    // invented by the tool message itself.
    expect(tool.toolName).toBe('read')
    expect(tool.isError).toBe(false)
    expect(tool.content).toEqual([{ type: 'text', text: 'file body' }])
    expect(tool.timestamp).toBe(0)
  })

  it('keeps a failed outcome and degrades an unknown call to a placeholder', async () => {
    const messages = await convert([
      assistantCall,
      {
        role: 'tool',
        toolCallId: 'call_unknown',
        content: [{ type: 'text', text: '' }],
        isError: true,
        id: 'm-tool-failed',
        source: { kind: 'tool', callId: 'call_unknown' },
      },
    ])

    const tool = messages[1] as ToolResultView
    expect(tool.toolCallId).toBe('call_unknown')
    expect(tool.toolName).toBe('unknown')
    expect(tool.isError).toBe(true)
    expect(tool.content).toEqual([{ type: 'text', text: '(no output)' }])
  })

  it('carries an image from a tool result through the attachment service', async () => {
    const attachment = {
      attachmentId: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
      attachment,
      data: Uint8Array.of(7),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    }))

    const messages = await convert([
      assistantCall,
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [
          { type: 'text', text: 'screenshot:' },
          { type: 'image', attachment },
        ],
        id: 'm-tool-image',
        source: { kind: 'tool', callId: 'call_1' },
      },
    ], {
      attachments: { readImageRequest },
      resolveImageAccess: () => undefined,
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePolicy: { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 },
    })

    // Images ride in tool results exactly like user content: one deterministic
    // request version, read under the route's budgets.
    expect(readImageRequest).toHaveBeenCalledOnce()
    expect(readImageRequest).toHaveBeenCalledWith(attachment, {
      width: 1,
      height: 1,
      maxBytes: 1024 * 1024,
    }, undefined)
    const tool = messages[1] as ToolResultView
    expect(tool.role).toBe('toolResult')
    expect(tool.toolCallId).toBe('call_1')
    expect(tool.toolName).toBe('read')
    // Same order as user content: the author's text, then the deterministic
    // attachment handle for the occurrence, then the request version itself.
    expect(tool.content?.[0]).toEqual({ type: 'text', text: 'screenshot:' })
    expect(tool.content?.[1]).toMatchObject({ type: 'text' })
    expect(tool.content?.[1]?.text).toContain('request preview 1x1px')
    expect(tool.content?.[2]).toEqual({ type: 'image', data: 'Bw==', mimeType: 'image/png' })
  })

  it('rejects a developer message as unrepresentable in pi-ai history', async () => {
    await expect(convert([
      {
        role: 'developer',
        content: [{ type: 'tool-addition', toolName: 'read' }],
        id: 'm-developer',
        source: { kind: 'user' },
      },
    ])).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('never lets a developer message reach the wire on a routed call', async () => {
    // The runtime strips developer messages for a route that declares no
    // toolUpdate, so the explicitness of the branch above is a backstop rather
    // than something a live request hits.
    const gateway = await mockGateway([{ events: textEvents }])
    stubApiKey('DEEPSEEK_API_KEY', 'test-key')
    const { stream } = await createHarness({
      providers: {
        demo: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: gateway.url,
          models: [{ id: 'demo-model' }],
        },
      },
      routes: [{ route: 'demo-affinity', source: 'demo' }],
    })

    const chunks = await stream({
      provider: 'demo-affinity',
      model: 'demo-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], id: 'm-user', source: { kind: 'user' } },
        {
          role: 'developer',
          content: [{ type: 'text', text: 'developer note' }],
          id: 'm-developer-wire',
          source: { kind: 'user' },
        },
      ],
      sessionId: 'session-developer',
    })

    expect(gateway.headers).toHaveLength(1)
    expect(JSON.stringify(gateway.requests[0])).not.toContain('developer note')
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
    expect((finish as { reason?: { kind?: string } } | undefined)?.reason?.kind).toBe('stop')
  })
})
