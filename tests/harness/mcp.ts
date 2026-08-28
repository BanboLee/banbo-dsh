import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { connectMcp, isRecord } from '../helpers/mcp'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeMcp = join(root, 'tests/fixtures/fake-mcp-server.mjs')

function requireResult(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.result
  if (isRecord(result)) return result
  throw new Error('MCP response result must be a JSON object')
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
