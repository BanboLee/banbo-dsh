import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAKE_LSP_SERVER = fileURLToPath(new URL('../../../tests/fixtures/fake-lsp-server.mjs', import.meta.url))

/** The exact default config every plugin Config validation run must produce. */
export const DEFAULT_CONFIG = {
  enabled: true,
  timeoutMs: 5000,
  settleMs: 200,
  shutdownTimeoutMs: 1000,
  killGraceMs: 500,
  maxDocumentBytes: 2_097_152,
  maxMessageBytes: 4_194_304,
  maxStderrBytes: 16_384,
  maxDiagnostics: 50,
  maxResultChars: 8000,
  reportClean: true,
  servers: {
    typescript: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      env: {},
      configuration: {},
      initializationOptions: null,
      extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
    },
    go: {
      command: 'gopls',
      args: [],
      env: {},
      configuration: {},
      initializationOptions: null,
      extensionToLanguage: { '.go': 'go' },
    },
  },
} as const

export interface LspMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

export function spawnFakeLspServer(mode: string, logPath?: string): ChildProcess {
  const args = logPath === undefined ? [FAKE_LSP_SERVER, mode] : [FAKE_LSP_SERVER, mode, logPath]
  return spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
}

export function readLogLines(logPath: string): readonly string[] {
  return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0)
}

export function makeTempDir(prefix: string): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

type NextResolver = (message: LspMessage) => void
type NextRejecter = (error: Error) => void

interface PendingRead {
  readonly resolve: NextResolver
  readonly reject: NextRejecter
  readonly timer: NodeJS.Timeout
}

/**
 * Minimal Content-Length framed JSON-RPC client over a child process.
 * Used to drive the fake LSP server directly; the plugin never uses it.
 */
export class FakeLspClient {
  private buffer = Buffer.alloc(0)
  private readonly buffered: LspMessage[] = []
  private readonly pending: PendingRead[] = []

  constructor(
    private readonly child: ChildProcess,
    private readonly defaultTimeoutMs = 2000,
  ) {
    child.stdout?.on('data', (chunk: Buffer) => this.push(chunk))
    child.stdout?.on('end', () => this.failAll(new Error('fake LSP server stdout closed')))
    child.on('error', (error) => this.failAll(error))
  }

  send(message: unknown): void {
    this.child.stdin?.write(encodeMessage(message))
  }

  next(timeoutMs = this.defaultTimeoutMs): Promise<LspMessage> {
    const buffered = this.buffered.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise<LspMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((entry) => entry.timer === timer)
        if (index !== -1) this.pending.splice(index, 1)
        reject(new Error(`timed out waiting for an LSP message after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.push({ resolve, reject, timer })
    })
  }

  waitForExit(timeoutMs = 5000): Promise<number | null> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode)
    return new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for exit after ${timeoutMs}ms`)), timeoutMs)
      this.child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  close(): void {
    this.child.stdin?.end()
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      let message: LspMessage
      try {
        message = JSON.parse(body) as LspMessage
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error('malformed LSP frame'))
        return
      }
      this.settle(message)
    }
  }

  private settle(message: LspMessage): void {
    const entry = this.pending.shift()
    if (entry === undefined) {
      this.buffered.push(message)
      return
    }
    clearTimeout(entry.timer)
    entry.resolve(message)
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}
