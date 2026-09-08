/**
 * Deterministic aggregate renderer for per-exec LSP diagnostics notices.
 *
 * Owns the shared single-line path sanitizer, the unique
 * `(renderPath, String(targetKey), canonicalUri)` Unicode code-point file
 * comparator (also the coordinator's scheduling oracle), the strict
 * post-eligibility discriminated-union validation, the single global
 * `maxDiagnostics` count budget, the unique canonical aggregate grammar with
 * its conditional single global advisory, and the final `maxResultChars`
 * Unicode code-point cap with the fixed `…(truncated)` marker.
 *
 * @module dsh-lsp-diagnostics/render
 */

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
 * @property {'error' | 'warning' | 'info' | 'hint' | 'unknown'} severity
 * @property {0 | 1 | 2 | 3 | 4} severityRank
 * @property {string} code
 * @property {string} source
 * @property {string} message
 */

/**
 * @typedef {'server not found' | 'server crashed' | 'timeout' | 'malformed response' | 'document too large' | 'diagnostics unavailable'} UnavailableReason
 */

/**
 * @typedef {object} RenderTarget
 * @property {string} renderPath - frozen single-line render path.
 * @property {string} targetKey - opaque stable FsTargetKey.
 * @property {string} canonicalUri - canonical document URI (audit/third sort column only).
 * @property {'diagnostics' | 'clean' | 'unavailable'} kind
 * @property {NormalizedDiagnostic[] | undefined} [diagnostics] - kind 'diagnostics' only.
 * @property {UnavailableReason | undefined} [reason] - kind 'unavailable' only.
 */

/** The unique aggregate title. */
const TITLE = '[LSP diagnostics after write]'

/** The single conditional global advisory. */
const ADVISORY = 'Fix these diagnostics before considering the change complete.'

/** The fixed truncation marker appended after the code-point char cap. */
const TRUNCATION_MARKER = '…(truncated)'

/** Severity token → sort rank: error < warning < info < hint < unknown. */
/** @type {Record<string, 0 | 1 | 2 | 3 | 4>} */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, hint: 3, unknown: 4 }

/** The closed set of unavailable reasons (workspace reasons are not in the union). */
const UNAVAILABLE_REASONS = new Set([
  'server not found',
  'server crashed',
  'timeout',
  'malformed response',
  'document too large',
  'diagnostics unavailable',
])

/**
 * Fail loud on an input that violates the renderer contract. The renderer
 * only receives coordinator-constructed data; an unknown field or shape
 * mismatch is an implementation bug, not a server condition.
 * @param {string} message - the failure detail.
 * @returns {never}
 */
function failLoud(message) {
  throw new Error(`dsh-lsp-diagnostics render: ${message}`)
}

/**
 * Require a plain object (not null, not an array).
 * @param {unknown} value - the value to check.
 * @param {string} what - field name for error messages.
 * @returns {Record<string, unknown>}
 */
function assertRecord(value, what) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failLoud(`${what} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Require a string field.
 * @param {unknown} value - the value to check.
 * @param {string} what - field name for error messages.
 * @returns {string}
 */
function assertString(value, what) {
  if (typeof value !== 'string') failLoud(`${what} must be a string`)
  return value
}

/**
 * Require exactly the given keys (no unknown, no missing).
 * @param {Record<string, unknown>} record - the object to check.
 * @param {readonly string[]} allowed - the allowed key set.
 * @param {string} what - field name for error messages.
 */
function assertExactKeys(record, allowed, what) {
  const keys = Object.keys(record).sort()
  const expected = [...allowed].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    failLoud(`${what} must have exactly the fields: ${allowed.join(', ')}`)
  }
}

/**
 * Validate a normalized position: 0-based UTF-16, integer in
 * `[0, MAX_SAFE_INTEGER)`.
 * @param {unknown} value - the raw position.
 * @param {string} what - field name for error messages.
 * @returns {NormalizedPosition}
 */
function assertPosition(value, what) {
  const record = assertRecord(value, what)
  assertExactKeys(record, ['line', 'character'], what)
  const line = record.line
  const character = record.character
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 || line >= Number.MAX_SAFE_INTEGER) {
    failLoud(`${what}.line must be an integer in [0, MAX_SAFE_INTEGER)`)
  }
  if (typeof character !== 'number' || !Number.isSafeInteger(character) || character < 0 || character >= Number.MAX_SAFE_INTEGER) {
    failLoud(`${what}.character must be an integer in [0, MAX_SAFE_INTEGER)`)
  }
  return { line, character }
}

/**
 * Validate a normalized range; `end` must not precede `start`.
 * @param {unknown} value - the raw range.
 * @param {string} what - field name for error messages.
 * @returns {NormalizedRange}
 */
function assertRange(value, what) {
  const record = assertRecord(value, what)
  assertExactKeys(record, ['start', 'end'], what)
  const start = assertPosition(record.start, `${what}.start`)
  const end = assertPosition(record.end, `${what}.end`)
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    failLoud(`${what}.end must not precede start`)
  }
  return { start, end }
}

/**
 * Validate one strict normalized diagnostic (immutable consumed-field
 * schema; unknown fields are implementation bugs).
 * @param {unknown} value - the raw diagnostic.
 * @param {string} what - field name for error messages.
 * @returns {NormalizedDiagnostic}
 */
function assertDiagnostic(value, what) {
  const record = assertRecord(value, what)
  assertExactKeys(record, ['uri', 'range', 'severity', 'severityRank', 'code', 'source', 'message'], what)
  const uri = assertString(record.uri, `${what}.uri`)
  const range = assertRange(record.range, `${what}.range`)
  const severity = assertString(record.severity, `${what}.severity`)
  if (!(severity in SEVERITY_RANK)) failLoud(`${what}.severity must be a severity token`)
  const severityRank = record.severityRank
  if (typeof severityRank !== 'number' || !Number.isInteger(severityRank) || severityRank !== SEVERITY_RANK[severity]) {
    failLoud(`${what}.severityRank must match the severity token`)
  }
  const code = assertString(record.code, `${what}.code`)
  const source = assertString(record.source, `${what}.source`)
  const message = assertString(record.message, `${what}.message`)
  return {
    uri,
    range,
    severity: /** @type {'error' | 'warning' | 'info' | 'hint' | 'unknown'} */ (severity),
    severityRank: /** @type {0 | 1 | 2 | 3 | 4} */ (severityRank),
    code,
    source,
    message,
  }
}

/**
 * Validate one discriminated-union entry; unknown fields or shape mismatches
 * fail loud.
 * @param {unknown} value - the raw entry.
 * @param {number} index - entry index for error messages.
 * @returns {RenderTarget}
 */
function assertEntry(value, index) {
  const record = assertRecord(value, `entries[${index}]`)
  const kind = record.kind
  if (kind !== 'diagnostics' && kind !== 'clean' && kind !== 'unavailable') {
    failLoud(`entries[${index}].kind must be 'diagnostics' | 'clean' | 'unavailable'`)
  }
  if (kind === 'diagnostics') {
    assertExactKeys(record, ['renderPath', 'targetKey', 'canonicalUri', 'kind', 'diagnostics'], `entries[${index}]`)
  } else if (kind === 'clean') {
    assertExactKeys(record, ['renderPath', 'targetKey', 'canonicalUri', 'kind'], `entries[${index}]`)
  } else {
    assertExactKeys(record, ['renderPath', 'targetKey', 'canonicalUri', 'kind', 'reason'], `entries[${index}]`)
  }
  const renderPath = assertString(record.renderPath, `entries[${index}].renderPath`)
  const targetKey = assertString(record.targetKey, `entries[${index}].targetKey`)
  const canonicalUri = assertString(record.canonicalUri, `entries[${index}].canonicalUri`)
  /** @type {NormalizedDiagnostic[] | undefined} */
  let diagnostics
  /** @type {UnavailableReason | undefined} */
  let reason
  if (kind === 'diagnostics') {
    if (!Array.isArray(record.diagnostics)) failLoud(`entries[${index}].diagnostics must be an array`)
    diagnostics = record.diagnostics.map((item, diagIndex) => assertDiagnostic(item, `entries[${index}].diagnostics[${diagIndex}]`))
  }
  if (kind === 'unavailable') {
    const rawReason = record.reason
    if (typeof rawReason !== 'string' || !UNAVAILABLE_REASONS.has(rawReason)) {
      failLoud(`entries[${index}].reason must be one of the closed unavailable reasons`)
    }
    reason = /** @type {UnavailableReason} */ (rawReason)
  }
  return { renderPath, targetKey, canonicalUri, kind, diagnostics, reason }
}

/**
 * Validate the renderer-facing config fields.
 * @param {unknown} value - the validated plugin configuration.
 * @returns {{ maxDiagnostics: number, maxResultChars: number, reportClean: boolean }}
 */
function assertConfig(value) {
  const record = assertRecord(value, 'config')
  const maxDiagnostics = record.maxDiagnostics
  const maxResultChars = record.maxResultChars
  const reportClean = record.reportClean
  if (typeof maxDiagnostics !== 'number' || !Number.isSafeInteger(maxDiagnostics) || maxDiagnostics < 1) {
    failLoud('maxDiagnostics must be a positive safe integer')
  }
  if (typeof maxResultChars !== 'number' || !Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
    failLoud('maxResultChars must be a positive safe integer')
  }
  if (typeof reportClean !== 'boolean') failLoud('reportClean must be a boolean')
  return { maxDiagnostics, maxResultChars, reportClean }
}

/**
 * Sanitize one string to single-line safe text with the shared rule: each
 * CRLF sequence, lone CR, LF, U+2028, or U+2029 becomes one space; every
 * other C0/C1 control character and every lone surrogate becomes U+FFFD.
 * Never adds output lines.
 * @param {string} value - the raw string.
 * @returns {string}
 */
function sanitizeToSingleLine(value) {
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
 * Compare two strings by Unicode code points: numerically per code point,
 * first differing code point decides; after a common prefix the shorter
 * string sorts first. Never uses `localeCompare`, UTF-16 code-unit default
 * order, or a binary fallback.
 * @param {string} a - first string.
 * @param {string} b - second string.
 * @returns {number} negative when `a` sorts first, positive when `b` does.
 */
function compareCodePoints(a, b) {
  let aIndex = 0
  let bIndex = 0
  for (;;) {
    const aCode = a.codePointAt(aIndex)
    const bCode = b.codePointAt(bIndex)
    if (aCode === undefined && bCode === undefined) return 0
    if (aCode === undefined) return -1
    if (bCode === undefined) return 1
    if (aCode !== bCode) return aCode < bCode ? -1 : 1
    aIndex += aCode > 0xffff ? 2 : 1
    bIndex += bCode > 0xffff ? 2 : 1
  }
}

/**
 * Compare per-file diagnostics by
 * `(start.line, start.character, severityRank, source, code, message,
 * end.line, end.character)` ascending; strings compare by code points.
 * @param {NormalizedDiagnostic} a - first diagnostic.
 * @param {NormalizedDiagnostic} b - second diagnostic.
 * @returns {number}
 */
export function compareDiagnostics(a, b) {
  const byStartLine = a.range.start.line - b.range.start.line
  if (byStartLine !== 0) return byStartLine
  const byStartCharacter = a.range.start.character - b.range.start.character
  if (byStartCharacter !== 0) return byStartCharacter
  const byRank = a.severityRank - b.severityRank
  if (byRank !== 0) return byRank
  const bySource = compareCodePoints(a.source, b.source)
  if (bySource !== 0) return bySource
  const byCode = compareCodePoints(a.code, b.code)
  if (byCode !== 0) return byCode
  const byMessage = compareCodePoints(a.message, b.message)
  if (byMessage !== 0) return byMessage
  const byEndLine = a.range.end.line - b.range.end.line
  if (byEndLine !== 0) return byEndLine
  return a.range.end.character - b.range.end.character
}

/**
 * Render one diagnostic line: 0-based UTF-16 coordinates converted to
 * 1-based, severity token, JSON-quoted source/code, sanitized message.
 * @param {NormalizedDiagnostic} diagnostic - the strict normalized diagnostic.
 * @returns {string}
 */
function renderDiagnosticLine(diagnostic) {
  const startLine = diagnostic.range.start.line + 1
  const startCharacter = diagnostic.range.start.character + 1
  const endLine = diagnostic.range.end.line + 1
  const endCharacter = diagnostic.range.end.character + 1
  const source = JSON.stringify(sanitizeToSingleLine(diagnostic.source))
  const code = JSON.stringify(sanitizeToSingleLine(diagnostic.code))
  const message = sanitizeToSingleLine(diagnostic.message)
  return `- ${diagnostic.severity} ${startLine}:${startCharacter}-${endLine}:${endCharacter} source=${source} code=${code} ${message}`
}

/**
 * Apply the `maxResultChars` code-point cap to the already-complete canonical
 * aggregate: at or below the cap return it verbatim with no marker; above the
 * cap replace the truncated suffix with the fixed `…(truncated)` marker,
 * never splitting a surrogate pair and never adding a newline. When the cap
 * is smaller than the marker itself, return only the marker's first `cap`
 * code points.
 * @param {string} text - the full canonical aggregate.
 * @param {number} cap - the positive code-point cap.
 * @returns {string}
 */
function applyCharCap(text, cap) {
  const points = Array.from(text)
  if (points.length <= cap) return text
  const marker = Array.from(TRUNCATION_MARKER)
  if (cap >= marker.length) {
    return points.slice(0, cap - marker.length).join('') + TRUNCATION_MARKER
  }
  return marker.slice(0, cap).join('')
}

/**
 * Sanitize a display path into a single-line render path.
 * @param {unknown} displayPath - the raw display path.
 * @returns {string} the single-line render path.
 */
export function sanitizeDisplayPath(displayPath) {
  return sanitizeToSingleLine(assertString(displayPath, 'displayPath'))
}

/**
 * Compare eligible targets by the unique file ordering oracle
 * `TOTAL_FILE_ORDER = (renderPath, String(targetKey), canonicalUri)`, each
 * column by Unicode code points. The coordinator schedules diagnoses and the
 * renderer orders final sections with this same function.
 * @param {unknown} a - first eligible target.
 * @param {unknown} b - second eligible target.
 * @returns {number} negative when `a` sorts first, positive when `b` does.
 */
export function compareEligibleTargets(a, b) {
  const left = assertRecord(a, 'a')
  const right = assertRecord(b, 'b')
  const aPath = assertString(left.renderPath, 'a.renderPath')
  const bPath = assertString(right.renderPath, 'b.renderPath')
  const aKey = assertString(left.targetKey, 'a.targetKey')
  const bKey = assertString(right.targetKey, 'b.targetKey')
  const aUri = assertString(left.canonicalUri, 'a.canonicalUri')
  const bUri = assertString(right.canonicalUri, 'b.canonicalUri')
  const byPath = compareCodePoints(aPath, bPath)
  if (byPath !== 0) return byPath
  const byKey = compareCodePoints(String(aKey), String(bKey))
  if (byKey !== 0) return byKey
  return compareCodePoints(aUri, bUri)
}

/**
 * Render the canonical aggregate notice for one tool execution.
 *
 * Processing order: strict-validate all entries (removing clean entries when
 * `reportClean` is false), re-sort by the shared three-column comparator,
 * sort each file's diagnostics by the unique per-file key, allocate the
 * single global `maxDiagnostics` budget across files (clean/unavailable never
 * consume it; a diagnostics file left with zero lines drops its whole
 * section), build the complete canonical aggregate with at most one global
 * advisory, and only then apply the `maxResultChars` code-point cap with the
 * fixed truncation marker.
 *
 * @param {unknown} entries - validated eligible-target entries.
 * @param {unknown} config - validated plugin configuration.
 * @returns {{ text: string | null, diagnosticCount: number, fileCount: number }}
 *   `text` is the canonical aggregate (or null when nothing survives the
 *   count cap), `diagnosticCount` the cap-retained diagnostic line count and
 *   `fileCount` the char-cap-preceding retained section count.
 */
export function renderDiagnostics(entries, config) {
  if (!Array.isArray(entries)) failLoud('entries must be an array')
  const { maxDiagnostics, maxResultChars, reportClean } = assertConfig(config)
  let targets = entries.map((entry, index) => assertEntry(entry, index))
  if (!reportClean) targets = targets.filter((target) => target.kind !== 'clean')
  targets.sort(compareEligibleTargets)
  const sections = []
  let diagnosticCount = 0
  let budget = maxDiagnostics
  for (const target of targets) {
    const renderPath = sanitizeDisplayPath(target.renderPath)
    if (target.kind === 'diagnostics') {
      const kept = (target.diagnostics ?? []).slice().sort(compareDiagnostics).slice(0, budget)
      budget -= kept.length
      if (kept.length === 0) continue
      diagnosticCount += kept.length
      sections.push(`File: ${renderPath}\n${kept.map(renderDiagnosticLine).join('\n')}`)
    } else if (target.kind === 'clean') {
      sections.push(`File: ${renderPath}\nStatus: clean`)
    } else {
      sections.push(`File: ${renderPath}\nStatus: diagnostics unavailable (${target.reason ?? 'diagnostics unavailable'})`)
    }
  }
  if (sections.length === 0) return { text: null, diagnosticCount: 0, fileCount: 0 }
  let text = `${TITLE}\n${sections.join('\n\n')}`
  if (diagnosticCount > 0) text += `\n\n${ADVISORY}`
  return { text: applyCharCap(text, maxResultChars), diagnosticCount, fileCount: sections.length }
}
