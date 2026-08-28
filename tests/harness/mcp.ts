import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeMcp = join(root, 'tests/fixtures/fake-mcp-server.mjs')

interface McpConnection {
  readonly child: ChildProcess
  readonly request: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
  close(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireResult(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.result
  if (isRecord(result)) return result
  throw new Error('MCP response result must be a JSON object')
}

function connectMcp(script: string): McpConnection {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = child.stdout
  const stdin = child.stdin
  if (!stdout || !stdin) {
    throw new Error('MCP process must expose stdio pipes')
  }
  let buffer = ''
  const pending: Array<(line: string) => void> = []
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        const resolve = pending.shift()
        resolve?.(line)
      }
    }
  })
  return {
    child,
    request(req) {
      return new Promise((resolve, reject) => {
        pending.push((line) => {
          try {
            const value: unknown = JSON.parse(line)
            if (isRecord(value)) {
              resolve(value)
              return
            }
            reject(new Error('MCP response must be a JSON object'))
          } catch (error) {
            reject(error)
          }
        })
        stdin.write(`${JSON.stringify(req)}\n`)
      })
    },
    close() {
      child.kill()
    },
  }
}

describe('fake-mcp-server.mjs', () => {
  it('lists the echo_context tool through stdio MCP', async () => {
    const mcp = connectMcp(fakeMcp)
    try {
      await mcp.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'harness-test', version: '0.0.0' },
        },
      })
      const result = requireResult(await mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
      const tools = result.tools
      if (!Array.isArray(tools)) {
        throw new Error('MCP tools/list result must contain tools array')
      }
      const names = tools.map((tool) => (isRecord(tool) ? tool.name : undefined))
      expect(names).toContain('echo_context')
    } finally {
      mcp.close()
    }
  })

  it('calls echo_context and returns the deterministic codegraph-ok text', async () => {
    const mcp = connectMcp(fakeMcp)
    try {
      await mcp.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'harness-test', version: '0.0.0' },
        },
      })
      const result = requireResult(await mcp.request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo_context', arguments: {} },
      }))
      const content = result.content
      if (!Array.isArray(content)) {
        throw new Error('MCP tools/call result must contain content array')
      }
      const first = content[0]
      expect(isRecord(first) ? first.text : undefined).toBe('codegraph-ok')
    } finally {
      mcp.close()
    }
  })

  it('returns an isError result for an unknown tool', async () => {
    const mcp = connectMcp(fakeMcp)
    try {
      await mcp.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'harness-test', version: '0.0.0' },
        },
      })
      const result = requireResult(await mcp.request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      }))
      expect(result.isError).toBe(true)
    } finally {
      mcp.close()
    }
  })
})
