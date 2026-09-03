/**
 * Deterministic aggregate renderer for per-exec LSP diagnostics notices.
 *
 * Todo 1 skeleton: the shared path sanitizer, the unique
 * `(renderPath, targetKey, canonicalUri)` code-point comparator, and the
 * single canonical aggregate grammar with global count/cap handling are
 * implemented in Todo 4.
 *
 * @module dsh-lsp-diagnostics/render
 */

/**
 * Sanitize a display path into a single-line render path.
 * @param {unknown} _displayPath - the raw display path.
 * @returns {never} - implemented in Todo 4.
 */
export function sanitizeDisplayPath(_displayPath) {
  throw new Error('dsh-lsp-diagnostics: render is implemented in Todo 4')
}

/**
 * Compare eligible targets by the shared file ordering oracle.
 * @param {unknown} _a - first eligible target.
 * @param {unknown} _b - second eligible target.
 * @returns {never} - implemented in Todo 4.
 */
export function compareEligibleTargets(_a, _b) {
  throw new Error('dsh-lsp-diagnostics: render is implemented in Todo 4')
}

/**
 * Render the canonical aggregate notice.
 * @param {unknown} _entries - validated eligible-target entries.
 * @param {unknown} _config - validated plugin configuration.
 * @returns {never} - implemented in Todo 4.
 */
export function renderDiagnostics(_entries, _config) {
  throw new Error('dsh-lsp-diagnostics: render is implemented in Todo 4')
}
