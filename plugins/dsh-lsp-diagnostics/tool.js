import { defineTool } from '@deepseek-ai/dsh-tools'
import { sanitizeDisplayPath } from './render.js'

/** Closed runtime reasons exposed by the canonical tool output. */
const UNAVAILABLE_REASONS = [
  'server not found',
  'server crashed',
  'timeout',
  'malformed response',
  'document too large',
  'diagnostics unavailable',
]

const POSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    character: { type: 'integer', required: true },
  },
}

const RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { ...POSITION_SCHEMA, required: true },
    end: { ...POSITION_SCHEMA, required: true },
  },
}

const DIAGNOSTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { ...RANGE_SCHEMA, required: true },
    severity: {
      type: 'string',
      required: true,
      enum: ['error', 'warning', 'info', 'hint', 'unknown'],
    },
    code: { type: 'string', required: true },
    source: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
}

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'diagnostics' },
        file_path: { type: 'string', required: true },
        diagnostics: {
          type: 'array',
          required: true,
          items: DIAGNOSTIC_SCHEMA,
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'no_diagnostics' },
        file_path: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'unavailable' },
        file_path: { type: 'string', required: true },
        reason: {
          type: 'string',
          required: true,
          enum: UNAVAILABLE_REASONS,
        },
      },
    },
  ],
}

/**
 * @typedef {object} FsSeam
 * @property {(path: string, opts?: { cwd?: string, signal?: AbortSignal }) => Promise<any>} resolve
 * @property {(target: any, signal?: AbortSignal) => Promise<{ version: string, type: string, size?: number } | undefined>} stat
 * @property {(parent: any, child: any) => boolean} contains
 * @property {(target: any) => string} fileUrl
 */

/**
 * @typedef {object} RuntimeSeam
 * @property {(target: any, canonicalWorkspace: any, canonicalUri: string, signal?: AbortSignal, expectedVersion?: string) => Promise<import('./runtime.js').DiagnosisOutcome>} diagnoseTarget
 */

/**
 * @typedef {object} ToolConfig
 * @property {number} timeoutMs
 * @property {number} maxDiagnostics
 * @property {number} maxResultChars
 * @property {Record<string, { extensionToLanguage: Record<string, string> }>} servers
 */

/**
 * @typedef {object} ActiveOperation
 * @property {AbortController} controller
 * @property {AbortSignal} callerSignal
 * @property {boolean} callerAborted
 * @property {boolean} cleanupAborted
 * @property {boolean} deadlineFired
 * @property {string} filePath
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {() => void} onCallerAbort
 * @property {Promise<unknown>} promise
 */

/** Return the lowercase final suffix of a canonical file URI. */
function extensionOf(uri) {
  try {
    const pathname = new URL(uri).pathname
    const slash = pathname.lastIndexOf('/')
    const base = slash === -1 ? pathname : pathname.slice(slash + 1)
    const dot = base.lastIndexOf('.')
    return dot === -1 ? '' : base.slice(dot).toLowerCase()
  } catch {
    return ''
  }
}

/** Build a consistent cancellation error after owned work reaches quiescence. */
function abortError(signal) {
  const error = new Error('lsp_diagnostics operation aborted')
  error.name = 'AbortError'
  if (signal.reason !== undefined) {
    try {
      error.cause = signal.reason
    } catch {
      // A hostile reason getter must not break cancellation.
    }
  }
  return error
}

/** Sanitize one model-rendered field without adding lines. */
function singleLine(value) {
  return value.replace(/[\r\n\u2028\u2029]+/gu, ' ')
}

/** Keep a complete result inside the configured Unicode code-point cap. */
function capResult(text, maxResultChars) {
  const points = Array.from(text)
  if (points.length <= maxResultChars) return text
  const marker = Array.from('…(truncated)')
  if (maxResultChars < marker.length) return marker.slice(0, maxResultChars).join('')
  return points.slice(0, maxResultChars - marker.length).join('') + marker.join('')
}

/** Pure model rendering of one canonical diagnostics result. */
function renderResult(value, config) {
  const lines = ['[LSP diagnostics]', `File: ${singleLine(value.file_path)}`]
  if (value.kind === 'no_diagnostics') {
    lines.push('No diagnostics reported for this file snapshot.')
    return capResult(lines.join('\n'), config.maxResultChars)
  }
  if (value.kind === 'unavailable') {
    lines.push(`Diagnostics unavailable (${value.reason}).`)
    return capResult(lines.join('\n'), config.maxResultChars)
  }
  const shown = value.diagnostics.slice(0, config.maxDiagnostics)
  lines.push(...shown.map((diagnostic) => {
    const start = diagnostic.range.start
    const end = diagnostic.range.end
    return `- ${diagnostic.severity} ${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1} source=${JSON.stringify(singleLine(diagnostic.source))} code=${JSON.stringify(singleLine(diagnostic.code))} ${singleLine(diagnostic.message)}`
  }))
  const omitted = value.diagnostics.length - shown.length
  if (omitted > 0) {
    lines.push(`… ${omitted} more diagnostic${omitted === 1 ? '' : 's'} omitted (limit ${config.maxDiagnostics}).`)
  }
  return capResult(lines.join('\n'), config.maxResultChars)
}

/** Project a runtime diagnostic onto the strict canonical tool shape. */
function projectDiagnostic(diagnostic) {
  return {
    range: {
      start: {
        line: diagnostic.range.start.line,
        character: diagnostic.range.start.character,
      },
      end: {
        line: diagnostic.range.end.line,
        character: diagnostic.range.end.character,
      },
    },
    severity: diagnostic.severity,
    code: diagnostic.code,
    source: diagnostic.source,
    message: diagnostic.message,
  }
}

/**
 * Build the reusable model-facing tool and its direct-operation lifecycle owner.
 * Registration and plugin cleanup deliberately remain outside this pure factory.
 *
 * @param {{ fs: FsSeam, runtime: RuntimeSeam, config: ToolConfig }} deps
 * @returns {{
 *   definition: import('@deepseek-ai/dsh-tools').ToolDefinition,
 *   stopAdmission(): void,
 *   abortActiveOperations(): void,
 *   awaitActiveOperations(): Promise<void>,
 *   observeMutation(target: any): void,
 * }}
 */
export function createDiagnosticsTool({ fs, runtime, config }) {
  const supportedExtensions = new Set()
  for (const server of Object.values(config.servers)) {
    for (const extension of Object.keys(server.extensionToLanguage)) supportedExtensions.add(extension)
  }

  /** @type {Set<ActiveOperation>} */
  const activeOperations = new Set()
  /** @type {Map<string, object>} */
  const mutationEpochs = new Map()
  let admissionOpen = true

  /** Start and track one operation before its first filesystem microtask. */
  function beginOperation(callerSignal, run) {
    const controller = new AbortController()
    /** @type {ActiveOperation} */
    const operation = {
      controller,
      callerSignal,
      callerAborted: callerSignal.aborted,
      cleanupAborted: false,
      deadlineFired: false,
      filePath: '',
      timer: /** @type {ReturnType<typeof setTimeout>} */ (undefined),
      onCallerAbort: () => {},
      promise: Promise.resolve(),
    }
    operation.onCallerAbort = () => {
      operation.callerAborted = true
      if (!controller.signal.aborted) controller.abort(callerSignal.reason)
    }
    if (callerSignal.aborted) operation.onCallerAbort()
    else callerSignal.addEventListener('abort', operation.onCallerAbort, { once: true })
    operation.timer = setTimeout(() => {
      operation.deadlineFired = true
      if (!controller.signal.aborted) controller.abort(new Error('lsp_diagnostics deadline exceeded'))
    }, config.timeoutMs)
    const promise = Promise.resolve()
      .then(() => run(operation))
      .finally(() => {
        clearTimeout(operation.timer)
        callerSignal.removeEventListener('abort', operation.onCallerAbort)
        activeOperations.delete(operation)
      })
    operation.promise = promise
    activeOperations.add(operation)
    return promise
  }

  /** Throw external cancellation; report an owned deadline as canonical unavailable. */
  function abortOutcome(operation) {
    if (operation.callerAborted || operation.cleanupAborted) throw abortError(operation.callerSignal)
    if (operation.deadlineFired) {
      return { kind: 'unavailable', file_path: operation.filePath, reason: 'timeout' }
    }
    return undefined
  }

  /** Resolve, validate, diagnose, and freshness-check one target. */
  async function executeCall(filePath, workspaceRoot, operation) {
    operation.filePath = sanitizeDisplayPath(filePath)
    try {
      let early = abortOutcome(operation)
      if (early !== undefined) return early
      const signal = operation.controller.signal
      const workspace = await fs.resolve(workspaceRoot, { signal })
      early = abortOutcome(operation)
      if (early !== undefined) return early
      const workspaceInfo = await fs.stat(workspace, signal)
      early = abortOutcome(operation)
      if (early !== undefined) return early
      if (workspaceInfo === undefined || workspaceInfo.type !== 'directory') {
        throw new Error('lsp_diagnostics: session workspace is not an existing directory')
      }

      const target = await fs.resolve(filePath, { cwd: workspaceRoot, signal })
      operation.filePath = sanitizeDisplayPath(target.displayPath)
      early = abortOutcome(operation)
      if (early !== undefined) return early
      if (fs.contains(workspace, target) !== true) {
        throw new Error(`lsp_diagnostics: target is outside the session workspace: ${filePath}`)
      }
      const targetKey = String(target.targetKey ?? '')
      const mutationEpoch = mutationEpochs.get(targetKey)
      const before = await fs.stat(target, signal)
      early = abortOutcome(operation)
      if (early !== undefined) return early
      if (before === undefined) throw new Error(`lsp_diagnostics: target does not exist: ${filePath}`)
      if (before.type !== 'file') throw new Error(`lsp_diagnostics: target is not a regular file: ${filePath}`)

      const canonicalUri = fs.fileUrl(target)
      const extension = extensionOf(canonicalUri)
      if (!supportedExtensions.has(extension)) {
        const label = extension.length === 0 ? '(none)' : extension
        throw new Error(`lsp_diagnostics: no configured diagnostics provider for extension ${label}`)
      }

      const outcome = await runtime.diagnoseTarget(
        target,
        workspace,
        canonicalUri,
        signal,
        before.version,
      )
      early = abortOutcome(operation)
      if (early !== undefined) return early
      if (outcome.kind === 'stale') {
        throw new Error(`lsp_diagnostics: target changed during diagnosis: ${filePath}`)
      }

      const after = await fs.stat(target, signal)
      early = abortOutcome(operation)
      if (early !== undefined) return early
      if (
        after === undefined
        || after.type !== 'file'
        || after.version !== before.version
        || mutationEpochs.get(targetKey) !== mutationEpoch
      ) {
        throw new Error(`lsp_diagnostics: target changed during diagnosis: ${filePath}`)
      }
      if (outcome.kind === 'unavailable') {
        return { kind: 'unavailable', file_path: operation.filePath, reason: outcome.reason }
      }
      if (outcome.diagnostics.length === 0) {
        return { kind: 'no_diagnostics', file_path: operation.filePath }
      }
      return {
        kind: 'diagnostics',
        file_path: operation.filePath,
        diagnostics: outcome.diagnostics.map(projectDiagnostic),
      }
    } catch (error) {
      const early = abortOutcome(operation)
      if (early !== undefined) return early
      throw error
    }
  }

  const definition = defineTool({
    name: 'lsp_diagnostics',
    description: 'Read-only diagnostics for one existing source file using its configured language server. file_path may be workspace-relative or absolute.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'The source file to diagnose, relative to the session workspace or absolute.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderResult(value, config) }]
      },
    },
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) {
        throw new Error('lsp_diagnostics: file_path must be a non-empty string')
      }
      const workspaceRoot = exec.agent?.session.header.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
        throw new Error('lsp_diagnostics requires a session workspace cwd')
      }
      if (!admissionOpen) throw new Error('lsp_diagnostics is shutting down')
      return beginOperation(exec.signal, (operation) => executeCall(args.file_path, workspaceRoot, operation))
    },
    presentCall(args) {
      return {
        card: 'generic',
        kind: 'search',
        title: `LSP diagnostics ${args.file_path}`,
        locations: [{ path: args.file_path }],
      }
    },
  })

  function stopAdmission() {
    admissionOpen = false
  }

  function abortActiveOperations() {
    for (const operation of activeOperations) {
      operation.cleanupAborted = true
      if (!operation.controller.signal.aborted) {
        operation.controller.abort(new Error('lsp_diagnostics is shutting down'))
      }
    }
  }

  async function awaitActiveOperations() {
    while (activeOperations.size > 0) {
      await Promise.allSettled([...activeOperations].map((operation) => operation.promise))
    }
  }

  /**
   * Advance the ABA guard after an accepted mutating fs/observed event. The
   * registration layer must apply the same mutating-actor filter as the
   * collector; reads and absent observations must never call this hook.
   */
  function observeMutation(target) {
    const targetKey = String(target?.targetKey ?? '')
    if (targetKey.length > 0) mutationEpochs.set(targetKey, {})
  }

  return { definition, stopAdmission, abortActiveOperations, awaitActiveOperations, observeMutation }
}
