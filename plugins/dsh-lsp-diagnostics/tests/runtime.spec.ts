import { EventEmitter } from 'node:events'
import { FsError } from '@deepseek-ai/dsh-fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeDiagnostic, DiagnosticsRuntime } from '../runtime.js'
import { DEFAULT_CONFIG } from './helpers.js'

// ---------------------------------------------------------------------------
// In-process fake subprocess + fake LSP server. The runtime only ever talks to
// these through the public `ctx.subprocess` / `ctx.fs` shapes; no real process
// and no production test hook is involved.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

interface SpawnSpec {
  argv: readonly string[]
  cwd: string
  stdio: unknown
  graceMs: number
  signal?: AbortSignal
  env?: Record<string, string>
}

interface FakeOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface FakeHandle {
  readonly pid: number
  readonly stdin: {
    write(chunk: Buffer, callback?: (error?: Error | null) => void): void
    on(event: 'error', listener: (error: Error) => void): void
    end(): void
  }
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
  readonly collected: Record<string, never>
  readonly done: Promise<FakeOutcome>
  readonly terminate: ReturnType<typeof vi.fn>
  readonly waitForExit: ReturnType<typeof vi.fn>
  lifetimeSignal?: AbortSignal
}

function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

const WORKSPACE_URI = 'file:///workspace/src/a.ts'
const OTHER_URI = 'file:///workspace/src/other.ts'

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

let handleCounter = 1000

class FakeServer {
  readonly events: string[] = []
  readonly responses: Json[] = []
  readonly received: Json[] = []
  readonly handle: FakeHandle
  doneSettled = false
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private stdinClosed = false
  private doneResolve!: (outcome: FakeOutcome) => void
  private doneReject!: (error: Error) => void
  private readonly opensByUri = new Map<string, number>()
  private readonly mode: string
  private continuousTimer: ReturnType<typeof setInterval> | undefined
  holdWriteAcks = false
  holdWriteAckAt: number | undefined
  private writeCount = 0
  private readonly pendingAcks: Array<(error?: Error | null) => void> = []
  spawnIndex = 0

  constructor(mode: string) {
    this.mode = mode
    const raw = new Promise<FakeOutcome>((resolve, reject) => {
      this.doneResolve = resolve
      this.doneReject = reject
    })
    this.done = raw.then(
      (outcome) => {
        this.doneSettled = true
        return outcome
      },
      (error: Error) => {
        this.doneSettled = true
        throw error
      },
    )
    this.handle = {
      pid: handleCounter++,
      stdin: {
        write: (chunk, callback) => {
          if (this.stdinClosed) {
            callback?.(new Error('EPIPE'))
            return
          }
          this.writeCount += 1
          // The write completes before the server can possibly respond, and the
          // server processes the frame on a later microtask (like real IPC).
          if (this.holdWriteAcks || this.writeCount === this.holdWriteAckAt) {
            this.pendingAcks.push(callback ?? (() => {}))
            queueMicrotask(() => this.feed(chunk))
            return
          }
          callback?.(null)
          queueMicrotask(() => this.feed(chunk))
        },
        on: (event, listener) => {
          if (event === 'error') this.stdinErrorListener = listener
        },
        end: () => {
          this.stdinClosed = true
        },
      },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      collected: {},
      done: this.done,
      terminate: vi.fn(() => this.onTerminate()),
      waitForExit: vi.fn(async () => true),
    }
  }

  private stdinErrorListener: ((error: Error) => void) | undefined
  readonly done: Promise<FakeOutcome>

  ackAll(error?: Error | null): void {
    for (const ack of this.pendingAcks.splice(0)) ack(error)
  }

  failStdin(error: Error): void {
    this.stdinClosed = true
    this.stdinErrorListener?.(error)
  }

  /** Outbound frames arrive on the next macrotask, like real IPC latency. */
  send(message: unknown): void {
    setTimeout(() => {
      this.handle.stdout.emit('data', encodeFrame(message))
    }, 0)
  }

  /** Deliver a frame synchronously (test-only, e.g. before a held write completes). */
  emitNow(message: unknown): void {
    this.handle.stdout.emit('data', encodeFrame(message))
  }

  publish(uri: string, version: number | undefined, diagnostics: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, ...(version === undefined ? {} : { version }), diagnostics },
    })
    this.events.push(`publish ${uri} ${version === undefined ? 'versionless' : `v${version}`}`)
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (match === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      let message: Json
      try {
        message = JSON.parse(body) as Json
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Json): void {
    this.received.push(message)
    const id = message.id
    const method = message.method
    if (typeof method === 'string') {
      if (method === 'initialize') return this.onInitialize(id as number)
      if (method === 'shutdown') return this.onShutdown(id as number)
      if (method === 'initialized') {
        this.events.push('initialized')
        if (this.mode === 'server-requests') this.sendServerRequests()
        return
      }
      if (method === 'textDocument/didOpen') {
        const document = (message.params as Json | undefined)?.textDocument as Json | undefined
        const uri = String(document?.uri ?? WORKSPACE_URI)
        const version = Number(document?.version ?? 1)
        this.events.push(`didOpen ${uri} v${version}`)
        this.onDidOpen(uri, version)
        return
      }
      if (method === 'textDocument/didClose') {
        const uri = String(((message.params as Json | undefined)?.textDocument as Json | undefined)?.uri ?? WORKSPACE_URI)
        this.events.push(`didClose ${uri}`)
        return
      }
      if (method === 'exit') {
        this.events.push('exit')
        if (this.mode !== 'hung-all') this.naturalClose()
        return
      }
      return
    }
    if (id !== undefined) {
      this.responses.push(message)
      this.events.push(message.error === undefined ? 'response ok' : `response error ${(message.error as Json).code}`)
    }
  }

  private sendServerRequests(): void {
    const requests: Array<[number, string, Json]> = [
      [100, 'workspace/configuration', { items: [{ section: 'a' }, { section: 'b' }] }],
      [101, 'window/workDoneProgress/create', { token: 'fake-token' }],
      [102, 'client/registerCapability', { registrations: [] }],
      [103, 'client/unregisterCapability', { unregisterations: [] }],
      [104, 'workspace/applyEdit', { edit: {} }],
      [105, 'custom/unsupported', {}],
    ]
    for (const [id, requestMethod, params] of requests) {
      this.events.push(`request ${requestMethod}`)
      this.send({ jsonrpc: '2.0', id, method: requestMethod, params })
    }
  }

  private onInitialize(id: number): void {
    this.events.push('initialize')
    if (this.mode === 'hang-initialize') return
    if (this.mode === 'malformed' || (this.mode === 'malformed-publish-once' && this.spawnIndex === 0)) {
      this.events.push('malformed')
      this.handle.stdout.emit('data', Buffer.from('this is not a content-length frame at all'))
      this.doneResolve({ exitCode: 1, signal: null })
      return
    }
    if (this.mode === 'initialize-error') {
      this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'initialize exploded' } })
      return
    }
    if (this.mode === 'both-result-error') {
      this.send({ jsonrpc: '2.0', id, result: { capabilities: {} }, error: { code: -32000, message: 'both' } })
      return
    }
    if (this.mode === 'no-jsonrpc') {
      this.send({ id, result: { capabilities: { publishDiagnostics: { versionSupport: true } } } })
      return
    }
    if (this.mode === 'bad-error-code') {
      this.send({ jsonrpc: '2.0', id, error: { code: 'x', message: 42 } })
      return
    }
    this.send({
      jsonrpc: '2.0',
      id,
      result: {
        capabilities: {
          positionEncoding: ['utf-16'],
          textDocumentSync: 1,
          publishDiagnostics: { versionSupport: true },
          workspace: { configuration: true, workspaceFolders: true },
        },
        serverInfo: { name: 'fake-lsp-server', version: '0.0.0' },
      },
    })
    if (this.mode === 'unknown-response-id') this.send({ jsonrpc: '2.0', id: 999, result: null })
    if (this.mode === 'crash' || (this.mode === 'crash-once' && this.spawnIndex === 0)) {
      this.events.push('crash')
      setTimeout(() => this.doneResolve({ exitCode: 1, signal: null }), 0)
    }
  }

  private onDidOpen(uri: string, version: number): void {
    const opens = (this.opensByUri.get(uri) ?? 0) + 1
    this.opensByUri.set(uri, opens)
    switch (this.mode) {
      case 'push-versionless':
        this.publish(uri, undefined, [ERROR_DIAG])
        break
      case 'clean':
        this.publish(uri, version, [])
        break
      case 'two-batches':
        this.publish(uri, version, [ERROR_DIAG])
        setTimeout(() => this.publish(uri, version, [ERROR_DIAG, WARNING_DIAG]), 100)
        break
      case 'continuous':
        this.continuousTimer = setInterval(() => this.publish(uri, version, [ERROR_DIAG]), 50)
        break
      case 'delayed-old':
        this.publish(uri, version, [ERROR_DIAG])
        setTimeout(() => this.publish(uri, version - 1, [WARNING_DIAG]), 200)
        break
      case 'cross-uri-same-version':
        this.publish(OTHER_URI, version, [ERROR_DIAG])
        break
      case 'cross-uri-future-version':
        this.publish(OTHER_URI, version + 1, [ERROR_DIAG])
        break
      case 'cross-uri-malformed-diagnostics':
        this.publish(OTHER_URI, version, 'not-an-array')
        break
      case 'strict-diagnostic':
        this.publish(uri, version, [{ ...ERROR_DIAG, message: 'strict' }])
        break
      case 'diagnostic-standard-optionals':
        this.publish(uri, version, [{
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
        this.publish(uri, version, [{
          range: RANGE,
          severity: 4,
          code: 'U1',
          source: 'unknown',
          message: 'with unknown extension',
          'x-extension': { deep: true },
        }])
        break
      case 'diagnostic-invalid-consumed-field':
        this.publish(uri, version, [{
          range: { end: { line: 0, character: 1 } },
          severity: 1,
          code: 'B1',
          source: 'bad',
          message: 'range missing start',
        }])
        break
      case 'diagnostic-controls':
        this.publish(uri, version, [{
          range: RANGE,
          severity: 1,
          code: 'CTRL',
          source: 'controls',
          message: 'line1\r\nline2\rline3\u2028line4\u2029line5\u0001c0\u0085c1\u007fdel\ud800lone',
        }])
        break
      case 'versioned-then-versionless':
        if (opens === 1) this.publish(uri, version, [ERROR_DIAG])
        else this.publish(uri, undefined, [WARNING_DIAG])
        break
      case 'malformed-publish':
      case 'malformed-publish-once':
        if (this.mode === 'malformed-publish' || this.spawnIndex === 0) {
          this.events.push('malformed-publish')
          this.handle.stdout.emit('data', Buffer.from('garbage after didOpen'))
          this.doneResolve({ exitCode: 1, signal: null })
        } else {
          this.publish(uri, version, [ERROR_DIAG])
        }
        break
      case 'close-stdin-after-diagnostics':
        this.publish(uri, version, [ERROR_DIAG])
        this.events.push('close-stdin')
        // The publish is delivered on a macrotask; fail stdin on the NEXT
        // macrotask so the runtime accepts the publication first.
        setTimeout(() => this.failStdin(new Error('EPIPE')), 0)
        break
      case 'future-version':
        this.publish(uri, version + 1, [ERROR_DIAG])
        break
      case 'crash':
        break
      case 'crash-once':
        // Only the first spawned instance crashes; healthy retries publish.
        if (this.spawnIndex === 0) break
        this.publish(uri, version, [ERROR_DIAG, WARNING_DIAG])
        break
      case 'timeout':
      case 'hang-initialize':
        break
      default:
        this.publish(uri, version, [ERROR_DIAG, WARNING_DIAG])
    }
  }

  private onShutdown(id: number): void {
    this.events.push('shutdown')
    if (this.mode === 'hang-shutdown' || this.mode === 'hung-all') return
    this.send({ jsonrpc: '2.0', id, result: null })
  }

  private naturalClose(): void {
    this.events.push('natural-close')
    this.doneResolve({ exitCode: 0, signal: null })
  }

  private onTerminate(): void {
    this.events.push('terminate')
    this.doneResolve({ exitCode: null, signal: 'SIGTERM' })
  }
}

interface FakeSubprocess {
  readonly resolveExecutable: ReturnType<typeof vi.fn>
  readonly spawn: ReturnType<typeof vi.fn>
}

interface FakeFs {
  readonly resolve: ReturnType<typeof vi.fn>
  readonly stat: ReturnType<typeof vi.fn>
  readonly contains: ReturnType<typeof vi.fn>
  readonly readBytes: ReturnType<typeof vi.fn>
  readonly processPath: ReturnType<typeof vi.fn>
  readonly fileUrl: ReturnType<typeof vi.fn>
}

type RuntimeConfig = ConstructorParameters<typeof DiagnosticsRuntime>[0]['config']

interface Harness {
  readonly fs: FakeFs
  readonly subprocess: FakeSubprocess
  readonly runtime: DiagnosticsRuntime
  readonly config: RuntimeConfig
  readonly servers: FakeServer[]
  readonly spawnSpecs: SpawnSpec[]
}

let harness: Harness | undefined

beforeEach(() => {
  handleCounter = 1000
  harness = undefined
})

afterEach(async () => {
  const current = harness
  harness = undefined
  if (current === undefined) return
  for (const server of current.servers) {
    if (!server.doneSettled) server.handle.terminate()
  }
  vi.useRealTimers()
  await current.runtime.dispose().catch(() => {})
})

function makeConfig(mode: string, overrides: Record<string, unknown> = {}): Harness['config'] {
  const config = structuredClone(DEFAULT_CONFIG) as Harness['config']
  config.servers.typescript = {
    command: 'fake-ts',
    args: [mode],
    env: {},
    configuration: { key: 'value' },
    initializationOptions: null,
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
  }
  config.servers.go = {
    command: 'fake-go',
    args: [mode],
    env: {},
    configuration: {},
    initializationOptions: null,
    extensionToLanguage: { '.go': 'go' },
  }
  return { ...config, ...overrides } as Harness['config']
}

function makeFs(overrides: Partial<FakeFs> = {}): FakeFs {
  return {
    resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
    stat: vi.fn(async () => ({ version: 'v1', type: 'file', size: 16 })),
    contains: vi.fn(() => true),
    readBytes: vi.fn(async () => Buffer.from('const x: number = 1', 'utf8')),
    processPath: vi.fn((target: { displayPath: string }) => target.displayPath),
    fileUrl: vi.fn((target: { displayPath: string }) => `file://${target.displayPath}`),
    ...overrides,
  }
}

function makeSubprocess(
  modes: string[] | ((index: number) => string),
  setup?: (server: FakeServer) => void,
): { subprocess: FakeSubprocess; servers: FakeServer[]; spawnSpecs: SpawnSpec[] } {
  const servers: FakeServer[] = []
  const spawnSpecs: SpawnSpec[] = []
  const spawn = vi.fn((spec: SpawnSpec) => {
    const index = spawn.mock.calls.length - 1
    const mode = typeof modes === 'function' ? modes(index) : modes[Math.min(index, modes.length - 1)] ?? 'push-versioned'
    const server = new FakeServer(mode)
    server.spawnIndex = index
    server.handle.lifetimeSignal = spec.signal
    setup?.(server)
    servers.push(server)
    spawnSpecs.push(spec)
    return server.handle
  })
  const resolveExecutable = vi.fn(async (command: string) => {
    if (command === 'missing-ts' || command === 'missing-go') throw new Error('ENOENT: server executable not found')
    return command
  })
  return { subprocess: { resolveExecutable, spawn }, servers, spawnSpecs }
}

function makeHarness(
  mode: string,
  overrides: Record<string, unknown> = {},
  fsOverrides: Partial<FakeFs> = {},
  setup?: (server: FakeServer) => void,
): Harness {
  const config = makeConfig(mode, { settleMs: 60, ...overrides })
  const fs = makeFs(fsOverrides)
  const { subprocess, servers, spawnSpecs } = makeSubprocess([mode], setup)
  const runtime = new DiagnosticsRuntime({ fs, subprocess, config })
  const current = { fs, subprocess, runtime, config, servers, spawnSpecs }
  harness = current
  return current
}

function target(displayPath = '/workspace/src/a.ts'): { targetKey: string; displayPath: string } {
  return { targetKey: displayPath, displayPath }
}

function candidate(targetValue = target()): { target: { targetKey: string; displayPath: string }; version: string; generation: number } {
  return { target: targetValue, version: 'v1', generation: 1 }
}

const WORKSPACE = { targetKey: 'ws', displayPath: '/workspace' }

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

type DiagnoseResult = Awaited<ReturnType<DiagnosticsRuntime['diagnose']>>

/** Narrow an ok outcome to its diagnostics ([] for any non-ok outcome). */
function okDiagnostics(outcome: DiagnoseResult): readonly unknown[] {
  return outcome.kind === 'ok' ? outcome.diagnostics : []
}

/** Let a no-publication diagnosis run, then abort it as the coordinator deadline would. */
async function diagnoseUntilAbort(h: Harness, value = candidate()): Promise<DiagnoseResult> {
  const controller = new AbortController()
  await vi.useFakeTimers()
  const promise = h.runtime.diagnose(value, WORKSPACE, controller.signal)
  await vi.advanceTimersByTimeAsync(200)
  controller.abort(new Error('deadline'))
  const outcome = await promise
  await vi.advanceTimersByTimeAsync(2_000)
  await vi.useRealTimers()
  return outcome
}

// ---------------------------------------------------------------------------

describe('dsh-lsp-diagnostics runtime pooling', () => {
  it('keeps provider and workspace sessions isolated in a two-level pool', async () => {
    const h = makeHarness('push-versioned')
    const tsA = await h.runtime.diagnose(candidate(target('/workspace/src/a.ts')), WORKSPACE, undefined)
    expect(tsA).toMatchObject({ kind: 'ok' })
    const go = await h.runtime.diagnose(candidate(target('/workspace/src/b.go')), WORKSPACE, undefined)
    expect(go).toMatchObject({ kind: 'ok' })
    const tsOtherWs = await h.runtime.diagnose(candidate(target('/other/src/a.ts')), { targetKey: 'ws2', displayPath: '/other' }, undefined)
    expect(tsOtherWs).toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(3)
    expect(h.spawnSpecs[0]?.argv[0]).toBe('fake-ts')
    expect(h.spawnSpecs[1]?.argv[0]).toBe('fake-go')
  })

  it('uses the opaque workspace targetKey as the inner pool key (:: never collides)', async () => {
    const h = makeHarness('push-versioned')
    const a = await h.runtime.diagnose(candidate(target('/w/src/a.ts')), { targetKey: 'a::b', displayPath: '/w' }, undefined)
    const b = await h.runtime.diagnose(candidate(target('/w/src/b.ts')), { targetKey: 'a', displayPath: '/w' }, undefined)
    const c = await h.runtime.diagnose(candidate(target('/w/src/c.ts')), { targetKey: 'a::', displayPath: '/w' }, undefined)
    expect(a.kind).toBe('ok')
    expect(b.kind).toBe('ok')
    expect(c.kind).toBe('ok')
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(3)
  })

  it('single-flights one session per workspace and serializes the full lifecycle', async () => {
    const h = makeHarness('push-versioned')
    const first = h.runtime.diagnose(candidate(target('/workspace/src/a.ts')), WORKSPACE, undefined)
    const second = h.runtime.diagnose(candidate(target('/workspace/src/b.ts')), WORKSPACE, undefined)
    await expect(first).resolves.toMatchObject({ kind: 'ok' })
    await expect(second).resolves.toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(1)
    expect(h.servers[0]?.events).toEqual([
      'initialize',
      'initialized',
      'didOpen file:///workspace/src/a.ts v1',
      'publish file:///workspace/src/a.ts v1',
      'didClose file:///workspace/src/a.ts',
      'didOpen file:///workspace/src/b.ts v1',
      'publish file:///workspace/src/b.ts v1',
      'didClose file:///workspace/src/b.ts',
    ])
  })

  it('cancels a queued diagnosis without reading or opening it', async () => {
    const h = makeHarness('two-batches', { settleMs: 300 })
    const queuedController = new AbortController()
    await vi.useFakeTimers()
    const first = h.runtime.diagnose(candidate(target('/workspace/src/a.ts')), WORKSPACE, undefined)
    const queued = h.runtime.diagnose(candidate(target('/workspace/src/b.ts')), WORKSPACE, queuedController.signal)
    queuedController.abort(new Error('caller aborted while queued'))
    await expect(queued).resolves.toMatchObject({ kind: 'stale' })
    await vi.advanceTimersByTimeAsync(600)
    await expect(first).resolves.toMatchObject({ kind: 'ok' })
    expect(h.fs.readBytes).toHaveBeenCalledTimes(1)
    expect(h.servers[0]!.events.some((event) => event.includes('/workspace/src/b.ts'))).toBe(false)
    await vi.useRealTimers()
  })

  it('serializes repeated opens of the same uri with monotonic versions', async () => {
    const h = makeHarness('push-versioned')
    const first = await h.runtime.diagnose(candidate(target('/workspace/src/a.ts')), WORKSPACE, undefined)
    const second = await h.runtime.diagnose(candidate(target('/workspace/src/a.ts')), WORKSPACE, undefined)
    expect(first).toMatchObject({ kind: 'ok', version: 1 })
    expect(second).toMatchObject({ kind: 'ok', version: 2 })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(1)
    expect(h.servers[0]?.events.filter((event) => event.startsWith('didOpen'))).toEqual([
      'didOpen file:///workspace/src/a.ts v1',
      'didOpen file:///workspace/src/a.ts v2',
    ])
  })

  it('spawns with the exact public spec shape and a lifetime signal, not the execution signal', async () => {
    const controller = new AbortController()
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, controller.signal)
    const spec = h.spawnSpecs[0]!
    expect(spec.argv).toEqual(['fake-ts', 'push-versioned'])
    expect(spec.cwd).toBe('/workspace')
    expect(spec.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } })
    expect(spec.graceMs).toBe(500)
    expect(spec.env).toEqual({})
    expect(spec.signal).toBeDefined()
    expect(spec.signal).not.toBe(controller.signal)
    expect(h.subprocess.resolveExecutable).toHaveBeenCalledWith('fake-ts', {}, controller.signal)
  })
})

describe('dsh-lsp-diagnostics runtime json-rpc', () => {
  it('sends the canonical initialize payload then awaits initialized before didOpen', async () => {
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    const events = server.events
    const initialized = events.indexOf('initialized')
    const didOpen = events.findIndex((event) => event.startsWith('didOpen'))
    expect(initialized).toBeGreaterThanOrEqual(0)
    expect(didOpen).toBeGreaterThan(initialized)
    const initialize = server.received.find((message) => message.method === 'initialize')
    expect(initialize).toMatchObject({
      jsonrpc: '2.0',
      params: {
        processId: null,
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        initializationOptions: null,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { versionSupport: true },
          },
        },
      },
    })
  })

  it('correlates numeric request ids and rejects error responses', async () => {
    const h = makeHarness('initialize-error')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
  })

  it('treats a response carrying both result and error as fatal', async () => {
    const h = makeHarness('both-result-error')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
  })

  it('treats a response without jsonrpc 2.0 as fatal', async () => {
    const h = makeHarness('no-jsonrpc')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
  })

  it('treats an error response without a numeric code and string message as fatal', async () => {
    const h = makeHarness('bad-error-code')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
  })

  it('ignores unknown response ids', async () => {
    const h = makeHarness('unknown-response-id')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
  })

  it('answers workspace/configuration with same-length items', async () => {
    const h = makeHarness('server-requests')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const configuration = h.servers[0]!.responses.find((response) => response.id === 100)
    expect(configuration?.result).toEqual([{ key: 'value' }, { key: 'value' }])
  })

  it('answers lifecycle no-op server requests with null and rejects applyEdit and unknown methods with -32601', async () => {
    const h = makeHarness('server-requests')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    for (const id of [101, 102, 103]) {
      const response = server.responses.find((entry) => entry.id === id)
      expect(response?.result, `id ${id}`).toBeNull()
    }
    for (const id of [104, 105]) {
      const response = server.responses.find((entry) => entry.id === id)
      expect(response?.error).toMatchObject({ code: -32601 })
    }
  })

  it('serializes every outbound frame through one write tail', async () => {
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(h.servers[0]!.events).toEqual([
      'initialize',
      'initialized',
      'didOpen file:///workspace/src/a.ts v1',
      'publish file:///workspace/src/a.ts v1',
      'didClose file:///workspace/src/a.ts',
    ])
  })
})

describe('dsh-lsp-diagnostics runtime uri and version correlation', () => {
  it('ignores cross-uri publications entirely, even with a matching version', async () => {
    const h = makeHarness('cross-uri-same-version')
    await expect(diagnoseUntilAbort(h)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'diagnostics unavailable',
    })
  })

  it('ignores cross-uri publications entirely, even with a future version', async () => {
    const h = makeHarness('cross-uri-future-version')
    await expect(diagnoseUntilAbort(h)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'diagnostics unavailable',
    })
  })

  it('ignores cross-uri malformed publications entirely without poisoning before the deadline', async () => {
    const h = makeHarness('cross-uri-malformed-diagnostics')
    await expect(diagnoseUntilAbort(h)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'diagnostics unavailable',
    })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps the latest batch for the current version and ignores older versions', async () => {
    const h = makeHarness('delayed-old', { settleMs: 300 })
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    await vi.advanceTimersByTimeAsync(400)
    const outcome = await promise
    expect(outcome).toMatchObject({ kind: 'ok', version: 1 })
    const diagnostics = okDiagnostics(outcome)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'TS2322' })
    await vi.useRealTimers()
  })

  it('treats a future version on the current uri as a fatal protocol failure', async () => {
    const h = makeHarness('future-version')
    // Same-call retry on a fresh instance also receives a future version, so the
    // diagnosis ends unavailable without publishing anything.
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('accepts a versionless first open and retires the session after close', async () => {
    const h = makeHarness('push-versionless')
    const first = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(first).toMatchObject({ kind: 'ok' })
    // The session was retired and torn down; the next diagnosis spawns a fresh process.
    const second = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(second).toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
    expect(h.servers[0]!.events).toContain('shutdown')
  })

  it('poisons a versionless publish when the same process re-opens the uri', async () => {
    const h = makeHarness('versioned-then-versionless')
    const first = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(first).toMatchObject({ kind: 'ok' })
    // The second open of the same uri receives a versionless publish: the session
    // is poisoned while still open (no didClose) and evicted. The same-call retry
    // recovers on a fresh instance.
    const second = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(second).toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
    const poisoned = h.servers[0]!
    expect(poisoned.events.filter((event) => event.startsWith('didOpen'))).toEqual([
      'didOpen file:///workspace/src/a.ts v1',
      'didOpen file:///workspace/src/a.ts v2',
    ])
    // Only the first (versioned) open closed; the poisoned v2 open never did.
    expect(poisoned.events.filter((event) => event.startsWith('didClose'))).toEqual([
      'didClose file:///workspace/src/a.ts',
    ])
    expect(poisoned.events).toContain('shutdown')
  })

  it('ignores publications arriving before the didOpen write completes', async () => {
    const h = makeHarness('timeout', { shutdownTimeoutMs: 100 }, {}, (server) => {
      server.holdWriteAckAt = 3 // initialize, initialized, then didOpen
    })
    const controller = new AbortController()
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, controller.signal)
    await vi.advanceTimersByTimeAsync(50)
    h.servers[0]!.emitNow({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: WORKSPACE_URI, version: 1, diagnostics: [ERROR_DIAG] },
    })
    h.servers[0]!.ackAll()
    await vi.advanceTimersByTimeAsync(200)
    controller.abort(new Error('deadline'))
    await expect(promise).resolves.toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    await vi.advanceTimersByTimeAsync(200)
    await vi.useRealTimers()
  })
})

describe('dsh-lsp-diagnostics runtime diagnostic normalization', () => {
  it('projects only consumed fields into the deeply frozen normalized schema', async () => {
    const h = makeHarness('strict-diagnostic')
    const outcome = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(outcome).toMatchObject({ kind: 'ok' })
    const diagnostic = okDiagnostics(outcome)[0] as Record<string, unknown> | undefined
    expect(diagnostic).toBeDefined()
    expect(Object.keys(diagnostic!).sort()).toEqual(['code', 'message', 'range', 'severity', 'severityRank', 'source', 'uri'])
    expect(Object.isFrozen(diagnostic)).toBe(true)
    const range = diagnostic!.range as { start: object; end: object }
    expect(Object.isFrozen(range)).toBe(true)
    expect(Object.isFrozen(range.start)).toBe(true)
    expect(Object.isFrozen(range.end)).toBe(true)
    expect(diagnostic).toMatchObject({
      uri: WORKSPACE_URI,
      range: { start: { line: 12, character: 4 }, end: { line: 12, character: 9 } },
      severity: 'error',
      severityRank: 0,
      code: 'TS2322',
      source: 'typescript',
      message: 'strict',
    })
  })

  it('safely ignores standard optional and unknown extension fields of any value', async () => {
    const h = makeHarness('diagnostic-standard-optionals')
    const outcome = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(outcome).toMatchObject({ kind: 'ok' })
    const diagnostic = okDiagnostics(outcome)[0] as Record<string, unknown> | undefined
    expect(diagnostic).toMatchObject({ code: 'O1', severity: 'info', severityRank: 2, message: 'with optionals' })
    expect(diagnostic).not.toHaveProperty('tags')
    expect(diagnostic).not.toHaveProperty('relatedInformation')
    expect(diagnostic).not.toHaveProperty('codeDescription')
    expect(diagnostic).not.toHaveProperty('data')
    const unknown = makeHarness('diagnostic-unknown-extension')
    const unknownOutcome = await unknown.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(unknownOutcome).toMatchObject({ kind: 'ok' })
    expect(okDiagnostics(unknownOutcome)[0]).not.toHaveProperty('x-extension')
  })

  it('never touches ignored fields even when they are hostile', () => {
    const hostile = {
      range: RANGE,
      severity: 1,
      code: 'H1',
      source: 'hostile',
      message: 'ok',
    }
    Object.defineProperty(hostile, 'tags', {
      enumerable: true,
      get() {
        throw new Error('must not read ignored fields')
      },
    })
    expect(() => normalizeDiagnostic(WORKSPACE_URI, hostile)).not.toThrow()
  })

  it('fails the publication on an invalid consumed field', async () => {
    const h = makeHarness('diagnostic-invalid-consumed-field')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
  })

  it('maps severity to tokens and ranks and defaults a missing severity to unknown', () => {
    for (const [severity, token, rank] of [[1, 'error', 0], [2, 'warning', 1], [3, 'info', 2], [4, 'hint', 3]] as const) {
      const diagnostic = normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, severity, code: 1, message: 'm' })
      expect(diagnostic).toMatchObject({ severity: token, severityRank: rank })
    }
    const missing = normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, message: 'm' })
    expect(missing).toMatchObject({ severity: 'unknown', severityRank: 4 })
    for (const invalid of [0, 5, 1.5, '1', null]) {
      expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, severity: invalid, message: 'm' }), String(invalid)).toThrow()
    }
  })

  it('validates range and position strictness, bounds, and ordering', () => {
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: null, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 0, character: 0 } }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 }, extra: 1 }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 0 }, end: { line: 1, character: 0 } }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: -1, character: 0 }, end: { line: 1, character: 0 } }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 0, character: 1.5 }, end: { line: 1, character: 0 } }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } }, message: 'm' })).toThrow()
    expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: -1 } }, message: 'm' })).toThrow()
  })

  it('validates code, source, and message types', () => {
    expect(normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, message: 'm' })).toMatchObject({ code: '', source: '' })
    expect(normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, code: 42, message: 'm' })).toMatchObject({ code: '42' })
    expect(normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, code: 'E1', source: 'src', message: 'm' })).toMatchObject({ code: 'E1', source: 'src' })
    for (const code of [1.5, Number.NaN, true, {}, []]) {
      expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, code, message: 'm' }), String(code)).toThrow()
    }
    for (const source of [1, null, {}]) {
      expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, source, message: 'm' }), String(source)).toThrow()
    }
    for (const message of [undefined, 1, null, {}]) {
      expect(() => normalizeDiagnostic(WORKSPACE_URI, { range: RANGE, message }), String(message)).toThrow()
    }
  })

  it('normalizes newlines and control characters to single-line safe text', async () => {
    const h = makeHarness('diagnostic-controls')
    const outcome = await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    expect(outcome).toMatchObject({ kind: 'ok' })
    expect(okDiagnostics(outcome)[0]).toMatchObject({
      message: 'line1 line2 line3 line4 line5\uFFFDc0\uFFFDc1\uFFFDdel\uFFFDlone',
    })
  })
})

describe('dsh-lsp-diagnostics runtime bounded read', () => {
  it('derives the canonical document uri once and reuses it for read and correlation', async () => {
    const h = makeHarness('push-versioned')
    const written = target()
    await expect(h.runtime.diagnose(candidate(written), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'ok',
      uri: WORKSPACE_URI,
    })
    expect(h.fs.fileUrl.mock.calls.filter(([value]) => value === written)).toHaveLength(1)
  })

  it('reads a document whose known size is exactly the cap', async () => {
    const fs = makeFs({ stat: vi.fn(async () => ({ version: 'v1', type: 'file', size: 16 })) })
    const h = makeHarness('push-versioned', { maxDocumentBytes: 16 }, fs)
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    expect(fs.readBytes).toHaveBeenCalledWith(expect.anything(), undefined, 16)
  })

  it('rejects a known size above the cap without calling readBytes and without spawning', async () => {
    const fs = makeFs({ stat: vi.fn(async () => ({ version: 'v1', type: 'file', size: 17 })) })
    const h = makeHarness('push-versioned', { maxDocumentBytes: 16 }, fs)
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'document too large',
    })
    expect(fs.readBytes).not.toHaveBeenCalled()
    expect(h.subprocess.spawn).not.toHaveBeenCalled()
  })

  it('reads an unknown-size document through readBytes', async () => {
    const fs = makeFs({ stat: vi.fn(async () => ({ version: 'v1', type: 'file' })) })
    const h = makeHarness('push-versioned', { maxDocumentBytes: 16 }, fs)
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    expect(fs.readBytes).toHaveBeenCalledWith(expect.anything(), undefined, 16)
  })

  it('maps an FsError with code FS_TOO_LARGE to document too large', async () => {
    const fs = makeFs({
      readBytes: vi.fn(async () => {
        throw new FsError('document too large', 'FS_TOO_LARGE')
      }),
    })
    const h = makeHarness('push-versioned', {}, fs)
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'document too large',
    })
  })

  it('maps any other read error to diagnostics unavailable', async () => {
    for (const error of [new FsError('permission', 'FS_PERMISSION_DENIED'), new Error('boom'), 'string error']) {
      const fs = makeFs({ readBytes: vi.fn(async () => { throw error }) })
      const h = makeHarness('push-versioned', {}, fs)
      await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'diagnostics unavailable',
      })
    }
  })

  it('treats a non-regular file as unavailable', async () => {
    for (const type of ['directory', 'other']) {
      const fs = makeFs({ stat: vi.fn(async () => ({ version: 'v1', type, size: 16 })) })
      const h = makeHarness('push-versioned', {}, fs)
      await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'diagnostics unavailable',
      })
    }
  })

  it('rejects invalid utf-8 as unavailable', async () => {
    const fs = makeFs({ readBytes: vi.fn(async () => Buffer.from([0xff, 0xfe, 0x80, 0x41])) })
    const h = makeHarness('push-versioned', {}, fs)
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'diagnostics unavailable',
    })
  })
})

describe('dsh-lsp-diagnostics runtime deadline and signals', () => {
  it('waits the quiet window and returns the latest accepted batch', async () => {
    const h = makeHarness('two-batches', { settleMs: 300 })
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    await vi.advanceTimersByTimeAsync(600)
    const outcome = await promise
    expect(outcome).toMatchObject({ kind: 'ok', version: 1 })
    expect(okDiagnostics(outcome)).toHaveLength(2)
    await vi.useRealTimers()
  })

  it('waits for the external deadline signal when no publication arrives', async () => {
    const h = makeHarness('timeout', { settleMs: 100, shutdownTimeoutMs: 100 })
    const controller = new AbortController()
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, controller.signal)
    let settled = false
    void promise.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(false)
    controller.abort(new Error('deadline'))
    await expect(promise).resolves.toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    await vi.advanceTimersByTimeAsync(200)
    await vi.useRealTimers()
  })

  it('never lets continuous notifications move the absolute deadline', async () => {
    const h = makeHarness('continuous', { settleMs: 200 })
    const controller = new AbortController()
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, controller.signal)
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    const outcome = await promise
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    // Let the evicted session's graceful teardown finish under fake time before
    // restoring real timers, so the afterEach dispose does not stall on it.
    await vi.advanceTimersByTimeAsync(2000)
    await vi.useRealTimers()
  })

  it('aborts promptly on caller abort and never terminates the process before graceful teardown', async () => {
    const h = makeHarness('timeout', { settleMs: 1000, shutdownTimeoutMs: 200 })
    const controller = new AbortController()
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, controller.signal)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    const outcome = await promise
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    expect(h.servers[0]!.handle.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(h.servers[0]!.events).toContain('shutdown')
    await vi.useRealTimers()
  })

  it('aborts a hung didClose write and escalates only through graceful teardown', async () => {
    const h = makeHarness('push-versioned', { settleMs: 60, shutdownTimeoutMs: 100 }, {}, (server) => {
      server.holdWriteAckAt = 4
    })
    const controller = new AbortController()
    await vi.useFakeTimers()
    const promise = h.runtime.diagnose(candidate(), WORKSPACE, controller.signal)
    await vi.advanceTimersByTimeAsync(200)
    let settled = false
    void promise.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    controller.abort(new Error('deadline'))
    await expect(promise).resolves.toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    expect(h.servers[0]!.handle.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(h.servers[0]!.handle.terminate).toHaveBeenCalledTimes(1)
    await vi.useRealTimers()
  })

  it('aborts during a hung initialize and lets the next diagnosis restart', async () => {
    const h = makeHarness('hang-initialize')
    const first = new AbortController()
    const p1 = h.runtime.diagnose(candidate(), WORKSPACE, first.signal)
    await vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(50)
    first.abort()
    await expect(p1).resolves.toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    // The evicted session is gone; the next diagnosis spawns a fresh instance.
    const second = new AbortController()
    const p2 = h.runtime.diagnose(candidate(), WORKSPACE, second.signal)
    await vi.advanceTimersByTimeAsync(50)
    second.abort()
    await expect(p2).resolves.toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
    // Let both evicted sessions' graceful teardowns finish under fake time.
    await vi.advanceTimersByTimeAsync(2000)
    await vi.useRealTimers()
  })

  it('returns stale for an already-aborted signal without spawning', async () => {
    const h = makeHarness('push-versioned')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, abortedSignal())).resolves.toMatchObject({ kind: 'stale' })
    expect(h.subprocess.spawn).not.toHaveBeenCalled()
  })
})

describe('dsh-lsp-diagnostics runtime transport failure, eviction, and restart', () => {
  it('retries once after stdin.write throws synchronously', async () => {
    const h = makeHarness('push-versioned', {}, {}, (server) => {
      if (server.spawnIndex === 0) {
        vi.spyOn(server.handle.stdin, 'write').mockImplementationOnce(() => {
          throw new Error('sync write failure')
        })
      }
    })
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('retries once on a fresh instance after a transport failure and succeeds', async () => {
    const h = makeHarness('malformed-publish-once')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('returns unavailable when the retry also fails', async () => {
    const h = makeHarness('malformed')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('returns unavailable without retry once publication was accepted and transport then failed', async () => {
    const h = makeHarness('close-stdin-after-diagnostics')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'malformed response',
    })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(1)
  })

  it('evicts an idle poisoned instance and restarts on the next diagnosis', async () => {
    const h = makeHarness('push-versioned')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    h.servers[0]!.failStdin(new Error('idle EPIPE'))
    await Promise.resolve()
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('evicts a crashed instance and restarts on the next diagnosis', async () => {
    const h = makeHarness('crash')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'server crashed',
    })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'server crashed',
    })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(4)
  })

  it('recovers from a one-time crash on the same call', async () => {
    const h = makeHarness('crash-once')
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'ok' })
    expect(h.subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('maps synchronous spawn failures to server crashed with one retry', async () => {
    const config = makeConfig('push-versioned')
    const fs = makeFs()
    const subprocess: FakeSubprocess = {
      resolveExecutable: vi.fn(async (command: string) => command),
      spawn: vi.fn(() => {
        throw new Error('spawn failed')
      }),
    }
    const runtime = new DiagnosticsRuntime({ fs, subprocess, config })
    harness = { fs, subprocess, runtime, config, servers: [], spawnSpecs: [] }
    await expect(runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'server crashed',
    })
    expect(subprocess.spawn).toHaveBeenCalledTimes(2)
  })

  it('maps resolveExecutable failures to server not found', async () => {
    const config = makeConfig('push-versioned')
    ;(config.servers.typescript as Record<string, unknown>).command = 'missing-ts'
    const fs = makeFs()
    const { subprocess, servers, spawnSpecs } = makeSubprocess(['push-versioned'])
    const runtime = new DiagnosticsRuntime({ fs, subprocess, config })
    harness = { fs, subprocess, runtime, config, servers, spawnSpecs }
    await expect(runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'server not found',
    })
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it('silently ignores unsupported extensions without spawning', async () => {
    const h = makeHarness('push-versioned')
    const outcome = await h.runtime.diagnose(candidate(target('/workspace/src/notes.txt')), WORKSPACE, undefined)
    expect(outcome).toMatchObject({ kind: 'stale' })
    expect(h.subprocess.spawn).not.toHaveBeenCalled()
  })
})

describe('dsh-lsp-diagnostics runtime unique graceful-first teardown', () => {
  it('follows the exact graceful teardown event order', async () => {
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    const order: string[] = []
    server.handle.lifetimeSignal?.addEventListener('abort', () => order.push('lifetime-abort'))
    void server.handle.done.then(() => order.push('done-settled'), () => order.push('done-settled'))
    await h.runtime.dispose()
    const events = server.events
    const shutdownIndex = events.indexOf('shutdown')
    const exitIndex = events.indexOf('exit')
    const naturalIndex = events.indexOf('natural-close')
    expect(shutdownIndex).toBeGreaterThanOrEqual(0)
    expect(exitIndex).toBeGreaterThan(shutdownIndex)
    expect(naturalIndex).toBeGreaterThan(exitIndex)
    expect(server.handle.terminate).not.toHaveBeenCalled()
    expect(order).toEqual(['done-settled', 'lifetime-abort'])
  })

  it('escalates to terminate exactly once only when the process is still alive', async () => {
    const h = makeHarness('hung-all', { shutdownTimeoutMs: 100 })
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    await vi.useFakeTimers()
    const dispose = h.runtime.dispose()
    await vi.advanceTimersByTimeAsync(200)
    await dispose
    await vi.useRealTimers()
    const events = server.events
    expect(events.indexOf('shutdown')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('exit')).toBeGreaterThan(events.indexOf('shutdown'))
    expect(events.indexOf('terminate')).toBeGreaterThan(events.indexOf('exit'))
    expect(server.handle.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps the same single transaction when shutdown or exit writes fail', async () => {
    const h = makeHarness('close-stdin-after-diagnostics')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    await server.handle.terminate()
    await h.runtime.dispose()
    expect(server.handle.terminate).toHaveBeenCalledTimes(1)
  })

  it('is single-flight: repeated teardown returns the same promise and terminates at most once', async () => {
    const h = makeHarness('hung-all', { shutdownTimeoutMs: 100 })
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    await vi.useFakeTimers()
    const first = h.runtime.dispose()
    const second = h.runtime.dispose()
    expect(first).toBe(second)
    await vi.advanceTimersByTimeAsync(200)
    await first
    await vi.useRealTimers()
    expect(server.handle.terminate).toHaveBeenCalledTimes(1)
  })
})

describe('dsh-lsp-diagnostics runtime dispose', () => {
  it('settles an active waiter before awaiting its queue and teardown', async () => {
    const h = makeHarness('timeout', { shutdownTimeoutMs: 100 })
    await vi.useFakeTimers()
    const diagnosis = h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    await vi.advanceTimersByTimeAsync(50)
    const dispose = h.runtime.dispose()
    await vi.advanceTimersByTimeAsync(200)
    await expect(diagnosis).resolves.toMatchObject({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    await expect(dispose).resolves.toBeUndefined()
    await vi.useRealTimers()
  })

  it('stops admission idempotently and returns stale afterwards', async () => {
    const h = makeHarness('push-versioned')
    h.runtime.stopAdmission()
    h.runtime.stopAdmission()
    await expect(h.runtime.diagnose(candidate(), WORKSPACE, undefined)).resolves.toMatchObject({ kind: 'stale' })
    expect(h.subprocess.spawn).not.toHaveBeenCalled()
  })

  it('snapshots and clears the public pool then awaits every session teardown', async () => {
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const server = h.servers[0]!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.handle.waitForExit.mockImplementationOnce(async () => {
      await gate
      return true
    })
    const dispose = h.runtime.dispose()
    let settled = false
    void dispose.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await dispose
    expect(server.events).toContain('shutdown')
  })

  it('aggregates cleanup errors', async () => {
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    h.servers[0]!.handle.waitForExit.mockRejectedValueOnce(new Error('waitForExit failed'))
    await expect(h.runtime.dispose()).rejects.toThrow(/waitForExit failed|teardown/)
  })

  it('is idempotent across repeated calls', async () => {
    const h = makeHarness('push-versioned')
    await h.runtime.diagnose(candidate(), WORKSPACE, undefined)
    const first = h.runtime.dispose()
    expect(h.runtime.dispose()).toBe(first)
    await first
    await expect(h.runtime.dispose()).resolves.toBeUndefined()
  })
})
