/**
 * Docs-shape contract test for `plugins/dsh-lsp-diagnostics/README.md`.
 *
 * Asserts the structural and contract strings a user needs from the README:
 * the six required section headings, the fixed `-w` install command, the
 * named Loader surface, `enabled=false` zero runtime, the closed
 * `.ts`/`.tsx`/`.go` route, silent workspace eligibility, plugin-owned
 * fail-open and caller-abort boundaries, the real three-parameter
 * `tools/post-execute` waterfall, the independent monotonic generation
 * counter with active marker and overflow fail-safe, the shared
 * `(renderPath, String(targetKey), canonicalUri)` code-point ordering, the
 * unique aggregate grammar with count-cap section omission and conditional
 * global advisory, coordinator `active`/`retiredIo` ownership and cleanup
 * order, per-operation timer/listener release, bounded reads and
 * `FS_TOO_LARGE` mapping, the Diagnostic consumed-field vs
 * optional/extension contract, 0→1 based rendering, the hard deadline and
 * final gate, the unique session teardown order, shell boundaries, server
 * self-installation, the rc.1/`dsh-tools` peer boundary, the sync script,
 * and the verification commands. It deliberately avoids asserting
 * incidental prose.
 *
 * Every check is semantic, not a bare-token bag: sentences bind their
 * required tokens together (e.g. `FS_TOO_LARGE` must map to
 * `document too large`, `enabled=false` must bind zero services), and the
 * mutation regressions run the same `validateLspDiagnosticsReadmeContract`
 * used for the real README so the checks cannot drift loose.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const README = readFileSync(fileURLToPath(new URL('../plugins/dsh-lsp-diagnostics/README.md', import.meta.url)), 'utf8')
const ROOT_README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
const syncScriptPath = fileURLToPath(new URL('../scripts/sync-lsp-diagnostics-to-profile.sh', import.meta.url))
const SYNC_SCRIPT = existsSync(syncScriptPath) ? readFileSync(syncScriptPath, 'utf8') : ''

const REQUIRED_HEADINGS = [
  'Usage',
  'Config',
  'Behavior',
  'Model Experience',
  'Known Limitations and Deferred Work',
  'Verification',
] as const

const INSTALL_COMMAND = 'dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics'

/** Collapse all whitespace runs to single spaces so checks never depend on wrap width. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** Every sentence (split on '. ') that contains `needle`, from flattened text. */
function sentencesContaining(text: string, needle: string): string[] {
  return flat(text).split('. ').filter((sentence) => sentence.includes(needle))
}

/**
 * Validate every documentation contract of the README. Returns a non-empty
 * list of failure messages when any required commitment is missing or wrong;
 * an empty list means the README satisfies the contract.
 */
function validateLspDiagnosticsReadmeContract(readme: string): string[] {
  const failures: string[] = []
  const f = flat(readme)

  for (const heading of REQUIRED_HEADINGS) {
    if (!readme.includes(`## ${heading}`)) failures.push(`missing required heading: ## ${heading}`)
  }

  // Usage: fixed install command, sync script, named Loader surface.
  if (!readme.includes(INSTALL_COMMAND)) {
    failures.push(`missing fixed install command: ${INSTALL_COMMAND}`)
  }
  if (!readme.includes('scripts/sync-lsp-diagnostics-to-profile.sh')) {
    failures.push('missing sync script mention')
  }
  if (
    !sentencesContaining(f, 'sync-lsp-diagnostics-to-profile.sh').some((s) => s.includes('DSH_HOME'))
  ) {
    failures.push('sync script mention must bind DSH_HOME isolation')
  }
  const loader = sentencesContaining(f, 'default export')
  if (
    !loader.some(
      (s) => s.includes('no') && s.includes('name') && s.includes('inject') && s.includes('Config') && s.includes('apply'),
    )
  ) {
    failures.push('must document the named namespace surface (name/inject/Config/apply) with no default export')
  }

  // Config: enabled=false zero runtime, closed extension route.
  if (
    !sentencesContaining(f, 'enabled=false').some(
      (s) =>
        /zero|no /.test(s) &&
        s.includes('collector') &&
        s.includes('runtime') &&
        s.includes('coordinator') &&
        s.includes('listener') &&
        s.includes('process'),
    )
  ) {
    failures.push('enabled=false must bind zero collector/runtime/coordinator/listener/effect/process')
  }
  const route = sentencesContaining(f, 'extension route')
  if (!route.some((s) => s.includes('closed') && s.includes('.ts') && s.includes('typescript/typescript'))) {
    failures.push('extension route must be a closed set with .ts → typescript/typescript')
  }
  if (
    !route.some((s) => s.includes('.tsx') && s.includes('typescript/typescriptreact') && s.includes('.go') && s.includes('go/go'))
  ) {
    failures.push('extension route must map .tsx → typescript/typescriptreact and .go → go/go')
  }
  if (!route.some((s) => s.includes('fail') && s.includes('load'))) {
    failures.push('extension route violations must fail loud at load')
  }
  if (
    !route.some(
      (s) => s.includes('.c') && s.includes('clangd/c') && s.includes('.h') && s.includes('clangd/cpp'),
    )
  ) {
    failures.push('extension route must document canonical C/C++ mappings')
  }
  if (
    !route.some(
      (s) => s.includes('.rs') && s.includes('rust/rust') && s.includes('.py') && s.includes('python/python'),
    )
  ) {
    failures.push('extension route must document canonical Rust/Python mappings')
  }
  const overlay = sentencesContaining(f, 'partial overlay')
  if (
    !overlay.some(
      (s) => s.includes('servers: {}') && s.includes('TypeScript') && s.includes('Go') && s.includes('optional'),
    )
  ) {
    failures.push('servers partial overlay must preserve TypeScript/Go defaults and opt in optional providers')
  }

  // Behavior: silent eligibility, fail-open, caller abort, waterfall.
  const eligibility = sentencesContaining(f, 'silently ignored')
  if (!eligibility.some((s) => s.includes('cwd') && s.includes('workspace'))) {
    failures.push('eligibility must document silent ignore for missing/empty cwd and outside-workspace targets')
  }
  if (!sentencesContaining(f, 'workspace unavailable').some((s) => s.includes('never'))) {
    failures.push('must state workspace unavailable is never rendered')
  }
  if (!sentencesContaining(f, 'outside workspace').some((s) => s.includes('never'))) {
    failures.push('must state outside workspace is never rendered')
  }
  const failOpen = sentencesContaining(f, 'plugin-owned')
  if (!failOpen.some((s) => s.includes('fail') && s.includes('open') && s.includes('decision') && s.includes('never'))) {
    failures.push('fail-open must bind plugin-owned post-processing failure to an unchanged decision/result')
  }
  if (!failOpen.some((s) => s.includes('block'))) {
    failures.push('fail-open must state a block is never returned')
  }
  if (
    !sentencesContaining(f, 'caller abort').some(
      (s) => s.includes('ToolRuntime') && s.includes('never') && s.includes('success'),
    )
  ) {
    failures.push('caller abort must be documented as decided by ToolRuntime and never promised success')
  }
  if (
    !sentencesContaining(f, 'await next()').some(
      (s) => s.includes('(exec, _result, next)') && s.includes('exactly once') && s.includes('catch'),
    )
  ) {
    failures.push('waterfall must document (exec, _result, next) with a single await next() outside any catch')
  }

  // Model-callable direct tool: read-only existing-file scope, explicit errors,
  // canonical outcomes, and complementary automatic/direct guidance.
  const callable = sentencesContaining(f, 'lsp_diagnostics(file_path)')
  if (!callable.some((s) => s.includes('model-callable') && s.includes('read-only') && s.includes('existing file'))) {
    failures.push('lsp_diagnostics(file_path) must be documented as a model-callable read-only existing-file tool')
  }
  const explicitErrors = [
    'file_path must be a non-empty string',
    'session workspace cwd',
    'session workspace is not an existing directory',
    'target is outside the session workspace',
    'target does not exist',
    'target is not a regular file',
    'no configured diagnostics provider',
    'target changed during diagnosis',
  ]
  for (const message of explicitErrors) {
    if (!f.includes(message)) failures.push(`missing direct-tool error contract: ${message}`)
  }
  if (!f.includes('`diagnostics`') || !f.includes('`no_diagnostics`') || !f.includes('`unavailable`')) {
    failures.push('direct tool must document diagnostics/no_diagnostics/unavailable as its three canonical outcomes')
  }
  if (!f.includes('No diagnostics reported for this file snapshot.')) {
    failures.push('no_diagnostics wording must be documented exactly')
  }
  const omittedDiagnostics = sentencesContaining(f, 'omitted_diagnostics')
  if (!omittedDiagnostics.some((s) => s.includes('always-present') && s.includes('nonnegative integer'))) {
    failures.push('diagnostics must document always-present nonnegative integer omitted_diagnostics')
  }
  if (!omittedDiagnostics.some((s) => s.includes('maxDiagnostics') && s.includes('ToolRuntime/PTC') && s.includes('sorted'))) {
    failures.push('direct canonical diagnostics must be sorted and capped before ToolRuntime/PTC receives them')
  }
  const directBehavior = sentencesContaining(f, 'fresh automatic feedback')
  if (
    !directBehavior.some(
      (s) => s.includes('shell') && s.includes('formatter') && s.includes('generator') && s.includes('avoid redundant'),
    )
  ) {
    failures.push('direct guidance must prefer bypass cases and avoid redundant calls after fresh automatic feedback')
  }

  // Freshness: monotonic generation counter, active marker, overflow fail-safe.
  const generations = sentencesContaining(f, 'generation')
  if (!generations.some((s) => s.includes('monotonic') && s.includes('counter') && s.includes('never'))) {
    failures.push('generation counter must be documented as independent monotonic and never reused')
  }
  if (!generations.some((s) => s.includes('active marker') && s.includes('version'))) {
    failures.push('active marker must be documented as generation+version')
  }
  if (!generations.some((s) => s.includes('exhausted') || s.includes('fail safe'))) {
    failures.push('counter overflow must be documented as exhausted fail-safe')
  }

  // Shared ordering: one comparator for scheduling and output.
  const ordering = sentencesContaining(f, 'renderPath')
  if (
    !ordering.some(
      (s) => s.includes('String(targetKey)') && s.includes('canonicalUri') && s.includes('code point'),
    )
  ) {
    failures.push('ordering must be the shared (renderPath, String(targetKey), canonicalUri) code-point comparator')
  }
  if (!ordering.some((s) => s.includes('same') && (s.includes('scheduling') || s.includes('diagnosis')) && s.includes('order'))) {
    failures.push('ordering must bind diagnosis scheduling and rendered sections to the same order')
  }
  if (!ordering.some((s) => s.includes('displayPath') && s.includes('never'))) {
    failures.push('raw displayPath sorting must be documented as never used')
  }

  // Aggregate grammar: one title, one section per file, count-cap omission,
  // conditional global advisory, char cap after the complete canonical text.
  if (!sentencesContaining(f, '[LSP diagnostics after write]').some((s) => s.includes('one') && s.includes('title'))) {
    failures.push('aggregate must have exactly one title')
  }
  const sections = sentencesContaining(f, 'section')
  if (!sections.some((s) => s.includes('one') && s.includes('file'))) {
    failures.push('aggregate must have one section per retained file')
  }
  if (!sections.some((s) => s.includes('blank line'))) {
    failures.push('aggregate must document exactly one blank line between sections')
  }
  if (!sentencesContaining(f, 'maxDiagnostics').some((s) => s.includes('omitted') || s.includes('dropped'))) {
    failures.push('empty diagnostics sections after the global count cap must be omitted entirely')
  }
  if (!sentencesContaining(f, 'advisory').some((s) => s.includes('only') && s.includes('diagnostic'))) {
    failures.push('the global advisory must be conditional on at least one retained diagnostic')
  }
  if (!sentencesContaining(f, 'truncated').some((s) => s.includes('complete') && s.includes('canonical'))) {
    failures.push('the char cap must apply only after the complete canonical aggregate (marker replaces the truncated suffix)')
  }

  // Coordinator ownership: active + retiredIo registries, cleanup order.
  if (!sentencesContaining(f, 'retiredIo').some((s) => s.includes('active') && s.includes('registry'))) {
    failures.push('coordinator must own the active augment and retiredIo registries')
  }
  const cleanupOrder = [
    'stop direct-tool admission',
    'stop coordinator admission',
    'offTool',
    'offPost',
    'offObserved',
    'abort coordinator operations',
    'abort direct-tool operations',
    'await all active augment promises',
    'await all active direct-tool promises',
    'retiredIo',
    'runtime.dispose()',
  ]
  let pos = -1
  for (const token of cleanupOrder) {
    const at = f.indexOf(token, pos + 1)
    if (at === -1) {
      failures.push(`cleanup order missing or out of order: ${token}`)
      break
    }
    pos = at
  }
  if (
    !sentencesContaining(f, 'finally').some((s) => s.includes('timer') && s.includes('listener') && s.includes('zero'))
  ) {
    failures.push('every operation finally must clear the deadline timer and relay listeners to zero residue')
  }

  // Bounded read and error mapping.
  const reads = sentencesContaining(f, 'readBytes')
  if (!reads.some((s) => s.includes('maxDocumentBytes') && s.includes('stat') && s.includes('UTF-8'))) {
    failures.push('bounded read must bind stat size preflight + readBytes(maxDocumentBytes) + strict UTF-8 decoding')
  }
  if (!reads.some((s) => s.includes('never') && s.includes('readText'))) {
    failures.push('an unbounded readText must be documented as never used')
  }
  if (!reads.some((s) => s.includes('never') && s.includes('over-cap'))) {
    failures.push('successful over-cap byte returns must be documented as never relied on')
  }
  if (!sentencesContaining(f, 'FS_TOO_LARGE').some((s) => s.includes('document too large'))) {
    failures.push('FS_TOO_LARGE must map to document too large')
  }
  if (!sentencesContaining(f, 'other read error').some((s) => s.includes('diagnostics unavailable'))) {
    failures.push('any other read error must map to diagnostics unavailable')
  }

  // Diagnostic schema: URI/version correlation, consumed fields strict,
  // standard optionals and unknown extensions ignored, 0→1 based rendering.
  const schema = sentencesContaining(f, 'publishDiagnostics')
  if (!schema.some((s) => s.includes('URI') && s.includes('version'))) {
    failures.push('publishDiagnostics must be documented as URI-first then version correlated')
  }
  if (
    !schema.some(
      (s) => s.includes('range') && s.includes('severity') && s.includes('code') && s.includes('source') && s.includes('message'),
    )
  ) {
    failures.push('consumed fields range/severity/code/source/message must be documented')
  }
  if (
    !sentencesContaining(f, 'tags').some(
      (s) => s.includes('relatedInformation') && s.includes('codeDescription') && s.includes('data') && s.includes('ignored'),
    )
  ) {
    failures.push('tags/relatedInformation/codeDescription/data must be documented as safely ignored')
  }
  if (!sentencesContaining(f, 'unknown extension').some((s) => s.includes('ignored'))) {
    failures.push('unknown extension fields must be documented as ignored')
  }
  if (!sentencesContaining(f, '1-based').some((s) => s.includes('0-based') && s.includes('UTF-16'))) {
    failures.push('0-based UTF-16 input rendered as 1-based start-end must be documented')
  }

  // Hard deadline and final freshness gate.
  if (!sentencesContaining(f, 'deadline').some((s) => s.includes('single') && (s.includes('extend') || s.includes('extendable')))) {
    failures.push('timeoutMs must be documented as a single non-extendable deadline')
  }
  if (!sentencesContaining(f, 'final stat').some((s) => s.includes('gate'))) {
    failures.push('the final freshness round must be documented as a one-shot gate')
  }
  if (!sentencesContaining(f, 'late final stat').some((s) => s.includes('never') && s.includes('wait'))) {
    failures.push('the tool result must never wait for late final stats')
  }
  if (!sentencesContaining(f, 'deadlineAt').some((s) => s.includes('monotonic') && s.includes('now() >= deadlineAt') && s.includes('timer callback'))) {
    failures.push('direct deadline gates must enforce the monotonic equality boundary even before the timer callback')
  }

  const sessionRotation = sentencesContaining(f, 'correctness-over-performance')
  if (!sessionRotation.some((s) => s.includes('distinct canonical URI') && s.includes('version 1') && s.includes('fresh process'))) {
    failures.push('runtime must document distinct-URI reuse and fresh-process same-URI rotation at version 1')
  }

  // Unique session teardown order with terminate as the only hard stop.
  const teardownOrder = ['shutdown', 'exit', 'terminate', 'handle.done', 'waitForExit', 'processLifetimeController.abort']
  pos = -1
  for (const token of teardownOrder) {
    const at = f.indexOf(token, pos + 1)
    if (at === -1) {
      failures.push(`teardown order missing or out of order: ${token}`)
      break
    }
    pos = at
  }
  if (!sentencesContaining(f, 'hard stop').some((s) => s.includes('terminate'))) {
    failures.push('terminate must be documented as the only hard stop')
  }

  // Shell boundary and server self-installation.
  if (
    !sentencesContaining(f, 'shell').some(
      (s) => s.includes('redirect') && s.includes('sed -i') && s.includes('bypass') && (s.includes('not covered') || s.includes('out of scope')),
    )
  ) {
    failures.push('shell/redirect/sed -i bypasses must be documented as out of scope')
  }
  if (
    !sentencesContaining(f, 'typescript-language-server').some((s) => s.includes('gopls') && s.includes('install'))
  ) {
    failures.push('server self-installation must be documented for both typescript-language-server and gopls')
  }
  if (!sentencesContaining(f, 'server not found').some((s) => s.includes('fail') && s.includes('open'))) {
    failures.push('a missing server must be documented as fail open with server not found')
  }

  // rc.1 and dsh-tools peer boundary.
  if (!sentencesContaining(f, '0.1.2-rc.1').some((s) => s.includes('^0.1.2-rc.1'))) {
    failures.push('the peer range ^0.1.2-rc.1 must be documented')
  }
  if (!f.includes('@deepseek-ai/dsh-tools')) {
    failures.push('@deepseek-ai/dsh-tools must be named in the peer boundary')
  }

  // Verification and sync script shape.
  if (!readme.includes('pnpm exec vitest run tests/docs-shape-lsp-diagnostics.spec.ts')) {
    failures.push('missing docs-shape verification command')
  }
  if (!readme.includes('pnpm exec vitest run plugins/dsh-lsp-diagnostics')) {
    failures.push('missing plugin regression verification command')
  }
  if (
    !readme.includes('RUN_REAL_LSP_SERVERS=1')
    || !readme.includes('scripts/qa/run-lsp-real-servers.mjs')
    || !readme.includes('REAL_LSP_PROVIDERS')
  ) {
    failures.push('missing explicit real-server lane command')
  }
  if (
    !sentencesContaining(f, 'machine-readable evidence').some(
      (s) => s.includes('blocked') && s.includes('nonzero'),
    )
  ) {
    failures.push('real-server evidence must document blocked nonzero missing-executable behavior')
  }
  if (!readme.includes('bash scripts/sync-lsp-diagnostics-to-profile.sh --help')) {
    failures.push('missing sync script --help verification command')
  }
  if (!SYNC_SCRIPT.includes('--help')) failures.push('sync script must support --help')
  if (!SYNC_SCRIPT.includes('DSH_HOME')) failures.push('sync script must require DSH_HOME')
  if (!SYNC_SCRIPT.includes('add -w')) failures.push('sync script must install with -w')
  if (!SYNC_SCRIPT.includes('./plugins/dsh-lsp-diagnostics')) failures.push('sync script must reference the local bundle')

  return failures
}

describe('dsh-lsp-diagnostics README shape', () => {
  it('has every required section heading', () => {
    for (const heading of REQUIRED_HEADINGS) {
      expect(README, `missing required heading: ## ${heading}`).toContain(`## ${heading}`)
    }
  })

  it('documents the fixed install command with -w and <profile>', () => {
    expect(README).toContain(INSTALL_COMMAND)
  })

  it('adds the lsp-diagnostics install command to the root README', () => {
    expect(ROOT_README).toContain(INSTALL_COMMAND)
  })

  it('documents the named Loader surface with no default export', () => {
    expect(
      sentencesContaining(flat(README), 'default export').some(
        (s) => s.includes('no') && s.includes('name') && s.includes('inject') && s.includes('Config') && s.includes('apply'),
      ),
    ).toBe(true)
  })

  it('documents the closed canonical extension route', () => {
    const route = sentencesContaining(flat(README), 'extension route')
    expect(route.some((s) => s.includes('closed') && s.includes('.ts') && s.includes('typescript/typescript'))).toBe(true)
    expect(route.some((s) => s.includes('.tsx') && s.includes('typescript/typescriptreact') && s.includes('.go') && s.includes('go/go'))).toBe(true)
    expect(route.some((s) => s.includes('.c') && s.includes('clangd/c') && s.includes('.h') && s.includes('clangd/cpp'))).toBe(true)
    expect(route.some((s) => s.includes('.rs') && s.includes('rust/rust') && s.includes('.py') && s.includes('python/python'))).toBe(true)
    expect(route.some((s) => s.includes('fail') && s.includes('load'))).toBe(true)
  })

  it('documents default-preserving provider-level partial overlays', () => {
    expect(README).toContain('partial overlay')
    expect(README).toContain('servers: {}')
    expect(README).toContain('/path/trae-gopls')
  })

  it('documents silent workspace eligibility without unavailable notices', () => {
    expect(README).toContain('silently ignored')
    expect(README).toContain('workspace unavailable')
    expect(README).toContain('outside workspace')
  })

  it('documents fail-open and caller-abort boundaries', () => {
    expect(README).toContain('plugin-owned')
    expect(README).toContain('caller abort')
    expect(README).toContain('ToolRuntime')
  })

  it('documents the real three-parameter post-execute waterfall', () => {
    expect(README).toContain('(exec, _result, next)')
    expect(README).toContain('await next()')
  })

  it('documents the monotonic generation counter and active marker', () => {
    expect(README).toContain('monotonic')
    expect(README).toContain('active marker')
    expect(README).toContain('exhausted')
  })

  it('documents the shared (renderPath, String(targetKey), canonicalUri) ordering', () => {
    expect(README).toContain('(renderPath, String(targetKey), canonicalUri)')
    expect(README).toContain('code point')
  })

  it('documents the aggregate grammar and caps', () => {
    expect(README).toContain('[LSP diagnostics after write]')
    expect(README).toContain('maxDiagnostics')
    expect(README).toContain('maxResultChars')
    expect(README).toContain('(truncated)')
  })

  it('documents coordinator active + retiredIo ownership and cleanup order', () => {
    expect(README).toContain('retiredIo')
    expect(README).toContain('stop direct-tool admission')
    expect(README).toContain('stop coordinator admission')
    expect(README).toContain('offTool')
    expect(README).toContain('offPost')
    expect(README).toContain('offObserved')
    expect(README).toContain('runtime.dispose()')
  })

  it('documents bounded reads and FS_TOO_LARGE/other-error mapping', () => {
    expect(README).toContain('readBytes')
    expect(README).toContain('FS_TOO_LARGE')
    expect(README).toContain('document too large')
    expect(README).toContain('diagnostics unavailable')
  })

  it('documents Diagnostic consumed-field strictness and optional/extension tolerance', () => {
    expect(README).toContain('relatedInformation')
    expect(README).toContain('codeDescription')
    expect(README).toContain('unknown extension')
  })

  it('documents 0-based UTF-16 to 1-based rendering', () => {
    expect(README).toContain('0-based')
    expect(README).toContain('1-based')
  })

  it('documents the hard deadline, final gate, and teardown order', () => {
    expect(README).toContain('non-extendable')
    expect(README).toContain('final stat')
    expect(README).toContain('processLifetimeController.abort()')
  })

  it('documents shell boundaries and server self-installation', () => {
    expect(README).toContain('sed -i')
    expect(README).toContain('typescript-language-server')
    expect(README).toContain('gopls')
  })

  it('documents the rc.1 and dsh-tools peer boundary', () => {
    expect(README).toContain('0.1.2-rc.1')
    expect(README).toContain('^0.1.2-rc.1')
    expect(README).toContain('@deepseek-ai/dsh-tools')
  })

  it('documents the sync script and verification commands', () => {
    expect(README).toContain('scripts/sync-lsp-diagnostics-to-profile.sh')
    expect(README).toContain('pnpm exec vitest run tests/docs-shape-lsp-diagnostics.spec.ts')
    expect(README).toContain('pnpm dlx --package=typescript@6.0.3 tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit')
    expect(README).toContain('scripts/qa/run-lsp-real-servers.mjs')
  })

  it('satisfies the full documentation behavior contract', () => {
    expect(validateLspDiagnosticsReadmeContract(README)).toEqual([])
  })

  // --- Mutation regressions: every check must stay semantically bound. ---

  it('rejects a README that claims shell bypasses are diagnosed (mutation regression)', () => {
    const mutated = README.replace('are out of scope for automatic', 'are always diagnosed by automatic')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that promises caller abort success (mutation regression)', () => {
    const mutated = README.replace('is never swallowed', 'is always swallowed')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README with a two-parameter post-execute listener (mutation regression)', () => {
    const mutated = README.replace('(exec, _result, next)', '(exec, next)')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that falls back to raw displayPath ordering (mutation regression)', () => {
    const mutated = README.replace('are never used', 'are used as a tie-breaking fallback')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that reuses generations after retire (mutation regression)', () => {
    const mutated = README.replace('never reused within one plugin lifetime', 'reused after retire within one plugin lifetime')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README whose cleanup disposes the runtime before awaiting retiredIo (mutation regression)', () => {
    const mutated = README.replace(
      /await all\s+active direct-tool promises \u2192 await all `retiredIo` \u2192 `runtime\.dispose\(\)`/,
      '`runtime.dispose()` \u2192 await all active direct-tool promises \u2192 await all `retiredIo`',
    )
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that waits for late final stats (mutation regression)', () => {
    const mutated = README.replace('never waits for late final stats', 'waits for late final stats')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that mis-maps FS_TOO_LARGE (mutation regression)', () => {
    const mutated = README.replace('maps to `document too large`', 'maps to `diagnostics unavailable`')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that makes unknown Diagnostic extensions fatal (mutation regression)', () => {
    const mutated = README.replace('unknown extension fields are safely ignored', 'unknown extension fields are fatal')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that aborts the lifetime controller before process-tree exit (mutation regression)', () => {
    const mutated = README.replace(
      'await `handle.done` and `waitForExit()` \u2192 `processLifetimeController.abort()`',
      '`processLifetimeController.abort()` \u2192 await `handle.done` and `waitForExit()`',
    )
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that restores the old dsh peer family (mutation regression)', () => {
    const mutated = README.replaceAll('^0.1.2-rc.1', '>=0.1.1-rc.2 <0.1.2-0')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that drops the dsh-tools peer (mutation regression)', () => {
    const mutated = README.replace('@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-subprocess')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that relies on successful over-cap byte returns (mutation regression)', () => {
    const mutated = README.replace('never relies on or returns over-cap bytes', 'always relies on over-cap bytes')
    expect(mutated).not.toEqual(README)
    expect(validateLspDiagnosticsReadmeContract(mutated)).not.toEqual([])
  })
})
