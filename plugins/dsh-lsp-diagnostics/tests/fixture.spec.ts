import { afterEach, describe, expect, it } from 'vitest'
import { FakeLspClient, makeTempDir, readLogLines, spawnFakeLspServer, type LspMessage } from './helpers.js'

const WORKSPACE_URI = 'file:///workspace/src/a.ts'
const OTHER_URI = 'file:///workspace/src/other.ts'

interface FixtureHarness {
  readonly client: FakeLspClient
  readonly logPath: string
  readonly cleanup: () => void
}

const harnesses: FixtureHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.client.kill()
    harness.cleanup()
  }
})

function startServer(mode: string, log = true): FixtureHarness {
  const dir = makeTempDir('fake-lsp-')
  const logPath = log ? `${dir.dir}/events.log` : ''
  const client = new FakeLspClient(spawnFakeLspServer(mode, logPath || undefined))
  const harness = { client, logPath, cleanup: dir.cleanup }
  harnesses.push(harness)
  return harness
}

async function initialize(client: FakeLspClient): Promise<LspMessage> {
  await client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: null,
      rootUri: 'file:///workspace',
      capabilities: {},
      workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
    },
  })
  return client.next()
}

async function initialized(client: FakeLspClient): Promise<void> {
  await client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
}

async function didOpen(client: FakeLspClient, uri = WORKSPACE_URI, version = 1, text = ''): Promise<void> {
  await client.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'typescript', version, text } },
  })
}

async function didClose(client: FakeLspClient, uri = WORKSPACE_URI): Promise<void> {
  await client.send({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri } },
  })
}

async function shutdown(client: FakeLspClient): Promise<LspMessage> {
  await client.send({ jsonrpc: '2.0', id: 2, method: 'shutdown' })
  return client.next()
}

async function exit(client: FakeLspClient): Promise<number | null> {
  await client.send({ jsonrpc: '2.0', method: 'exit' })
  return client.waitForExit()
}

describe('fake LSP server', () => {
  it('push-versioned completes initialize/initialized and publishes versioned diagnostics', async () => {
    const { client } = startServer('push-versioned')
    const init = await initialize(client)
    expect(init.result).toMatchObject({ capabilities: { publishDiagnostics: { versionSupport: true } } })
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.method).toBe('textDocument/publishDiagnostics')
    expect(publish.params).toMatchObject({ uri: WORKSPACE_URI, version: 1 })
    const diagnostics = publish.params?.diagnostics as readonly unknown[]
    expect(diagnostics.length).toBe(2)
    await shutdown(client)
    await expect(exit(client)).resolves.toBe(0)
  })

  it('push-versionless publishes without a version field', async () => {
    const { client } = startServer('push-versionless')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.params).toMatchObject({ uri: WORKSPACE_URI })
    expect(publish.params).not.toHaveProperty('version')
  })

  it('clean publishes an explicit empty diagnostics array', async () => {
    const { client } = startServer('clean')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.params).toMatchObject({ uri: WORKSPACE_URI, version: 1, diagnostics: [] })
  })

  it('content-aware transitions the same uri from error text to explicit clean', async () => {
    const { client } = startServer('content-aware')
    await initialize(client)
    await initialized(client)
    await didOpen(client, WORKSPACE_URI, 1, 'const x: number = "oops";\n')
    const error = await client.next()
    expect(error.params).toMatchObject({ uri: WORKSPACE_URI, version: 1 })
    expect((error.params?.diagnostics as readonly unknown[])).not.toHaveLength(0)
    await didClose(client)
    await didOpen(client, WORKSPACE_URI, 2, 'const x: number = 1;\n')
    const clean = await client.next()
    expect(clean.params).toMatchObject({ uri: WORKSPACE_URI, version: 2, diagnostics: [] })
  })

  it('two-batches publishes a first batch then a replacing second batch', async () => {
    const { client } = startServer('two-batches')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const first = await client.next()
    const second = await client.next()
    expect(first.params).toMatchObject({ version: 1 })
    expect(second.params).toMatchObject({ version: 1 })
    expect((first.params?.diagnostics as readonly unknown[]).length).toBe(1)
    expect((second.params?.diagnostics as readonly unknown[]).length).toBe(2)
  })

  it('continuous keeps publishing the same version until didClose', async () => {
    const { client } = startServer('continuous')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const first = await client.next()
    const second = await client.next()
    expect(first.params).toMatchObject({ version: 1 })
    expect(second.params).toMatchObject({ version: 1 })
    await didClose(client)
    // Any publish already in flight before didClose landed may still arrive;
    // drain the pipe, then assert the server went quiet.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await client.next(150)
      } catch {
        break
      }
    }
    await expect(client.next(400)).rejects.toThrow()
  })

  it('delayed-old publishes the current version then an older version', async () => {
    const { client } = startServer('delayed-old')
    await initialize(client)
    await initialized(client)
    await didOpen(client, WORKSPACE_URI, 5)
    const current = await client.next()
    expect(current.params).toMatchObject({ version: 5 })
    const old = await client.next()
    expect(old.params).toMatchObject({ version: 4 })
  })

  it('cross-uri-same-version publishes another uri with the same version', async () => {
    const { client } = startServer('cross-uri-same-version')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.params).toMatchObject({ uri: OTHER_URI, version: 1 })
  })

  it('cross-uri-future-version publishes another uri with a future version', async () => {
    const { client } = startServer('cross-uri-future-version')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.params).toMatchObject({ uri: OTHER_URI, version: 2 })
  })

  it('cross-uri-malformed-diagnostics publishes malformed diagnostics on another uri', async () => {
    const { client } = startServer('cross-uri-malformed-diagnostics')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.params).toMatchObject({ uri: OTHER_URI })
    expect(Array.isArray(publish.params?.diagnostics)).toBe(false)
  })

  it('strict-diagnostic publishes a diagnostic with only consumed fields', async () => {
    const { client } = startServer('strict-diagnostic')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    const diagnostics = publish.params?.diagnostics as readonly Record<string, unknown>[]
    expect(diagnostics.length).toBe(1)
    expect(Object.keys(diagnostics[0] ?? {}).sort()).toEqual(['code', 'message', 'range', 'severity', 'source'])
  })

  it('diagnostic-standard-optionals carries tags/relatedInformation/codeDescription/data', async () => {
    const { client } = startServer('diagnostic-standard-optionals')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    const diagnostics = publish.params?.diagnostics as readonly Record<string, unknown>[]
    expect(diagnostics[0]).toMatchObject({
      tags: expect.any(Array),
      relatedInformation: expect.any(Array),
      codeDescription: expect.any(Object),
      data: expect.any(Object),
    })
  })

  it('diagnostic-unknown-extension carries unknown extension fields', async () => {
    const { client } = startServer('diagnostic-unknown-extension')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    const diagnostics = publish.params?.diagnostics as readonly Record<string, unknown>[]
    expect(diagnostics[0]).toHaveProperty('x-extension')
  })

  it('diagnostic-invalid-consumed-field publishes an invalid consumed field', async () => {
    const { client } = startServer('diagnostic-invalid-consumed-field')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    const diagnostics = publish.params?.diagnostics as readonly Record<string, unknown>[]
    const range = diagnostics[0]?.range as Record<string, unknown> | undefined
    expect(range).toBeDefined()
    expect(range?.start).toBeUndefined()
  })

  it('diagnostic-controls publishes control characters and a lone surrogate', async () => {
    const { client } = startServer('diagnostic-controls')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    const diagnostics = publish.params?.diagnostics as readonly Record<string, unknown>[]
    const message = String(diagnostics[0]?.message)
    expect(message).toContain('\r\n')
    expect(message).toContain('\u2028')
    expect(message).toContain('\u2029')
    expect(message).toMatch(/[\u0000-\u001f]/)
    expect(message).toContain('\ud800')
  })

  it('timeout never publishes but serves shutdown', async () => {
    const { client } = startServer('timeout')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    await expect(client.next(400)).rejects.toThrow()
    await shutdown(client)
    await expect(exit(client)).resolves.toBe(0)
  })

  it('hang-initialize never answers initialize', async () => {
    const { client } = startServer('hang-initialize')
    await client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await expect(client.next(400)).rejects.toThrow()
  })

  it('crash exits non-zero after the initialize handshake', async () => {
    const { client } = startServer('crash')
    await initialize(client)
    await expect(client.waitForExit()).resolves.not.toBe(0)
  })

  it('malformed sends garbage instead of a valid initialize response', async () => {
    const { client } = startServer('malformed')
    await client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await expect(client.next(400)).rejects.toThrow()
  })

  it('server-requests issues configuration/lifecycle/applyEdit/unsupported and records responses', async () => {
    const { client, logPath } = startServer('server-requests')
    await initialize(client)
    await initialized(client)
    const methods: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const request = await client.next()
      const method = request.method ?? ''
      methods.push(method)
      if (method === 'workspace/configuration') {
        const items = (request.params?.items as readonly unknown[] | undefined) ?? []
        await client.send({ jsonrpc: '2.0', id: request.id, result: items.map(() => ({})) })
      } else if (method === 'window/workDoneProgress/create' || method === 'client/registerCapability' || method === 'client/unregisterCapability') {
        await client.send({ jsonrpc: '2.0', id: request.id, result: null })
      } else {
        await client.send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `method not found: ${method}` } })
      }
    }
    expect(methods).toEqual([
      'workspace/configuration',
      'window/workDoneProgress/create',
      'client/registerCapability',
      'client/unregisterCapability',
      'workspace/applyEdit',
      'custom/unsupported',
    ])
    await didOpen(client)
    const publish = await client.next()
    expect(publish.method).toBe('textDocument/publishDiagnostics')
    const log = readLogLines(logPath)
    expect(log).toContain('response ok')
    expect(log).toContain('response error -32601')
  })

  it('close-stdin-after-diagnostics closes stdin after publishing', async () => {
    const { client, logPath } = startServer('close-stdin-after-diagnostics')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.method).toBe('textDocument/publishDiagnostics')
    const log = readLogLines(logPath)
    expect(log).toContain('close-stdin')
  })

  it('hang-shutdown never answers shutdown', async () => {
    const { client } = startServer('hang-shutdown')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.method).toBe('textDocument/publishDiagnostics')
    await client.send({ jsonrpc: '2.0', id: 2, method: 'shutdown' })
    await expect(client.next(400)).rejects.toThrow()
  })

  it('graceful-order records the full lifecycle sequence', async () => {
    const { client, logPath } = startServer('graceful-order')
    await initialize(client)
    await initialized(client)
    await didOpen(client)
    const publish = await client.next()
    expect(publish.method).toBe('textDocument/publishDiagnostics')
    await didClose(client)
    await shutdown(client)
    await expect(exit(client)).resolves.toBe(0)
    expect(readLogLines(logPath)).toEqual([
      'initialize',
      'initialized',
      `didOpen ${WORKSPACE_URI} v1`,
      `publish ${WORKSPACE_URI} v1`,
      `didClose ${WORKSPACE_URI}`,
      'shutdown',
      'exit',
      'natural-close',
    ])
  })
})
