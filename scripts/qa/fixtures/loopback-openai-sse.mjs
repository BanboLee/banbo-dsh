#!/usr/bin/env node
import { createServer } from 'node:http'

export function createLoopbackServer() {
  const records = []
  const toolIssued = new Set()
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const affinity = request.headers['x-session-affinity']
      const record = {
        affinity: typeof affinity === 'string' ? affinity : undefined,
        toolNames: [],
        terminalStatus: 'stop',
      }
      try {
        const parsed = JSON.parse(body)
        const tools = Array.isArray(parsed.tools) ? parsed.tools : []
        record.toolNames = tools.flatMap((tool) => {
          const name = tool?.function?.name
          return typeof name === 'string' ? [name] : []
        })
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      records.push(record)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      })
      const affinityKey = record.affinity ?? `request-${records.length}`
      if (toolIssued.has(affinityKey)) {
        response.write('data: {"id":"qa","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"qa-ok"},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"qa","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n')
      } else {
        toolIssued.add(affinityKey)
        record.terminalStatus = 'tool_calls'
        response.write('data: {"id":"qa","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"qa-fish-call","type":"function","function":{"name":"fish","arguments":"{\\"command\\":\\"printf qa-tool-ok\\",\\"description\\":\\"QA loopback tool\\"}"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"qa","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
      }
      response.end('data: [DONE]\n\n')
    })
  })
  return {
    server,
    evidence: () => {
      const affinities = records.map((record) => record.affinity).filter((value) => value !== undefined)
      return {
        requestCount: records.length,
        headerPresent: records.length > 0 && affinities.length === records.length,
        sameSessionEqual: affinities.length >= 2 && affinities[0] === affinities[1],
        differentSessionDifferent: new Set(affinities).size > 1,
        toolNames: [...new Set(records.flatMap((record) => record.toolNames))].sort(),
        terminalStatuses: records.map((record) => record.terminalStatus),
      }
    },
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const fixture = createLoopbackServer()
  fixture.server.listen(Number(process.env.QA_LOOPBACK_PORT), '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`)
  })
  const shutdown = () => {
    process.stdout.write(`${JSON.stringify({ evidence: fixture.evidence() })}\n`)
    fixture.server.close(() => process.exit(0))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
