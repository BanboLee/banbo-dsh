#!/usr/bin/env node
import { createServer } from 'node:http'

const LSP_TITLE = '[LSP diagnostics after write]'

function writeSse(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function toolCallChunk(id, name, args) {
  return {
    id: 'qa',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  }
}

function finishChunk(reason) {
  return {
    id: 'qa',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(reason === 'stop'
      ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      : {}),
  }
}

export function createLoopbackServer(options = {}) {
  if (options.scenario !== undefined && options.scenario !== 'lsp-repair') {
    throw new TypeError(`unsupported loopback scenario: ${String(options.scenario)}`)
  }
  const records = []
  const toolIssued = new Set()
  const lsp = {
    acceptedTurnCount: 0,
    rejectedRequestCount: 0,
    badWriteIssued: false,
    diagnosticFeedbackSeen: false,
    repairIssued: false,
    cleanFeedbackSeen: false,
    terminalIssued: false,
    repairAfterDiagnostic: false,
    terminalAfterClean: false,
  }
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
      let parsed
      try {
        parsed = JSON.parse(body)
        const tools = Array.isArray(parsed.tools) ? parsed.tools : []
        record.toolNames = tools.flatMap((tool) => {
          const name = tool?.function?.name
          return typeof name === 'string' ? [name] : []
        })
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      records.push(record)
      if (options.scenario === 'lsp-repair') {
        const messages = JSON.stringify(parsed?.messages ?? [])
        const hasTitle = messages.includes(LSP_TITLE)
        if (lsp.acceptedTurnCount === 0) {
          lsp.acceptedTurnCount += 1
          lsp.badWriteIssued = true
          record.terminalStatus = 'tool_calls'
          writeSse(response, [
            toolCallChunk('qa-lsp-bad-write', 'write', {
              file_path: 'src/loopback-repair.ts',
              content: 'const value: number = "oops";\n',
            }),
            finishChunk('tool_calls'),
          ])
          return
        }
        if (lsp.acceptedTurnCount === 1 && hasTitle && messages.includes('TS2322')) {
          lsp.diagnosticFeedbackSeen = true
          lsp.repairAfterDiagnostic = lsp.diagnosticFeedbackSeen
          lsp.acceptedTurnCount += 1
          lsp.repairIssued = true
          record.terminalStatus = 'tool_calls'
          writeSse(response, [
            toolCallChunk('qa-lsp-repair-write', 'write', {
              file_path: 'src/loopback-repair.ts',
              content: 'const value: number = 2;\n',
            }),
            finishChunk('tool_calls'),
          ])
          return
        }
        if (lsp.acceptedTurnCount === 2 && hasTitle && messages.includes('Status: clean')) {
          lsp.cleanFeedbackSeen = true
          lsp.terminalAfterClean = lsp.cleanFeedbackSeen
          lsp.acceptedTurnCount += 1
          lsp.terminalIssued = true
          writeSse(response, [{
            id: 'qa',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: 'qa-ok' }, finish_reason: null }],
          }, finishChunk('stop')])
          return
        }
        lsp.rejectedRequestCount += 1
        response.writeHead(409, { 'content-type': 'application/json', connection: 'close' })
        response.end('{"error":"scenario feedback out of order"}')
        return
      }
      const affinityKey = record.affinity ?? `request-${records.length}`
      if (toolIssued.has(affinityKey)) {
        writeSse(response, [{
          id: 'qa',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'qa-ok' }, finish_reason: null }],
        }, finishChunk('stop')])
      } else {
        toolIssued.add(affinityKey)
        record.terminalStatus = 'tool_calls'
        writeSse(response, [
          toolCallChunk('qa-fish-call', 'fish', {
            command: 'printf qa-tool-ok',
            description: 'QA loopback tool',
          }),
          finishChunk('tool_calls'),
        ])
      }
    })
  })
  return {
    server,
    evidence: () => {
      if (options.scenario === 'lsp-repair') {
        const affinities = records.map((record) => record.affinity).filter((value) => value !== undefined)
        return {
          requestCount: records.length,
          ...lsp,
          headerPresent: records.length > 0 && affinities.length === records.length,
          sameSessionEqual: affinities.length >= 2 && affinities.every((value) => value === affinities[0]),
        }
      }
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
