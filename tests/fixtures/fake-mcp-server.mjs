#!/usr/bin/env node
// Deterministic stdio MCP server exposing exactly one tool: echo_context.
// Never talks to a real CodeGraph daemon; never touches the network.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout (the same
// framing the @modelcontextprotocol SDK stdio transport uses when no
// Content-Length header is present).
//
// Supported methods:
//   initialize              -> protocol handshake
//   notifications/initialized (no response)
//   ping                    -> {}
//   tools/list              -> one tool: echo_context
//   tools/call echo_context -> { content: [{ type: "text", text: "codegraph-ok" }] }

import { createInterface } from 'node:readline'

const SERVER_INFO = { name: 'fake-codegraph', version: '0.0.0' }
const PROTOCOL_VERSION = '2024-11-05'
const ECHO_TOOL = {
  name: 'echo_context',
  description: 'Deterministically echo the codegraph context marker used by tests.',
  inputSchema: { type: 'object', properties: {} },
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handleRequest(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [ECHO_TOOL] } })
    return
  }
  if (method === 'tools/call') {
    if (params?.name === 'echo_context') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'codegraph-ok' }] },
      })
    } else {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `unknown tool: ${params?.name}` }],
          isError: true,
        },
      })
    }
    return
  }
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    // Ignore malformed inbound frames; the client is buggy.
    return
  }
  // Notifications carry no id and expect no response.
  if (message.id === undefined) return
  handleRequest(message)
})
