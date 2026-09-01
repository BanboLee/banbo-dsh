/**
 * Test helpers for dsh-llm-session-header: a local openai-completions mock
 * gateway plus a context assembly that mounts LlmRuntime and the plugin.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { afterEach, vi } from 'vitest'
import sessionHeaderPlugin from '../index.js'

/** One plain user message with the given text. */
export function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }] satisfies ContentBlock[],
    source: { kind: 'user' },
  })
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
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, requests, headers }
}

export interface SessionHeaderHarnessConfig {
  /** Plugin config passed to the session-header plugin. */
  pluginConfig?: Record<string, unknown>
  /** Extra plugins to mount before the session-header plugin. */
  baseURL?: string
  /** Env var holding the api key; defaults to the plugin default. */
  apiKeyEnv?: string
}

export interface SessionHeaderHarness {
  ctx: Context
  /** Drain one stream call through ctx.llm and return the raw chunks. */
  stream: (options: Record<string, unknown>) => Promise<unknown[]>
}

/** Mount LlmRuntime + the session-header plugin and return a drain helper. */
export async function createHarness(config: SessionHeaderHarnessConfig = {}): Promise<SessionHeaderHarness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(sessionHeaderPlugin, {
    baseURL: config.baseURL,
    ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
    ...(config.pluginConfig === undefined ? {} : config.pluginConfig),
  })
  return {
    ctx,
    stream: async (options) => {
      const chunks: unknown[] = []
      for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
      return chunks
    },
  }
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
