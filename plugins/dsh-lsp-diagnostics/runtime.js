/**
 * Diagnostics runtime: pooled per-(provider, workspace) LSP sessions over
 * subprocesses.
 *
 * Owns the two-level pool (`Map<providerId, Map<workspaceTargetKey, Session>>`
 * and the same-shaped serialization tails), the complete JSON-RPC state
 * machine, bounded document reads, exact-URI-first version correlation, strict
 * consumed-field Diagnostic projection, transport eviction with a single
 * same-call restart, and the unique graceful-first session teardown. The
 * runtime never creates or extends the execution deadline — it only consumes
 * the caller-provided operation signal (the coordinator relays caller abort,
 * its absolute deadline, and cleanup abort into it).
 *
 * @module dsh-lsp-diagnostics/runtime
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import { encodeMessage, MessageDecoder } from './framing.js'

/** Server→client request methods answered with an empty result (no dynamic registration). */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/** Client capabilities advertised at `initialize`. */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    publishDiagnostics: { versionSupport: true },
  },
}

/** @type {Readonly<Record<number, 'error' | 'warning' | 'info' | 'hint'>>} */
const SEVERITY_TO_TOKEN = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

/** @type {Readonly<Record<string, 0 | 1 | 2 | 3 | 4>>} */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, hint: 3, unknown: 4 }

/** @typedef {'error' | 'warning' | 'info' | 'hint' | 'unknown'} SeverityToken */

/**
 * @typedef {object} NormalizedPosition
 * @property {number} line - LSP 0-based UTF-16 line.
 * @property {number} character - LSP 0-based UTF-16 character.
 */

/**
 * @typedef {object} NormalizedRange
 * @property {NormalizedPosition} start
 * @property {NormalizedPosition} end
 */

/**
 * @typedef {object} NormalizedDiagnostic
 * @property {string} uri
 * @property {NormalizedRange} range
 * @property {SeverityToken} severity
 * @property {0|1|2|3|4} severityRank
 * @property {string} code
 * @property {string} source
 * @property {string} message
 */

/**
 * @typedef {'server not found' | 'server crashed' | 'timeout' | 'malformed response' | 'document too large' | 'diagnostics unavailable'} UnavailableReason
 */

/**
 * @typedef {{ kind: 'ok', diagnostics: NormalizedDiagnostic[], uri: string, version: number } |
 *           { kind: 'stale' } |
 *           { kind: 'unavailable', reason: UnavailableReason }} DiagnosisOutcome
 */

/**
 * @typedef {object} ServerConfig
 * @property {string} command
 * @property {readonly string[]} args
 * @property {Record<string, string>} env
 * @property {unknown} configuration
 * @property {unknown} initializationOptions
 * @property {Record<string, string>} extensionToLanguage
 */

/**
 * @typedef {object} RuntimeConfig
 * @property {number} settleMs
 * @property {number} shutdownTimeoutMs
 * @property {number} killGraceMs
 * @property {number} maxDocumentBytes
 * @property {number} maxMessageBytes
 * @property {number} maxStderrBytes
 * @property {Record<string, ServerConfig>} servers
 */

/**
 * @typedef {object} SessionHandle
 * @property {number} pid
 * @property {{ write(chunk: Buffer, callback?: (error?: Error | null) => void): void, on(event: 'error', listener: (error: Error) => void): void, removeListener?(event: 'error', listener: (error: Error) => void): void }} stdin
 * @property {import('node:events').EventEmitter} stdout
 * @property {import('node:events').EventEmitter} stderr
 * @property {Record<string, never>} collected
 * @property {Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>} done
 * @property {() => void} terminate
 * @property {(signal?: AbortSignal) => Promise<boolean>} waitForExit
 */

/**
 * @typedef {object} SubprocessSeam
 * @property {(command: string, env: Record<string, string>, signal?: AbortSignal) => Promise<string>} resolveExecutable
 * @property {(spec: object) => SessionHandle} spawn
 */

/**
 * @typedef {object} FsSeam
 * @property {(target: unknown, signal?: AbortSignal) => Promise<{ version: string, type: string, size?: number } | undefined>} stat
 * @property {(target: unknown, signal: AbortSignal | undefined, maxBytes: number) => Promise<Uint8Array>} readBytes
 * @property {(target: unknown) => string} processPath
 * @property {(target: unknown) => string} fileUrl
 */

/**
 * @typedef {object} Waiter
 * @property {string} canonicalUri - the exact canonical document URI.
 * @property {number} currentVersion - the didOpen version of this open generation.
 * @property {boolean} firstOpen - whether this process opens this URI for the first time.
 * @property {boolean} opened - whether the didOpen write succeeded; only a
 *   successfully written open generation may accept publications.
 * @property {NormalizedDiagnostic[] | null} preOpenBatch - publications that
 *   arrived while the didOpen write was still in flight, buffered until the
 *   open succeeds; they never set `acceptedPublication` by themselves.
 * @property {boolean} settled - the waiter is done (accepted, timed out, aborted, or failed).
 * @property {NormalizedDiagnostic[] | null} batch - the latest accepted batch.
 * @property {ReturnType<typeof setTimeout> | undefined} timer - the quiet-window timer.
 * @property {Promise<DiagnosisOutcome>} promise
 * @property {(value: DiagnosisOutcome) => void} resolve
 * @property {(reason: Error) => void} reject
 * @property {AbortSignal | undefined} signal
 * @property {(() => void) | undefined} onAbort
 */

/**
 * A fatal transport or protocol failure with its closed unavailable reason.
 * @private
 */
class TransportError extends Error {
  /**
   * @param {UnavailableReason} reason - the closed reason surfaced to the coordinator.
   * @param {unknown} [cause] - the underlying error.
   */
  constructor(reason, cause) {
    super(`lsp transport failure: ${reason}`, cause === undefined ? undefined : { cause })
    this.name = 'TransportError'
    /** @type {UnavailableReason} */
    this.reason = reason
    /** @type {boolean} - set on stdin write-path failures so bootstrap can
     *  distinguish a dead-server EPIPE from a decoder/protocol failure. */
    this.writeFailure = false
  }
}

/**
 * Race a promise against an abort signal.
 * @param {Promise<unknown>} promise - the operation to bound.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<unknown>}
 */
function abortable(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/**
 * Build a consistent abort error for a signal.
 * @param {AbortSignal} [signal] - the aborted signal.
 * @returns {Error}
 */
function abortError(signal) {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  if (signal !== undefined && signal.reason !== undefined) {
    try {
      error.cause = signal.reason
    } catch {
      // reason getter must not break cancellation
    }
  }
  return error
}

/**
 * Lowercase last path suffix of a file URL's pathname (`.ts`, `.tsx`, `.go`).
 * Never reads `displayPath` for routing.
 * @param {string} uri - the canonical document URI.
 * @returns {string} the extension including the dot, or '' when absent.
 */
function extensionOf(uri) {
  try {
    const pathname = new URL(uri).pathname
    const slash = pathname.lastIndexOf('/')
    const base = slash === -1 ? pathname : pathname.slice(slash + 1)
    const dot = base.lastIndexOf('.')
    if (dot === -1) return ''
    return base.slice(dot).toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Normalize one consumed-field diagnostic against the strict V1 schema.
 *
 * Only `range`/`severity`/`code`/`source`/`message` are read and validated;
 * standard optional fields (`tags`, `relatedInformation`, `codeDescription`,
 * `data`) and unknown extension fields are never traversed, validated,
 * stringified, or copied, and can never make the publication fatal by
 * themselves. Server strings are sanitized to single-line safe text. The
 * returned object is frozen and matches the strict normalized schema exactly.
 *
 * @param {string} uri - the exact canonical document URI.
 * @param {unknown} raw - one raw LSP Diagnostic.
 * @returns {NormalizedDiagnostic} the immutable normalized diagnostic.
 * @throws {Error} when any consumed field is missing or invalid.
 */
export function normalizeDiagnostic(uri, raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('diagnostic must be an object')
  }
  const message = /** @type {{ message?: unknown }} */ (raw).message
  if (typeof message !== 'string') throw new Error('diagnostic message must be a string')
  const range = normalizeRange(/** @type {{ range?: unknown }} */ (raw).range)
  const severity = normalizeSeverity(/** @type {{ severity?: unknown }} */ (raw).severity)
  const code = normalizeCode(/** @type {{ code?: unknown }} */ (raw).code)
  const source = normalizeSource(/** @type {{ source?: unknown }} */ (raw).source)
  return Object.freeze({
    uri,
    range,
    severity,
    severityRank: /** @type {0|1|2|3|4} */ (SEVERITY_RANK[severity]),
    code: sanitizeServerString(code),
    source: sanitizeServerString(source),
    message: sanitizeServerString(message),
  })
}

/**
 * Validate a diagnostic range (strict object with exactly `start`/`end`).
 * @param {unknown} value - the raw range.
 * @returns {NormalizedRange}
 */
function normalizeRange(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('diagnostic range must be an object')
  }
  const keys = Object.keys(value)
  if (keys.length !== 2 || !('start' in value) || !('end' in value)) {
    throw new Error('diagnostic range must have exactly start and end')
  }
  const start = normalizePosition(/** @type {{ start?: unknown }} */ (value).start)
  const end = normalizePosition(/** @type {{ end?: unknown }} */ (value).end)
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    throw new Error('diagnostic range end must not precede start')
  }
  return Object.freeze({ start, end })
}

/**
 * Validate a 0-based UTF-16 position (strict object with exactly `line`/`character`).
 * @param {unknown} value - the raw position.
 * @returns {NormalizedPosition}
 */
function normalizePosition(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('diagnostic position must be an object')
  }
  const keys = Object.keys(value)
  if (keys.length !== 2 || !('line' in value) || !('character' in value)) {
    throw new Error('diagnostic position must have exactly line and character')
  }
  const line = /** @type {{ line?: unknown }} */ (value).line
  const character = /** @type {{ character?: unknown }} */ (value).character
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 || line >= Number.MAX_SAFE_INTEGER) {
    throw new Error('diagnostic position line must be an integer in [0, MAX_SAFE_INTEGER)')
  }
  if (typeof character !== 'number' || !Number.isSafeInteger(character) || character < 0 || character >= Number.MAX_SAFE_INTEGER) {
    throw new Error('diagnostic position character must be an integer in [0, MAX_SAFE_INTEGER)')
  }
  return Object.freeze({ line, character })
}

/**
 * Validate severity (`1|2|3|4`), defaulting to `unknown`.
 * @param {unknown} value - the raw severity.
 * @returns {SeverityToken}
 */
function normalizeSeverity(value) {
  if (value === undefined) return 'unknown'
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('diagnostic severity must be an integer 1|2|3|4')
  }
  const token = SEVERITY_TO_TOKEN[value]
  if (token === undefined) throw new Error('diagnostic severity must be 1|2|3|4')
  return token
}

/**
 * Validate code (safe integer or string), defaulting to ''.
 * @param {unknown} value - the raw code.
 * @returns {string}
 */
function normalizeCode(value) {
  if (value === undefined) return ''
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('diagnostic code must be a safe integer or string')
    return String(value)
  }
  if (typeof value === 'string') return value
  throw new Error('diagnostic code must be a safe integer or string')
}

/**
 * Validate source (string), defaulting to ''.
 * @param {unknown} value - the raw source.
 * @returns {string}
 */
function normalizeSource(value) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error('diagnostic source must be a string')
  return value
}

/**
 * Sanitize a consumed server string to single-line safe text: each CRLF, CR,
 * LF, U+2028, or U+2029 becomes one space; every other C0/C1 control character
 * and every lone surrogate becomes U+FFFD. Never adds output lines.
 * @param {string} value - the raw server string.
 * @returns {string}
 */
export function sanitizeServerString(value) {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const char = value.charAt(index)
    if (char === '\r') {
      if (value.charAt(index + 1) === '\n') index += 1
      out += ' '
      continue
    }
    if (char === '\n' || char === '\u2028' || char === '\u2029') {
      out += ' '
      continue
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      out += '\uFFFD'
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += char + value.charAt(index + 1)
        index += 1
        continue
      }
      out += '\uFFFD'
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD'
      continue
    }
    out += char
  }
  return out
}
/**
 * The diagnostics runtime: per-provider/workspace pooled LSP sessions.
 */
export class DiagnosticsRuntime {
  /**
   * @param {object} deps - runtime dependencies.
   * @param {FsSeam} deps.fs - the public `ctx.fs` seam.
   * @param {SubprocessSeam} deps.subprocess - the public `ctx.subprocess` seam.
   * @param {RuntimeConfig} deps.config - the validated plugin config.
   */
  constructor({ fs, subprocess, config }) {
    /** @type {FsSeam} */
    this.fs = fs
    /** @type {SubprocessSeam} */
    this.subprocess = subprocess
    /** @type {RuntimeConfig} */
    this.config = config
    /** @type {Map<string, Map<string, LspSession>>} */
    this.sessions = new Map()
    /** @type {Map<string, Map<string, Promise<unknown>>>} */
    this.tails = new Map()
    /** @type {Set<Promise<void>>} */
    this.retiredProcessCleanup = new Set()
    /** @type {unknown[]} */
    this.retiredProcessErrors = []
    /** @type {boolean} */
    this.admissionOpen = true
    /** @type {Promise<void> | undefined} */
    this.disposePromise = undefined
    /** @type {Map<string, { providerId: string, languageId: string, server: ServerConfig }>} */
    this.routes = new Map()
    for (const [providerId, server] of Object.entries(config.servers)) {
      for (const [extension, languageId] of Object.entries(server.extensionToLanguage)) {
        this.routes.set(extension, { providerId, languageId, server })
      }
    }
  }

  /**
   * Synchronously close admission; no further diagnosis starts.
   * @returns {void}
   */
  stopAdmission() {
    this.admissionOpen = false
  }

  /**
   * Dispose the runtime: stop admission, snapshot and clear the public pool,
   * run every session's unique teardown, and await queues, session teardowns,
   * and retired process cleanup together, aggregating cleanup errors.
   * @returns {Promise<void>}
   */
  dispose() {
    this.stopAdmission()
    if (this.disposePromise === undefined) {
      this.disposePromise = this.performDispose()
    }
    return this.disposePromise
  }

  /**
   * @returns {Promise<void>}
   */
  async performDispose() {
    /** @type {Set<LspSession>} */
    const sessions = new Set()
    for (const byKey of this.sessions.values()) {
      for (const session of byKey.values()) sessions.add(session)
    }
    /** @type {Promise<unknown>[]} */
    const queues = []
    for (const byKey of this.tails.values()) {
      for (const tail of byKey.values()) queues.push(tail)
    }
    this.sessions.clear()
    this.tails.clear()
    for (const session of sessions) this.startSessionTeardown(session)
    /** @type {unknown[]} */
    const errors = []
    const queueResults = await Promise.allSettled(queues)
    for (const result of queueResults) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
    while (this.retiredProcessCleanup.size > 0) {
      await Promise.allSettled([...this.retiredProcessCleanup])
    }
    errors.push(...this.retiredProcessErrors)
    this.retiredProcessErrors.length = 0
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'dsh-lsp-diagnostics runtime dispose failed')
    }
  }

  /**
   * Diagnose one written file after a successful mutation.
   *
   * The candidate is the collector's mutation candidate; the workspace is the
   * coordinator-canonicalized workspace target, and `canonicalUri` is the
   * eligibility-frozen canonical document URI the coordinator derived exactly
   * once. The runtime never re-derives the document URI: the frozen value is
   * used for route selection, bounded read, didOpen and the publication
   * waiter, so correlation cannot drift from the coordinator's render side.
   * Unsupported extensions, closed admission, and already-aborted signals are
   * silent (`stale`). All workspace-visible work is serialized per (provider,
   * workspace) through the two-level tail.
   *
   * @param {{ target: unknown, version: string, generation: number }} candidate - the mutated target.
   * @param {{ targetKey: string, displayPath?: string }} canonicalWorkspace - the canonical workspace target.
   * @param {string} canonicalUri - the eligibility-frozen canonical document URI.
   * @param {AbortSignal} [executionSignal] - relayed caller/deadline/cleanup abort.
   * @returns {Promise<DiagnosisOutcome>}
   */
  async diagnose(candidate, canonicalWorkspace, canonicalUri, executionSignal) {
    if (!this.admissionOpen) return { kind: 'stale' }
    if (executionSignal !== undefined && executionSignal.aborted) return { kind: 'stale' }
    const uri = canonicalUri
    const extension = extensionOf(uri)
    const route = this.routes.get(extension)
    if (route === undefined) return { kind: 'stale' }
    const providerId = route.providerId
    const workspaceKey = canonicalWorkspace.targetKey
    try {
      return await this.enqueue(
        providerId,
        workspaceKey,
        () => this.runDiagnosis(candidate, canonicalWorkspace, route, uri, executionSignal),
        executionSignal,
      )
    } catch (error) {
      if (executionSignal !== undefined && executionSignal.aborted) return { kind: 'stale' }
      throw error
    }
  }
  /**
   * Serialize one complete diagnosis lifecycle for a provider/workspace pair.
   * @param {string} providerId - provider id.
   * @param {string} workspaceKey - opaque canonical workspace key.
   * @param {() => Promise<DiagnosisOutcome>} run - lifecycle to run after the prior tail.
   * @param {AbortSignal} [signal] - operation cancellation while waiting in the queue.
   * @returns {Promise<DiagnosisOutcome>}
   */
  enqueue(providerId, workspaceKey, run, signal) {
    let byKey = this.tails.get(providerId)
    if (byKey === undefined) {
      byKey = new Map()
      this.tails.set(providerId, byKey)
    }
    const previous = byKey.get(workspaceKey) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    // The tail follows the ACTUAL prior work, never the abortable view, so a
    // caller giving up on the wait does not deserialize the queue.
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    byKey.set(workspaceKey, tail)
    void tail.then(() => {
      if (byKey.get(workspaceKey) === tail) byKey.delete(workspaceKey)
    })
    return result
  }

  /**
   * Read the target document with the bounded stat-preflight + readBytes path.
   * @param {unknown} target - the document target.
   * @param {string} uri - canonical URI already derived for routing and correlation.
   * @param {AbortSignal} [signal] - operation cancellation.
   * @returns {Promise<{ kind: 'ok', uri: string, text: string } | { kind: 'unavailable', reason: UnavailableReason }>}
   */
  async readDocument(target, uri, signal) {
    /** @type {{ version: string, type: string, size?: number } | undefined} */
    let info
    try {
      info = await this.fs.stat(target, signal)
    } catch {
      if (signal !== undefined && signal.aborted) {
        return { kind: 'unavailable', reason: 'diagnostics unavailable' }
      }
      return { kind: 'unavailable', reason: 'diagnostics unavailable' }
    }
    if (signal !== undefined && signal.aborted) {
      return { kind: 'unavailable', reason: 'diagnostics unavailable' }
    }
    if (info === undefined || info.type !== 'file') {
      return { kind: 'unavailable', reason: 'diagnostics unavailable' }
    }
    if (typeof info.size === 'number' && info.size > this.config.maxDocumentBytes) {
      return { kind: 'unavailable', reason: 'document too large' }
    }
    /** @type {Uint8Array} */
    let bytes
    try {
      bytes = await this.fs.readBytes(target, signal, this.config.maxDocumentBytes)
    } catch (error) {
      if (signal !== undefined && signal.aborted) {
        return { kind: 'unavailable', reason: 'diagnostics unavailable' }
      }
      if (error instanceof FsError && error.code === 'FS_TOO_LARGE') {
        return { kind: 'unavailable', reason: 'document too large' }
      }
      return { kind: 'unavailable', reason: 'diagnostics unavailable' }
    }
    if (signal !== undefined && signal.aborted) {
      return { kind: 'unavailable', reason: 'diagnostics unavailable' }
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { kind: 'unavailable', reason: 'diagnostics unavailable' }
    }
    return { kind: 'ok', uri, text }
  }

  /**
   * Run one diagnosis for an eligible route, with a single same-call restart
   * on a fresh instance after an unaccepted transport failure.
   * @param {{ target: unknown, version: string, generation: number }} candidate - the mutated target.
   * @param {{ targetKey: string, displayPath?: string }} canonicalWorkspace - the canonical workspace target.
   * @param {{ providerId: string, languageId: string, server: ServerConfig }} route - the route.
   * @param {string} uri - the canonical document URI.
   * @param {AbortSignal} [executionSignal] - operation cancellation.
   * @returns {Promise<DiagnosisOutcome>}
   */
  async runDiagnosis(candidate, canonicalWorkspace, route, uri, executionSignal) {
    if (!this.admissionOpen) return { kind: 'stale' }
    if (executionSignal !== undefined && executionSignal.aborted) return { kind: 'stale' }
    const providerId = route.providerId
    const workspaceKey = canonicalWorkspace.targetKey
    const workspacePath = this.fs.processPath(canonicalWorkspace)
    const workspaceUri = this.fs.fileUrl(canonicalWorkspace)
    const read = await this.readDocument(candidate.target, uri, executionSignal)
    if (read.kind !== 'ok') return read
    if (!this.admissionOpen) return { kind: 'stale' }
    if (executionSignal !== undefined && executionSignal.aborted) return { kind: 'stale' }
    let session = this.getOrCreateSession(providerId, workspaceKey, workspacePath, workspaceUri, route, executionSignal)
    let attempt = 0
    for (;;) {
      try {
        const outcome = await session.diagnose(uri, route.languageId, read.text, executionSignal)
        if (executionSignal !== undefined && executionSignal.aborted) {
          this.evictIfCurrent(providerId, workspaceKey, session)
          this.startSessionTeardown(session)
        } else if (session.retireAfterClose) {
          this.evictIfCurrent(providerId, workspaceKey, session)
          this.startSessionTeardown(session)
        }
        return outcome
      } catch (error) {
        if (executionSignal !== undefined && executionSignal.aborted) {
          this.evictIfCurrent(providerId, workspaceKey, session)
          this.startSessionTeardown(session)
          return { kind: 'unavailable', reason: 'diagnostics unavailable' }
        }
        if (!(error instanceof TransportError)) throw error
        this.evictIfCurrent(providerId, workspaceKey, session)
        this.startSessionTeardown(session)
        if (session.acceptedPublication || attempt > 0) {
          return { kind: 'unavailable', reason: error.reason }
        }
        if (!this.admissionOpen) return { kind: 'stale' }
        attempt += 1
        session = this.getOrCreateSession(providerId, workspaceKey, workspacePath, workspaceUri, route, executionSignal)
      }
    }
  }

  /**
   * Return the pooled session for a (provider, workspace) key, or synchronously
   * publish a fresh one (before its initialize promise is exposed) and start it.
   * @param {string} providerId - the provider id.
   * @param {string} workspaceKey - the opaque workspace targetKey.
   * @param {string} workspacePath - the subprocess cwd for this workspace.
   * @param {string} workspaceUri - the canonical workspace root URI.
   * @param {{ providerId: string, languageId: string, server: ServerConfig }} route - the route.
   * @param {AbortSignal} [executionSignal] - the creating operation's signal.
   * @returns {LspSession}
   */
  getOrCreateSession(providerId, workspaceKey, workspacePath, workspaceUri, route, executionSignal) {
    let byKey = this.sessions.get(providerId)
    if (byKey === undefined) {
      byKey = new Map()
      this.sessions.set(providerId, byKey)
    }
    const existing = byKey.get(workspaceKey)
    if (existing !== undefined && !existing.isClosing()) return existing
    if (existing !== undefined) byKey.delete(workspaceKey)
    const session = new LspSession({
      subprocess: this.subprocess,
      config: this.config,
      workspacePath,
      workspaceUri,
      server: route.server,
      onFatal: (failed) => {
        this.evictIfCurrent(providerId, workspaceKey, failed)
        this.startSessionTeardown(failed)
      },
    })
    byKey.set(workspaceKey, session)
    session.start(executionSignal)
    return session
  }

  /**
   * Remove the pool slot iff it still holds this session.
   * @param {string} providerId - the provider id.
   * @param {string} workspaceKey - the workspace key.
   * @param {LspSession} session - the session to evict.
   * @returns {void}
   */
  evictIfCurrent(providerId, workspaceKey, session) {
    const byKey = this.sessions.get(providerId)
    if (byKey === undefined) return
    if (byKey.get(workspaceKey) === session) byKey.delete(workspaceKey)
  }

  /**
   * Start a session teardown and track it as retired process cleanup.
   * @param {LspSession} session - the session being retired.
   * @returns {void}
   */
  startSessionTeardown(session) {
    const promise = session.startTeardown()
    if (this.retiredProcessCleanup.has(promise)) return
    this.retiredProcessCleanup.add(promise)
    void promise.then(
      () => this.retiredProcessCleanup.delete(promise),
      (error) => {
        this.retiredProcessCleanup.delete(promise)
        this.retiredProcessErrors.push(error)
      },
    )
  }
}

/**
 * One pooled LSP session: a single subprocess plus the JSON-RPC state machine.
 * @private
 */
class LspSession {
  /**
   * @param {object} deps - session dependencies.
   * @param {SubprocessSeam} deps.subprocess - the subprocess seam.
   * @param {RuntimeConfig} deps.config - the validated plugin config.
   * @param {string} deps.workspacePath - the subprocess cwd.
   * @param {string} deps.workspaceUri - the canonical workspace root URI.
   * @param {ServerConfig} deps.server - the server config.
   * @param {(session: LspSession) => void} deps.onFatal - runtime-owned eviction/teardown hook.
   */
  constructor({ subprocess, config, workspacePath, workspaceUri, server, onFatal }) {
    /** @type {SubprocessSeam} */
    this.subprocess = subprocess
    /** @type {RuntimeConfig} */
    this.config = config
    /** @type {string} */
    this.workspacePath = workspacePath
    /** @type {string} */
    this.workspaceUri = workspaceUri
    /** @type {ServerConfig} */
    this.server = server
    /** @type {(session: LspSession) => void} */
    this.onFatal = onFatal
    /** @type {MessageDecoder} */
    this.decoder = new MessageDecoder(config.maxMessageBytes)
    /** @type {SessionHandle | undefined} */
    this.handle = undefined
    /** @type {{ write(chunk: Buffer, callback?: (error?: Error | null) => void): void, on(event: 'error', listener: (error: Error) => void): void, removeListener?(event: 'error', listener: (error: Error) => void): void } | undefined} */
    this.stdin = undefined
    /** @type {import('node:events').EventEmitter | undefined} */
    this.stdout = undefined
    /** @type {(error: Error) => void} */
    this.onStdinError = (error) => {
      if (!this.closing) this.poison(new TransportError('malformed response', error))
    }
    /** @type {(chunk: Buffer) => void} */
    this.onStdoutData = (chunk) => {
      this.onStdout(chunk)
    }
    /** @type {(error: Error) => void} */
    this.onStdoutError = (error) => {
      if (!this.closing) this.poison(new TransportError('malformed response', error))
    }
    /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void, signal?: AbortSignal, onAbort?: () => void }>} */
    this.pending = new Map()
    /** @type {Set<Promise<void>>} */
    this.serverRequests = new Set()
    /** @type {number} */
    this.nextId = 1
    /** @type {Promise<void>} */
    this.writeTail = Promise.resolve()
    /** @type {Promise<void> | undefined} */
    this.ready = undefined
    /** @type {Map<string, number>} */
    this.openVersions = new Map()
    /** @type {Waiter | null} */
    this.waiter = null
    /** @type {AbortController} */
    this.lifetimeController = new AbortController()
    /** @type {Promise<void> | undefined} */
    this.teardownPromise = undefined
    /** @type {boolean} */
    this.closing = false
    /** @type {boolean} */
    this.poisoned = false
    /** @type {TransportError | undefined} */
    this.poisonError = undefined
    /** @type {boolean} */
    this.acceptedPublication = false
    /** @type {boolean} */
    this.retireAfterClose = false
    /** @type {Set<string>} */
    this.openedUris = new Set()
  }

  /**
   * Whether the session must not be reused (closing or poisoned).
   * @returns {boolean}
   */
  isClosing() {
    return this.closing || this.poisoned
  }

  /**
   * Spawn the server and start the single-flight initialize handshake.
   * @param {AbortSignal} [executionSignal] - the creating operation's signal.
   * @returns {void}
   */
  start(executionSignal) {
    this.ready = this.bootstrap(executionSignal)
    this.ready.catch(() => {})
  }

  /**
   * Spawn, initialize, and validate the server.
   * @param {AbortSignal} [executionSignal] - the creating operation's signal.
   * @returns {Promise<void>}
   */
  async bootstrap(executionSignal) {
    /** @type {string} */
    let executable
    try {
      executable = await this.subprocess.resolveExecutable(this.server.command, this.server.env, executionSignal)
    } catch (error) {
      if (executionSignal !== undefined && executionSignal.aborted) throw abortError(executionSignal)
      throw new TransportError('server not found', error)
    }
    if (executionSignal !== undefined && executionSignal.aborted) throw abortError(executionSignal)
    /** @type {SessionHandle} */
    let handle
    try {
      handle = this.subprocess.spawn({
        argv: [executable, ...this.server.args],
        cwd: this.workspacePath,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: this.config.maxStderrBytes },
        },
        graceMs: this.config.killGraceMs,
        signal: this.lifetimeController.signal,
        env: this.server.env,
      })
    } catch (error) {
      throw new TransportError('server crashed', error)
    }
    this.handle = handle
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new TransportError('server crashed', new Error('subprocess dropped a piped protocol stream'))
    }
    this.stdin = handle.stdin
    this.stdout = handle.stdout
    handle.done.then(
      () => {
        this.processExited = true
        if (!this.closing) this.poison(new TransportError('server crashed', new Error('language server exited')))
      },
      (error) => {
        this.processExited = true
        if (!this.closing) this.poison(new TransportError('server crashed', error))
      },
    )
    this.stdin.on('error', this.onStdinError)
    this.stdout.on('data', this.onStdoutData)
    this.stdout.on('error', this.onStdoutError)
    const initializeResult = await this.request(
      'initialize',
      {
        processId: null,
        rootUri: this.workspaceUri,
        workspaceFolders: [{ uri: this.workspaceUri, name: 'workspace' }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.server.initializationOptions,
      },
      executionSignal,
    ).catch(async (error) => {
      if (executionSignal !== undefined && executionSignal.aborted) throw abortError(executionSignal)
      if (error instanceof TransportError && error.writeFailure === true) {
        // A stdin write failure (e.g. EPIPE) can beat the process-exit
        // observation: when the server exited before its initialize response,
        // the classification must stay `server crashed`, not degrade to
        // `malformed response`. Decoder/protocol failures are never
        // reclassified — only write failures race the process exit.
        const cause = error.cause
        const isEpipe =
          cause instanceof Error &&
          (/** @type {{ code?: unknown }} */ (/** @type {unknown} */ (cause)).code === 'EPIPE' ||
            /EPIPE/.test(cause.message))
        if (isEpipe || this.processExited) throw new TransportError('server crashed', error)
        if (this.handle !== undefined) {
          // Give handle.done a macrotask window to settle for the
          // EPIPE-before-exit ordering before falling back to the original
          // classification (malformed response).
          const exited = await Promise.race([
            this.handle.done.then(() => true, () => true),
            new Promise((resolve) => setTimeout(resolve, 0)).then(() => false),
          ])
          if (exited) throw new TransportError('server crashed', error)
        }
        throw error
      }
      if (error instanceof TransportError) throw error
      throw new TransportError('malformed response', error)
    })
    const initializeRecord = /** @type {{ capabilities?: unknown } | null} */ (initializeResult)
    if (
      typeof initializeRecord !== 'object' ||
      initializeRecord === null ||
      typeof initializeRecord.capabilities !== 'object' ||
      initializeRecord.capabilities === null ||
      Array.isArray(initializeRecord.capabilities)
    ) {
      throw new TransportError('malformed response', new Error('initialize result must contain object capabilities'))
    }
    await abortable(
      this.write({ jsonrpc: '2.0', method: 'initialized', params: {} }),
      executionSignal,
    )
  }

  /**
   * Diagnose one open lifecycle: wait ready, arm the waiter, write didOpen,
   * wait the quiet window, then close-or-evict.
   * @param {string} uri - the canonical document URI.
   * @param {string} languageId - the LSP language id.
   * @param {string} text - the decoded document text.
   * @param {AbortSignal} [executionSignal] - operation cancellation.
   * @returns {Promise<DiagnosisOutcome>}
   */
  async diagnose(uri, languageId, text, executionSignal) {
    if (this.isClosing()) throw new TransportError('server crashed', new Error('session is closing'))
    this.acceptedPublication = false
    this.retireAfterClose = false
    try {
      const ready = this.ready
      if (ready === undefined) throw new TransportError('server crashed', new Error('session was not started'))
      await abortable(ready, executionSignal)
    } catch (error) {
      if (executionSignal !== undefined && executionSignal.aborted) {
        return { kind: 'unavailable', reason: 'diagnostics unavailable' }
      }
      throw error
    }
    if (this.poisoned) throw this.poisonError
    const version = (this.openVersions.get(uri) ?? 0) + 1
    this.openVersions.set(uri, version)
    const firstOpen = !this.openedUris.has(uri)
    this.openedUris.add(uri)
    const waiter = this.armWaiter(uri, version, firstOpen, executionSignal)
    // The waiter is only awaited after a successful didOpen write; a write
    // failure settles it through poison before this function can await it, so
    // its rejection must stay observed (no unhandled rejection).
    void waiter.promise.catch(() => {})
    let opened = false
    /** @type {DiagnosisOutcome} */
    let outcome = { kind: 'unavailable', reason: 'diagnostics unavailable' }
    let closeFailed = false
    try {
      await abortable(
        this.write({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId, version, text } },
        }),
        executionSignal,
      )
      opened = true
      // Only a successfully written didOpen generation accepts notifications:
      // flush any publication that raced the write callback now.
      waiter.opened = true
      if (waiter.preOpenBatch !== null) {
        this.acceptBatch(waiter.preOpenBatch)
        waiter.preOpenBatch = null
      }
      outcome = await waiter.promise
    } catch (error) {
      if (executionSignal !== undefined && executionSignal.aborted) {
        outcome = { kind: 'unavailable', reason: 'diagnostics unavailable' }
      } else {
        throw error
      }
    } finally {
      if (opened && !this.isClosing()) {
        if (executionSignal !== undefined && executionSignal.aborted) {
          this.poison(new TransportError('malformed response', new Error('deadline passed while open')))
          closeFailed = true
        } else {
          try {
            await abortable(
              this.write({
                jsonrpc: '2.0',
                method: 'textDocument/didClose',
                params: { textDocument: { uri } },
              }),
              executionSignal,
            )
          } catch (error) {
            this.poison(new TransportError('malformed response', error))
            closeFailed = true
            if (executionSignal !== undefined && executionSignal.aborted) {
              outcome = { kind: 'unavailable', reason: 'diagnostics unavailable' }
            }
          }
        }
      }
      this.detachWaiter()
    }
    if (closeFailed && outcome.kind === 'ok') {
      return { kind: 'unavailable', reason: 'malformed response' }
    }
    return outcome
  }

  /**
   * Arm the diagnostic waiter BEFORE the didOpen write. The waiter is
   * considered activated immediately: a child that reads didOpen from the
   * pipe can publish before Node invokes the write callback continuation, and
   * that matching publication must be kept, never dropped. If the write
   * itself later fails, the poison/teardown path still wins.
   * @param {string} uri - the exact canonical URI.
   * @param {number} version - the didOpen document version.
   * @param {boolean} firstOpen - whether this process opens this URI for the first time.
   * @param {AbortSignal} [executionSignal] - operation cancellation.
   * @returns {Waiter}
   */
  armWaiter(uri, version, firstOpen, executionSignal) {
    /** @type {(value: DiagnosisOutcome) => void} */
    let resolve = () => {}
    /** @type {(reason: Error) => void} */
    let reject = () => {}
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    /** @type {Waiter} */
    const waiter = {
      canonicalUri: uri,
      currentVersion: version,
      firstOpen,
      opened: false,
      preOpenBatch: null,
      settled: false,
      batch: null,
      timer: undefined,
      promise,
      resolve,
      reject,
      signal: executionSignal,
      onAbort: undefined,
    }
    waiter.onAbort = () => {
      if (waiter.settled) return
      waiter.settled = true
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      resolve({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    }
    if (executionSignal !== undefined) {
      executionSignal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    this.waiter = waiter
    return waiter
  }

  /**
   * Remove the waiter's abort listener and timer and drop the active reference.
   * @returns {void}
   */
  detachWaiter() {
    const waiter = this.waiter
    if (waiter === null) return
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    this.waiter = null
  }

  /**
   * Start (or restart) the quiet window for the active waiter. The window only
   * runs inside the execution deadline: the abort listener settles the waiter
   * first and clears the timer.
   * @returns {void}
   */
  startQuietTimer() {
    const waiter = this.waiter
    if (waiter === null || waiter.settled) return
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return
      waiter.settled = true
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      if (waiter.batch !== null) {
        waiter.resolve({
          kind: 'ok',
          diagnostics: waiter.batch,
          uri: waiter.canonicalUri,
          version: waiter.currentVersion,
        })
      } else {
        waiter.resolve({ kind: 'unavailable', reason: 'timeout' })
      }
    }, this.config.settleMs)
  }

  /**
   * Accept a matching batch: keep the latest full array for this version and
   * restart the quiet window.
   * @param {NormalizedDiagnostic[]} diagnostics - the normalized batch.
   * @returns {void}
   */
  acceptBatch(diagnostics) {
    const waiter = this.waiter
    if (waiter === null || waiter.settled) return
    waiter.batch = diagnostics
    this.acceptedPublication = true
    this.startQuietTimer()
  }

  /**
   * Consume stdout bytes through the bounded decoder.
   * @param {Buffer} chunk - raw stdout bytes.
   * @returns {void}
   */
  onStdout(chunk) {
    /** @type {unknown[]} */
    let messages
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      this.poison(new TransportError('malformed response', error))
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  /**
   * Route one decoded JSON-RPC message.
   * @param {unknown} message - the decoded frame.
   * @returns {void}
   */
  dispatch(message) {
    if (typeof message !== 'object' || message === null) return
    const frame = /** @type {Record<string, unknown>} */ (message)
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      // While closing, no new server-request handlers start: teardown owns the
      // already-started handlers and the write tail so no protocol I/O can
      // happen after cleanup resolves.
      if (this.closing) return
      const task = this.handleServerRequest(id, method, frame.params)
      this.serverRequests.add(task)
      void task.then(
        () => this.serverRequests.delete(task),
        () => this.serverRequests.delete(task),
      )
      return
    }
    if (typeof method === 'string') {
      if (method === 'textDocument/publishDiagnostics') this.handlePublish(frame.params)
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  /**
   * Answer a server→client request: static configuration for
   * `workspace/configuration`, `null` for lifecycle no-ops, and JSON-RPC
   * -32601 for `workspace/applyEdit` and anything else. The client never
   * executes server edits or commands.
   * @param {number | string} id - the request id.
   * @param {string} method - the request method.
   * @param {unknown} params - the request params.
   * @returns {Promise<void>}
   */
  async handleServerRequest(id, method, params) {
    if (method === 'workspace/configuration') {
      const items = /** @type {{ items?: unknown[] } | null | undefined} */ (params)?.items
      const count = Array.isArray(items) ? items.length : 0
      await this.write({
        jsonrpc: '2.0',
        id,
        result: Array.from({ length: count }, () => this.server.configuration),
      })
      return
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      await this.write({ jsonrpc: '2.0', id, result: null })
      return
    }
    await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }

  /**
   * Correlate a response by numeric id; any shape violation is a fatal
   * protocol failure. Unknown response ids are ignored.
   * @param {number} id - the response id.
   * @param {Record<string, unknown>} frame - the response frame.
   * @returns {void}
   */
  handleResponse(id, frame) {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    if (frame.jsonrpc !== '2.0') {
      const error = new TransportError('malformed response', new Error('response must be jsonrpc 2.0'))
      entry.reject(error)
      this.poison(error)
      return
    }
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(frame, 'error')
    if (hasResult === hasError) {
      const error = new TransportError('malformed response', new Error('response must have exactly one of result or error'))
      entry.reject(error)
      this.poison(error)
      return
    }
    if (hasError) {
      const error = /** @type {{ code?: unknown, message?: unknown } | null} */ (frame.error)
      if (
        typeof error !== 'object' ||
        error === null ||
        typeof error.code !== 'number' ||
        typeof error.message !== 'string'
      ) {
        const failure = new TransportError('malformed response', new Error('error response must carry a numeric code and string message'))
        entry.reject(failure)
        this.poison(failure)
        return
      }
      entry.reject(new Error(error.message))
      return
    }
    entry.resolve(frame.result)
  }

  /**
   * Process one `textDocument/publishDiagnostics` notification: exact-URI-first
   * correlation, then version correlation, then strict consumed-field
   * projection. Cross-URI publications are ignored entirely.
   * @param {unknown} params - the notification params.
   * @returns {void}
   */
  handlePublish(params) {
    const waiter = this.waiter
    if (waiter === null || waiter.settled) return
    const record = /** @type {Record<string, unknown> | null} */ (params)
    if (typeof record !== 'object' || record === null || typeof record.uri !== 'string') {
      this.poison(new TransportError('malformed response', new Error('publishDiagnostics params must be an object with a string uri')))
      return
    }
    if (record.uri !== waiter.canonicalUri) return
    for (const key of Object.keys(record)) {
      if (key !== 'uri' && key !== 'version' && key !== 'diagnostics') {
        this.poison(new TransportError('malformed response', new Error(`unknown publishDiagnostics field ${key}`)))
        return
      }
    }
    if ('version' in record) {
      const version = record.version
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
        this.poison(new TransportError('malformed response', new Error('version must be a non-negative safe integer')))
        return
      }
      if (version < waiter.currentVersion) return
      if (version > waiter.currentVersion) {
        this.poison(new TransportError('malformed response', new Error('future version publication')))
        return
      }
    } else {
      if (!waiter.firstOpen) {
        this.poison(new TransportError('malformed response', new Error('versionless publication on a re-opened uri')))
        return
      }
      this.retireAfterClose = true
    }
    if (!Array.isArray(record.diagnostics)) {
      this.poison(new TransportError('malformed response', new Error('diagnostics must be an array')))
      return
    }
    /** @type {NormalizedDiagnostic[]} */
    const diagnostics = []
    for (const diagnostic of record.diagnostics) {
      try {
        diagnostics.push(normalizeDiagnostic(waiter.canonicalUri, diagnostic))
      } catch (error) {
        this.poison(new TransportError('malformed response', error))
        return
      }
    }
    // A publication that races the didOpen write callback is buffered, never
    // accepted: only a successfully written open generation may accept
    // notifications, and a pre-open publication must not set
    // acceptedPublication (which would suppress the allowed fresh-instance
    // retry after a failed didOpen write).
    if (!waiter.opened) {
      waiter.preOpenBatch = diagnostics
      return
    }
    this.acceptBatch(diagnostics)
  }

  /**
   * Send a request and await its response, registered before the write.
   * @param {string} method - the JSON-RPC method.
   * @param {unknown} params - the params.
   * @param {AbortSignal} [signal] - optional cancellation for this request.
   * @param {boolean} [teardownOwned] - allow during closing (teardown's shutdown).
   * @returns {Promise<unknown>}
   */
  request(method, params, signal, teardownOwned = false) {
    if (this.closing && !teardownOwned) {
      return Promise.reject(new Error('session is closing'))
    }
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(abortError(signal))
    }
    const id = this.nextId++
    /** @type {{ resolve: (value: unknown) => void, reject: (error: Error) => void, signal?: AbortSignal, onAbort?: () => void } | undefined} */
    let entry
    const promise = new Promise((resolve, reject) => {
      entry = { resolve, reject }
      this.pending.set(id, entry)
      if (signal !== undefined) {
        entry.signal = signal
        const onAbort = () => {
          if (this.pending.get(id) === entry) this.pending.delete(id)
          reject(abortError(signal))
        }
        entry.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    this.write({ jsonrpc: '2.0', id, method, params }).catch((error) => {
      if (entry === undefined || this.pending.get(id) !== entry) return
      this.pending.delete(id)
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener('abort', entry.onAbort)
      }
      const failure = new TransportError('malformed response', error)
      if (error instanceof TransportError && error.writeFailure === true) failure.writeFailure = true
      entry.reject(failure)
      if (!teardownOwned) this.poison(failure)
    })
    return promise
  }

  /**
   * Serialize one outbound frame through the single write tail.
   * @param {unknown} message - the JSON-RPC message.
   * @returns {Promise<void>}
   */
  write(message) {
    const frame = encodeMessage(message)
    const next = this.writeTail.then(
      () =>
        new Promise(/** @param {(value?: void) => void} resolve @param {(error: Error) => void} reject */ (resolve, reject) => {
          if (this.stdin === undefined) {
            reject(new TransportError('server crashed', new Error('session has no stdin')))
            return
          }
          try {
            this.stdin.write(frame, (error) => {
              if (error) {
                const failure = new TransportError('malformed response', error)
                failure.writeFailure = true
                if (!this.closing) this.poison(failure)
                reject(failure)
                return
              }
              resolve()
            })
          } catch (error) {
            const failure = new TransportError('malformed response', error)
            failure.writeFailure = true
            if (!this.closing) this.poison(failure)
            reject(failure)
          }
        }),
    )
    this.writeTail = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Single-fire transport poison: fail all pending requests and the active
   * waiter, then start the unique graceful-first teardown.
   * @param {TransportError} error - the fatal transport error.
   * @returns {void}
   */
  poison(error) {
    if (this.poisoned) return
    this.poisoned = true
    this.poisonError = error
    for (const [id, entry] of this.pending) {
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener('abort', entry.onAbort)
      }
      entry.reject(error)
    }
    this.pending.clear()
    const waiter = this.waiter
    if (waiter !== null && !waiter.settled) {
      waiter.settled = true
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.reject(error)
    }
    this.onFatal(this)
  }

  /**
   * Start the single-flight graceful-first teardown transaction.
   * @returns {Promise<void>}
   */
  startTeardown() {
    if (this.teardownPromise !== undefined) return this.teardownPromise
    this.closing = true
    const closingError = new TransportError('server crashed', new Error('session teardown started'))
    for (const entry of this.pending.values()) {
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener('abort', entry.onAbort)
      }
      entry.reject(closingError)
    }
    this.pending.clear()
    const waiter = this.waiter
    if (waiter !== null && !waiter.settled) {
      waiter.settled = true
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.resolve({ kind: 'unavailable', reason: 'diagnostics unavailable' })
    }
    this.teardownPromise = this.teardown()
    // The teardown may be started fire-and-forget (poison, eviction); keep its
    // settlement observable but never let it surface as an unhandled rejection.
    void this.teardownPromise.catch(() => {})
    return this.teardownPromise
  }

  /**
   * The unique teardown sequence: shutdown request within an independent
   * graceful budget, exit notification plus natural-close wait, whole-process-
   * tree liveness probe (bounded by the same budget), conditional
   * `terminate()` (the only hard-stop, exactly once, tree-scoped), then
   * `handle.done` and `waitForExit()`, and only then the process-lifetime
   * controller abort. Terminate is decided by whole-tree liveness, never by
   * direct-process `done` alone, so a root that exits while a helper remains
   * alive still escalates and the teardown cannot wait forever.
   * @returns {Promise<void>}
   */
  async teardown() {
    /** @type {unknown[]} */
    const errors = []
    const budget = new AbortController()
    const budgetTimer = setTimeout(() => budget.abort(), this.config.shutdownTimeoutMs)
    let treeExited = false
    try {
      try {
        await this.request('shutdown', null, budget.signal, true)
      } catch {
        // settled or failed; the transaction continues either way
      }
      if (this.stdin !== undefined) {
        try {
          await abortable(
            this.write({ jsonrpc: '2.0', method: 'exit', params: null }),
            budget.signal,
          )
        } catch {
          // same transaction; no separate termination path
        }
        try {
          if (this.handle !== undefined) {
            await abortable(this.handle.done, budget.signal)
          }
        } catch {
          // natural close did not arrive inside the graceful budget
        }
      }
      // Whole-process-tree liveness within the remaining graceful budget: a
      // resolved `true` means the tree exited; a budget abort means it is
      // still alive and the tree-scoped terminate below is required.
      if (this.handle !== undefined) {
        try {
          treeExited = (await this.handle.waitForExit(budget.signal)) === true
        } catch (error) {
          if (error instanceof Error && error.name !== 'AbortError') errors.push(error)
          treeExited = false
        }
      }
    } finally {
      clearTimeout(budgetTimer)
    }
    if (!treeExited && this.handle !== undefined) {
      try {
        this.handle.terminate()
      } catch (error) {
        errors.push(error)
      }
    }
if (this.handle !== undefined) {
      try {
        await this.handle.done
      } catch (error) {
        errors.push(error)
      }
      try {
        await this.handle.waitForExit()
      } catch (error) {
        errors.push(error)
      }
    }
    // Own the protocol write quiescence: every server-request handler and the
    // serialized write tail must settle before cleanup returns, so no queued
    // frame (responses, shutdown, exit) can be written after dispose resolves.
    // No new server-request handlers start while closing, so this terminates.
for (;;) {
      while (this.serverRequests.size > 0) {
        await Promise.allSettled([...this.serverRequests])
      }
  const tail = this.writeTail
      await tail
      if (this.writeTail === tail && this.serverRequests.size === 0) break
    }
this.lifetimeController.abort()
    this.detachStreams()
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'dsh-lsp-diagnostics session teardown failed')
    }
  }

  /**
   * Detach stdout/stdin listeners after teardown quiescence.
   * @returns {void}
   */
  detachStreams() {
    if (this.stdout !== undefined) {
      this.stdout.removeListener('data', this.onStdoutData)
      this.stdout.removeListener('error', this.onStdoutError)
    }
    if (this.stdin !== undefined && typeof this.stdin.removeListener === 'function') {
      this.stdin.removeListener('error', this.onStdinError)
    }
  }
}
