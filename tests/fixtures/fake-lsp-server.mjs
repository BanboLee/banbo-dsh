#!/usr/bin/env node
// Deterministic stdio Content-Length LSP server fixture for the
// @banbolee/dsh-lsp-diagnostics plugin tests. Never talks to a real language server;
// never touches the network.
//
// Usage: node tests/fixtures/fake-lsp-server.mjs <mode> [logPath]
//
// The server speaks Content-Length framed JSON-RPC 2.0 over stdin/stdout and
// appends one protocol event per line to `logPath` (when given) so tests can
// observe teardown and request/response ordering. Production code never
// depends on the log.
//
// Modes:
//   push-versioned, push-versionless, clean, content-aware,
//   two-batches, continuous, delayed-old,
//   cross-uri-same-version, cross-uri-future-version,
//   cross-uri-malformed-diagnostics,
//   strict-diagnostic, diagnostic-standard-optionals,
//   diagnostic-unknown-extension, diagnostic-invalid-consumed-field,
//   diagnostic-controls,
//   timeout, hang-initialize, crash, malformed,
//   server-requests, close-stdin-after-diagnostics, hang-shutdown,
//   graceful-order

import { appendFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'push-versioned'
const logPath = process.argv[3]

const WORKSPACE_URI = 'file:///workspace/src/a.ts'
const OTHER_URI = 'file:///workspace/src/other.ts'

function log(line) {
  if (logPath) appendFileSync(logPath, `${line}\n`, 'utf8')
}

let buffer = Buffer.alloc(0)
let continuousTimer = null
let continuousCount = 0

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function exitLater(code) {
  setTimeout(() => process.exit(code), 50)
}

const RANGE = { start: { line: 12, character: 4 }, end: { line: 12, character: 9 } }

const ERROR_DIAG = {
  range: RANGE,
  severity: 1,
  code: 'TS2322',
  source: 'typescript',
  message: "Type 'string' is not assignable to type 'number'.",
}

const WARNING_DIAG = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  severity: 2,
  code: 'TS6133',
  source: 'typescript',
  message: "'unused' is declared but its value is never read.",
}

function publish(params) {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params })
  log(`publish ${params.uri} ${params.version === undefined ? 'versionless' : `v${params.version}`}`)
}

function publishVersioned(uri, version, diagnostics) {
  publish({ uri, version, diagnostics })
}

function handleInitialize(id) {
  log('initialize')
  if (mode === 'hang-initialize') return
  if (mode === 'malformed') {
    log('malformed')
    process.stdout.write('Content-Length: 1\r\n\r\n{')
    exitLater(1)
    return
  }
  send({
    jsonrpc: '2.0',
    id,
    result: {
      capabilities: {
        positionEncoding: ['utf-16'],
        textDocumentSync: 1,
        publishDiagnostics: { versionSupport: true },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      serverInfo: { name: 'fake-lsp-server', version: '0.0.0' },
    },
  })
  if (mode === 'crash') {
    log('crash')
    exitLater(1)
  }
}

function handleInitialized() {
  log('initialized')
  if (mode !== 'server-requests') return
  const requests = [
    { method: 'workspace/configuration', params: { items: [{ section: 'lsp-diagnostics' }] } },
    { method: 'window/workDoneProgress/create', params: { token: 'fake-token' } },
    { method: 'client/registerCapability', params: { registrations: [] } },
    { method: 'client/unregisterCapability', params: { unregisterations: [] } },
    { method: 'workspace/applyEdit', params: { edit: {} } },
    { method: 'custom/unsupported', params: {} },
  ]
  requests.forEach((request, index) => {
    log(`request ${request.method}`)
    send({ jsonrpc: '2.0', id: 100 + index, ...request })
  })
}

function handleDidOpen(params) {
  const document = params?.textDocument ?? {}
  const uri = typeof document.uri === 'string' ? document.uri : WORKSPACE_URI
  const version = typeof document.version === 'number' ? document.version : 1
  const text = typeof document.text === 'string' ? document.text : ''
  log(`didOpen ${uri} v${version}`)
  log(`languageId ${typeof document.languageId === 'string' ? document.languageId : ''}`)
  const diagnostics = [ERROR_DIAG, WARNING_DIAG]
  switch (mode) {
    case 'content-aware':
      publishVersioned(uri, version, text.includes('"oops"') || text.includes('var x string = 1') ? diagnostics : [])
      break
    case 'push-versionless':
      publish({ uri, diagnostics: [ERROR_DIAG] })
      break
    case 'clean':
      publishVersioned(uri, version, [])
      break
    case 'two-batches':
      publishVersioned(uri, version, [ERROR_DIAG])
      setTimeout(() => publishVersioned(uri, version, diagnostics), 100)
      break
    case 'continuous':
      continuousTimer = setInterval(() => {
        continuousCount += 1
        if (continuousCount > 20) {
          clearInterval(continuousTimer)
          return
        }
        publishVersioned(uri, version, [ERROR_DIAG])
      }, 50)
      break
    case 'delayed-old':
      publishVersioned(uri, version, [ERROR_DIAG])
      setTimeout(() => publishVersioned(uri, version - 1, [WARNING_DIAG]), 200)
      break
    case 'cross-uri-same-version':
      publishVersioned(OTHER_URI, version, [ERROR_DIAG])
      break
    case 'cross-uri-future-version':
      publishVersioned(OTHER_URI, version + 1, [ERROR_DIAG])
      break
    case 'cross-uri-malformed-diagnostics':
      publish({ uri: OTHER_URI, version, diagnostics: 'not-an-array' })
      break
    case 'strict-diagnostic':
      publishVersioned(uri, version, [{ ...ERROR_DIAG, message: 'strict' }])
      break
    case 'diagnostic-standard-optionals':
      publishVersioned(uri, version, [{
        range: RANGE,
        severity: 3,
        code: 'O1',
        source: 'optionals',
        message: 'with optionals',
        tags: [1, 2],
        relatedInformation: [{ location: { uri, range: RANGE }, message: 'related' }],
        codeDescription: { href: 'https://example.com/o1' },
        data: { nested: true },
      }])
      break
    case 'diagnostic-unknown-extension':
      publishVersioned(uri, version, [{
        range: RANGE,
        severity: 4,
        code: 'U1',
        source: 'unknown',
        message: 'with unknown extension',
        'x-extension': { deep: true },
      }])
      break
    case 'diagnostic-invalid-consumed-field':
      publishVersioned(uri, version, [{
        range: { end: { line: 0, character: 1 } },
        severity: 1,
        code: 'B1',
        source: 'bad',
        message: 'range missing start',
      }])
      break
    case 'diagnostic-controls':
      publishVersioned(uri, version, [{
        range: RANGE,
        severity: 1,
        code: 'CTRL',
        source: 'controls',
        message: 'line1\r\nline2\rline3\u2028line4\u2029line5\u0001c0\u0085c1\u007fdel\ud800lone',
      }])
      break
    case 'timeout':
    case 'hang-initialize':
      break
    case 'close-stdin-after-diagnostics':
      publishVersioned(uri, version, [ERROR_DIAG])
      log('close-stdin')
      process.stdin.end()
      break
    default:
      publishVersioned(uri, version, diagnostics)
  }
}

function handleDidClose(params) {
  const uri = params?.textDocument?.uri ?? WORKSPACE_URI
  log(`didClose ${uri}`)
  if (continuousTimer !== null) {
    clearInterval(continuousTimer)
    continuousTimer = null
  }
}

function handleShutdown(id) {
  log('shutdown')
  if (mode === 'hang-shutdown') return
  send({ jsonrpc: '2.0', id, result: null })
}

function handleExit() {
  log('exit')
  if (continuousTimer !== null) {
    clearInterval(continuousTimer)
    continuousTimer = null
  }
  if (mode === 'graceful-order') {
    log('natural-close')
  }
  // Give pending stdout writes a tick to flush before the natural exit.
  setTimeout(() => process.exit(0), 20)
}

function handleResponse(message) {
  if (message.error !== undefined) {
    log(`response error ${message.error.code}`)
  } else {
    log('response ok')
  }
}

function dispatch(message) {
  if (typeof message !== 'object' || message === null) return
  if (message.id !== undefined && typeof message.method === 'string') {
    if (message.method === 'initialize') return handleInitialize(message.id)
    if (message.method === 'shutdown') return handleShutdown(message.id)
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
    return
  }
  if (typeof message.method === 'string') {
    if (message.method === 'initialized') return handleInitialized()
    if (message.method === 'textDocument/didOpen') return handleDidOpen(message.params)
    if (message.method === 'textDocument/didClose') return handleDidClose(message.params)
    if (message.method === 'exit') return handleExit()
    return
  }
  if (message.id !== undefined) return handleResponse(message)
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length: (\d+)/i.exec(header)
    if (match === null) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + length) return
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
    buffer = buffer.subarray(bodyStart + length)
    let message
    try {
      message = JSON.parse(body)
    } catch {
      continue
    }
    dispatch(message)
  }
})

process.stdin.on('end', () => {
  if (continuousTimer !== null) {
    clearInterval(continuousTimer)
    continuousTimer = null
  }
})
