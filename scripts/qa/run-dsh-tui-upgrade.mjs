#!/usr/bin/env node
/**
 * Isolated dsh-tui upgrade orchestration — QA gates G4, G5, G6.
 *
 * External contract: `--gates G4,G5,G6`, `--qa-root <dir>`, `--matrix <file>`,
 * plus the three INJECTED candidates — `--node-bin`, `--dsh-bin` and
 * `--dsh-tui-bin` (the lane no longer assumes the host's nvm-installed dsh;
 * a missing one fails loud with usage). The candidate-independent host tools
 * (pnpm, rtk, codegraph, the language servers, go) keep their host paths as
 * defaults and are overridable with their own `--<tool>-bin` flags.
 *
 * The report lands at `<qa-root>/evidence/upgrade.json` with `qaRoot`,
 * `nodeVersion`, `dshVersion`, `tarballCount`, `gates` and the additive
 * `matrix` + `candidates` blocks (requested path, realpath, raw `--version`
 * output, package name/version/root for every injected candidate); a failing
 * gate makes the process exit non-zero. `gateEvidence` is additive.
 *
 * What each gate proves — the semantics are the pre-existing ones; this script
 * used to write `gates: { G4: 'passed', G5: 'passed', G6: 'passed' }`
 * unconditionally, which made a degraded dsh-tui composition unreportable:
 *
 *   G4 — the installed profile is what the matrix says: every bundle of the
 *        dependency graph resolves to exactly one matrix version from inside the
 *        isolated DSH_HOME (`validate-dsh-tui-graph.mjs`; see
 *        `tests/qa/graph.spec.ts`) and the composed config mounts the expected
 *        rows (`dsh --profile dsh-tui --dump-config`).
 *   G5 — the real dsh-tui profile STARTS, and it starts healthy: the PTY case
 *        reaches its prompt and exits cleanly (`run-dsh-tui-pty.mjs`, evidence
 *        `g5-pty.json`) AND the profile's interactive rows really activate — the
 *        rows the INSTALLED package's own bundle patch declares (minus the ones
 *        it disables on purpose) reach cordis fiber state 2 and provide the seam
 *        services this repository maps for them. A composition that renders a
 *        prompt while those rows failed their imports or stayed pending is
 *        degraded, not started.
 *   G6 — the mandatory Plan-ID real-run set completes truthfully
 *        (`run-dsh-tui-real.mjs` → evidence `g6-results.json`, enforced by
 *        `assertCompleteResults` in `scripts/qa/lib/plan.mjs`).
 *
 * Every verdict is DERIVED from that evidence (`runGates`, unit-tested in
 * `tests/qa/upgrade-gates.spec.ts`); a gate whose step never ran because an
 * earlier gate failed is reported as FAILED with that reason, never as passed.
 */
import { createServer } from 'node:net'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseOptions, requireOption } from './lib/cli.mjs'
import {
  assertIsolatedQaRoot,
  buildQaEnvironment,
  cleanupQaRuntimeHome,
  createQaLayout,
  writeQaEnvironment,
} from './lib/environment.mjs'
import {
  DSH_PACKAGE_NAME,
  TUI_PACKAGE_NAME,
  installProfile,
  packageRootFromBin,
  packBundles,
  renderProfileFiles,
  writeToolWrappers,
} from './lib/profile.mjs'
import { runChild } from './lib/process.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The three candidates the lane runs against; each MUST be injected. */
const CANDIDATE_OPTIONS = {
  node: 'node-bin',
  dsh: 'dsh-bin',
  dshTui: 'dsh-tui-bin',
}

/**
 * Candidate-INDEPENDENT host tools: the lane keeps the maintainer host's paths
 * as defaults, and every one of them can be overridden explicitly.
 */
export const EXTERNAL_TOOL_DEFAULTS = {
  pnpm: '/home/lixingxin/.local/share/pnpm/pnpm',
  rtk: '/data00/home/lixingxin/project/rtk/target/release/rtk',
  codegraph: '/home/lixingxin/.codegraph/versions/v1.6.0/bin/codegraph',
  typescriptLanguageServer: '/data00/home/lixingxin/.local/share/nvim/mason/bin/typescript-language-server',
  gopls: '/home/lixingxin/.local/bin/trae-gopls',
  clangd: '/usr/bin/clangd',
  rustAnalyzer: '/home/lixingxin/.cargo/bin/rust-analyzer',
  pythonLanguageServer: '/home/lixingxin/.local/bin/pyright-langserver',
  go: '/home/lixingxin/.goenv/shims/go',
}

const TOOL_OVERRIDE_OPTIONS = {
  pnpm: 'pnpm-bin',
  rtk: 'rtk-bin',
  codegraph: 'codegraph-bin',
  typescriptLanguageServer: 'typescript-lsp-bin',
  gopls: 'gopls-bin',
  clangd: 'clangd-bin',
  rustAnalyzer: 'rust-analyzer-bin',
  pythonLanguageServer: 'python-lsp-bin',
  go: 'go-bin',
}

const USAGE = [
  'usage: node scripts/qa/run-dsh-tui-upgrade.mjs',
  '  --gates G4,G5,G6',
  '  --qa-root <isolated OS temp dir>',
  '  --matrix <matrix.json>',
  '  --node-bin <node> --dsh-bin <dsh> --dsh-tui-bin <dsh-tui>',
  '  [--pnpm-bin <pnpm>] [--rtk-bin <rtk>] [--codegraph-bin <codegraph>]',
  '  [--typescript-lsp-bin <ts-ls>] [--gopls-bin <gopls>] [--clangd-bin <clangd>]',
  '  [--rust-analyzer-bin <rust-analyzer>] [--python-lsp-bin <pyright>] [--go-bin <go>]',
].join('\n')

/** A required candidate option, or a fail-loud usage error (never a host default). */
function requireToolOption(options, name) {
  const value = options.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required option --${name}\n${USAGE}`)
  }
  return value
}

/**
 * Resolve the injected candidates and the (overridable) host tools.
 *
 * The three candidate paths have NO defaults: the lane is meant to run against
 * an externally installed candidate prefix, and silently falling back to the
 * host's nvm dsh is exactly the bug this contract removes. The environment is
 * returned keyed by the names the lane uses (`node`, `dsh`, `dshTui`, …).
 */
export function resolveToolPaths(options) {
  const tools = {}
  for (const [key, option] of Object.entries(CANDIDATE_OPTIONS)) {
    tools[key] = requireToolOption(options, option)
  }
  for (const [key, option] of Object.entries(TOOL_OVERRIDE_OPTIONS)) {
    const override = options.get(option)
    tools[key] = typeof override === 'string' && override.length > 0 ? override : EXTERNAL_TOOL_DEFAULTS[key]
  }
  return tools
}

function realpathOrFail(requestedPath, option) {
  try {
    return realpathSync(requestedPath)
  } catch {
    throw new Error(`the injected --${option} does not exist: ${requestedPath}`)
  }
}

/**
 * `requestedPath` is what the caller passed; `realpath` is what it really is.
 * A missing launcher is recorded (not thrown) so a failed run still reports
 * which path was asked for; `inspectCandidates` is what fails loud.
 */
export function describeCandidates(tools) {
  const candidates = {}
  for (const [key, option] of Object.entries(CANDIDATE_OPTIONS)) {
    const requestedPath = resolve(tools[key])
    try {
      candidates[key] = { requestedPath, realpath: realpathSync(requestedPath) }
    } catch {
      candidates[key] = { requestedPath, error: `the injected --${option} does not exist: ${requestedPath}` }
    }
  }
  return candidates
}

/**
 * One package launcher's evidence: the path the lane was asked to use, the
 * launcher's realpath, the RAW `--version` output (launchers may print the
 * package name plus the version), and the package manifest found above it.
 */
async function inspectPackageLauncher({ requested, node, packageName, option, environment }) {
  const realpath = realpathOrFail(requested, option)
  const { root, manifest } = packageRootFromBin(realpath, packageName)
  let versionOutput
  try {
    versionOutput = (await runChild(node, [realpath, '--version'], { cwd: repoRoot, env: environment })).output.trim()
  } catch (error) {
    throw new Error(`--${option} did not answer \`--version\`: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`the package at ${root} (${packageName}) declares no version`)
  }
  return {
    requestedPath: resolve(requested),
    realpath,
    versionOutput,
    packageName: manifest.name,
    packageVersion: manifest.version,
    packageRoot: root,
  }
}

/**
 * Inspect and validate the three injected candidates against the matrix, and
 * return the evidence block the report records. `--version` output is kept
 * verbatim so a launcher that prints "package name + version" is still
 * auditable.
 */
export async function inspectCandidates(tools, matrix, environment = process.env) {
  const requestedNode = resolve(tools.node)
  const nodeRealpath = realpathOrFail(requestedNode, 'node-bin')
  const nodeVersionOutput = (await runChild(requestedNode, ['--version'], { cwd: repoRoot, env: environment })).output.trim()
  if (!nodeVersionOutput.startsWith(`v${matrix.nodeMajor}.`)) {
    throw new Error(`--node-bin reports ${nodeVersionOutput}; the matrix requires v${matrix.nodeMajor}.x`)
  }
  const node = { requestedPath: requestedNode, realpath: nodeRealpath, versionOutput: nodeVersionOutput }

  const dsh = await inspectPackageLauncher({
    requested: resolve(tools.dsh),
    node: requestedNode,
    packageName: DSH_PACKAGE_NAME,
    option: 'dsh-bin',
    environment,
  })
  if (dsh.versionOutput !== matrix.dsh) {
    throw new Error(`--dsh-bin reports ${JSON.stringify(dsh.versionOutput)}; the matrix requires ${matrix.dsh}`)
  }
  if (dsh.packageVersion !== matrix.dsh) {
    throw new Error(`--dsh-bin is package ${dsh.packageName}@${dsh.packageVersion}; the matrix requires ${matrix.dsh}`)
  }

  const dshTui = await inspectPackageLauncher({
    requested: resolve(tools.dshTui),
    node: requestedNode,
    packageName: TUI_PACKAGE_NAME,
    option: 'dsh-tui-bin',
    environment,
  })
  if (dshTui.packageVersion !== matrix.dshTui) {
    throw new Error(`--dsh-tui-bin is package ${dshTui.packageName}@${dshTui.packageVersion}; the matrix requires ${matrix.dshTui}`)
  }
  if (!dshTui.versionOutput.includes(dshTui.packageVersion)) {
    throw new Error(`--dsh-tui-bin reports ${JSON.stringify(dshTui.versionOutput)}, which does not mention the installed ${dshTui.packageVersion}`)
  }

  return { node, dsh, dshTui }
}

/** The profile `installProfile` hard-codes, and the rows the QA patch must mount. */
const PROFILE_NAME = 'dsh-tui'
const EXPECTED_ROWS = [
  'fish-shell',
  'tool-fish',
  'fish-preset-policy',
  'rtk',
  'mcp-codegraph',
  'llm-pi-ai-with-session',
  'lsp-diagnostics',
]
/** `_getState` in cordis/lib/index.js: 2 running, 3 activation error, 0 pending. */
export const RUNNING_FIBER_STATE = 2
/** How long the activation probe waits for the four rows to settle. */
const ACTIVATION_TIMEOUT_MS = 15_000
const ACTIVATION_POLL_MS = 250

/**
 * The seam CONTRACT of the G5 activation claim: the dsh-tui rows this
 * repository knows how to check, and the services each one owns (its patch
 * rows). `dsh-tui-plugin-host` is the plugin-interop anchor, `dsh-tui-extensions`
 * mounts the plugin-facing UI seams, `dsh-tui-auth` owns subscription OAuth, and
 * the front door `dsh-tui` injects every one of them.
 *
 * The ROW SET is deliberately not pinned here: which rows exist is read from the
 * installed package's own bundle patch ({@link expectedActivationRows}), so an
 * upstream rename surfaces as a failure that NAMES the seam row instead of a
 * silently narrower check. The services cannot be derived from a patch file,
 * which is why they stay mapped here.
 */
export const INTERACTIVE_SEAMS = [
  { id: 'dsh-tui-plugin-host', services: ['tuiPluginHost'] },
  { id: 'dsh-tui-extensions', services: ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiToast', 'tuiThemes'] },
  { id: 'dsh-tui-auth', services: ['dshAuth'] },
  { id: 'dsh-tui', services: [] },
]
export const GATE_NAMES = ['G4', 'G5', 'G6']

/**
 * The `dsh-tui*` row ids a bundle patch declares, in patch order.
 *
 * The ids are read with a regex rather than a YAML parser on purpose: this
 * script runs with no repository dependencies (it may be launched against a QA
 * root from anywhere), and the row-id line shape (`- id: <name>`) is all the
 * expectation set needs. A format change cannot pass silently: an empty result
 * fails the non-vacuity guard in `activationVerdict`.
 */
export function declaredRowIds(patchText) {
  if (typeof patchText !== 'string') return []
  const ids = []
  for (const match of patchText.matchAll(/^\s*-\s*id:\s*(dsh-tui\S*)\s*$/gmu)) {
    const id = match[1]
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The G5 expectation set for one installed release: every row its own patch
 * declares, with the seam services this repository maps for it — plus one
 * failure per seam row that release no longer declares, so a rename is reported
 * by name instead of shrinking the checked set.
 */
export function expectedActivationRows(patchText) {
  const declared = declaredRowIds(patchText)
  const rows = declared.map((id) => {
    const seam = INTERACTIVE_SEAMS.find((candidate) => candidate.id === id)
    return {
      id,
      // `required` marks the seam rows: a row the installed patch declares but
      // this repository has no claim about may legitimately be disabled by that
      // patch (`disabled: !!js …`), a seam row may not.
      required: seam !== undefined,
      services: seam?.services ?? [],
    }
  })
  const failures = INTERACTIVE_SEAMS
    .filter((seam) => !declared.includes(seam.id))
    .map((seam) => ({
      id: seam.id,
      reason: `the installed dsh-tui no longer declares the "${seam.id}" seam row; re-derive INTERACTIVE_SEAMS and re-validate the G5 activation claim`,
    }))
  return { rows, failures }
}

/**
 * The candidate dsh-tui package's own bundle patch (`dsh.bundle.patch`), read
 * from the package root derived from the injected `--dsh-tui-bin`. `undefined`
 * when it cannot be read: the expectation set then reads as "nothing declared",
 * which the verdict reports as a failure instead of passing.
 */
function readInstalledTuiPatch(tuiPackageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(tuiPackageRoot, 'package.json'), 'utf8'))
    const patch = join(tuiPackageRoot, manifest?.dsh?.bundle?.patch ?? 'cordis.patch.yml')
    return existsSync(patch) ? readFileSync(patch, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * Judge one activation snapshot. Pure: the probe collects `{ rows, expectedRows,
 * expectedFailures }` — the expectation set is derived from the installed
 * release, never from a version snapshot — and the verdict (with the offending
 * row names, states and missing services) lives here so it can be unit-tested —
 * and mutated — without a QA environment.
 */
export function activationVerdict(snapshot) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : []
  const expectedRows = Array.isArray(snapshot?.expectedRows) ? snapshot.expectedRows : []
  const failures = [...(Array.isArray(snapshot?.expectedFailures) ? snapshot.expectedFailures : [])]
  if (expectedRows.length === 0) {
    // Fail loud: an empty expectation set would otherwise pass by checking
    // nothing. The probe always supplies the rows the installed patch declares.
    failures.push({
      id: null,
      reason: 'the activation snapshot carries no expected rows: the probe must derive them from the installed bundle patch',
    })
  }
  for (const expected of expectedRows) {
    const row = rows.find((candidate) => candidate.id === expected.id)
    if (row === undefined) {
      failures.push({ id: expected.id, reason: 'row is not mounted in the booted profile' })
      continue
    }
    if (row.disabled === true) {
      // A declared row the installed patch disables on purpose is not an
      // offence; a SEAM row it disables is, because that is the claim.
      if (expected.required === true) {
        failures.push({ id: expected.id, fiberState: row.fiberState ?? null, reason: 'seam row is administratively disabled' })
      }
      continue
    }
    if (row.fiberState !== RUNNING_FIBER_STATE) {
      failures.push({
        id: expected.id,
        fiberState: row.fiberState ?? null,
        reason: `row is not running (fiber state ${RUNNING_FIBER_STATE}); ${String(row.fiberState ?? 'null')} means pending on an injected service or an activation/import error`,
      })
    }
    const missing = expected.services.filter((name) => !(row.servicesPresent ?? []).includes(name))
    if (missing.length > 0) {
      failures.push({
        id: expected.id,
        fiberState: row.fiberState ?? null,
        reason: 'row does not provide the services it owns',
        missingServices: missing,
      })
    }
  }
  return { passed: failures.length === 0, failures }
}

/** Non-zero as soon as one gate is not `passed` (including a gate that never ran). */
export function exitCodeFor(gates) {
  return GATE_NAMES.every((name) => gates?.[name] === 'passed') ? 0 : 1
}

/**
 * One gate check: it may throw (hard failure) or return evidence; an evidence
 * object may reject itself with `passed: false` (a derived verdict such as the
 * activation probe). Nothing is swallowed — every outcome becomes evidence.
 */
async function checkOutcome(run) {
  try {
    const result = await run()
    if (result !== undefined && typeof result === 'object' && result.passed === false) {
      return { passed: false, evidence: result }
    }
    return { passed: true, evidence: result ?? {} }
  } catch (error) {
    return { passed: false, evidence: { error: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Run the gate steps and derive G4/G5/G6 from their evidence. `steps` is injected
 * so the tests can supply a fake harness (or mutate one piece of evidence, e.g.
 * a pending row) without a QA environment.
 */
export async function runGates(steps) {
  const statuses = {}
  const evidence = {}

  const gate = async (name, checks) => {
    const collected = {}
    let passed = true
    for (const [checkName, runCheck] of Object.entries(checks)) {
      const outcome = await checkOutcome(runCheck)
      collected[checkName] = outcome.evidence
      if (!outcome.passed) passed = false
    }
    statuses[name] = passed ? 'passed' : 'failed'
    evidence[name] = collected
    return passed
  }

  const report = (blockedFrom) => {
    for (const name of GATE_NAMES) {
      if (statuses[name] === undefined) {
        statuses[name] = 'failed'
        evidence[name] = { error: `not evaluated: ${blockedFrom} failed first` }
      }
    }
    const gates = Object.fromEntries(GATE_NAMES.map((name) => [name, statuses[name]]))
    return {
      gates,
      gateEvidence: Object.fromEntries(GATE_NAMES.map((name) => [name, evidence[name]])),
      exitCode: exitCodeFor(gates),
    }
  }

  if (!(await gate('G4', { graph: steps.graph, composition: steps.composition }))) return report('G4')
  if (!(await gate('G5', { startup: steps.ptyStartup, activation: steps.activation }))) return report('G5')
  if (!(await gate('G6', { planResults: steps.planResults }))) return report('G6')
  return report('none')
}

function delay(ms) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}

/** A deployed `dsh` may be a wrapper script; the real package root is what boot needs. */
function resolveDshBin(candidate) {
  const realCandidate = realpathSync(candidate)
  const content = readFileSync(realCandidate, 'utf8')
  const wrapperTarget = /^exec "[^"]+" "([^"]+)" "\$@"$/m.exec(content)?.[1]
  if (wrapperTarget === undefined) return realCandidate
  return existsSync(wrapperTarget) ? realpathSync(wrapperTarget) : wrapperTarget
}

/** Load the installed `@deepseek-ai/dsh-app-boot` beside the candidate `dsh`. */
async function loadAppBoot(dshBin) {
  const packageRoot = dirname(dirname(resolveDshBin(dshBin)))
  const appBootUrl = pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
  const appBoot = await import(appBootUrl)
  for (const name of ['loadProfile', 'boot']) {
    if (typeof appBoot?.[name] !== 'function') throw new Error(`invalid dsh-app-boot module at ${appBootUrl}`)
  }
  return { appBoot, installAnchor: join(packageRoot, 'package.json') }
}

/** The module resolution the CLI installs before the config tree mounts. */
async function openProfileModuleResolution(appBoot, options) {
  const { createRuntimeResolution, PluginPackages, healProfilesModuleFallback } = appBoot
  if (typeof createRuntimeResolution === 'function' && PluginPackages !== undefined) {
    const resolution = await createRuntimeResolution(options)
    return async (ctx) => { await ctx.plugin(PluginPackages, { resolution }) }
  }
  await healProfilesModuleFallback?.(options)
  return undefined
}

function hasService(ctx, name) {
  try {
    return ctx.get(name) !== undefined && ctx.get(name) !== null
  } catch {
    return false
  }
}

function snapshotInteractiveRows(ctx, expectedRows) {
  const loader = ctx.get('loader')
  const entries = loader === undefined || loader === null ? [] : [...loader.entries()]
  return expectedRows.map((row) => {
    const entry = entries.find((candidate) => candidate.options?.id === row.id)
    return {
      id: row.id,
      mounted: entry !== undefined,
      disabled: entry?.disabled === true,
      fiberState: entry?.fiber?.state ?? null,
      servicesPresent: row.services.filter((name) => hasService(ctx, name)),
    }
  })
}

/**
 * Boot the installed dsh-tui profile in-process — the same harness the
 * composition lane uses — and collect the rows its own patch declares, with
 * their fiber states and seam services. The rows are polled until they settle:
 * an import failure or a pending row never reaches fiber state 2, so the
 * deadline only costs time on real failures.
 */
async function probeInteractiveRows({ dshBin, tuiPackageRoot, dshHome, profileName }) {
  const expectations = expectedActivationRows(readInstalledTuiPatch(tuiPackageRoot))
  const { appBoot, installAnchor } = await loadAppBoot(dshBin)
  const profile = appBoot.loadProfile('dsh', profileName, installAnchor, dshHome)
  const prepare = await openProfileModuleResolution(appBoot, { installAnchor, profile, home: dshHome })
  // The CLI rewrites the profile root config to the empty entry list on every
  // boot; a missing cordis.yml would fail the boot, so write the same root.
  const rootConfig = join(profile.dir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  const patches = [...profile.layers.flatMap((layer) => layer.patches ?? []), ...profile.patches]
  const ctx = await appBoot.boot('dsh', rootConfig, patches, prepare)
  try {
    const deadline = Date.now() + ACTIVATION_TIMEOUT_MS
    for (;;) {
      const rows = snapshotInteractiveRows(ctx, expectations.rows)
      const verdict = activationVerdict({
        rows,
        expectedRows: expectations.rows,
        expectedFailures: expectations.failures,
      })
      if (verdict.passed || Date.now() >= deadline) {
        return { ...verdict, rows, expectedRows: expectations.rows.map((row) => row.id) }
      }
      await delay(ACTIVATION_POLL_MS)
    }
  } finally {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Best effort: the verdict and the report matter more than a clean teardown.
    }
  }
}

/**
 * The G5 activation step: boot the installed profile IN THIS PROCESS, so it has
 * to see the same environment a `dsh --profile dsh-tui` launch gets (isolated
 * HOME/DSH_HOME, the QA PATH). The caller's environment is restored whatever
 * happens, and the verdict names every offending row.
 */
export async function probeInstalledProfileActivation({ layout, environment, dshBin, tuiPackageRoot }) {
  const savedEnvironment = {
    DSH_HOME: process.env.DSH_HOME,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PNPM_HOME: process.env.PNPM_HOME,
  }
  Object.assign(process.env, {
    DSH_HOME: layout.dshHome,
    HOME: layout.runtimeHome,
    PATH: environment.PATH,
  })
  delete process.env.PNPM_HOME
  try {
    return await probeInteractiveRows({ dshBin, tuiPackageRoot, dshHome: layout.dshHome, profileName: PROFILE_NAME })
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function allocatePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate loopback port')
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  return address.port
}

function assertExecutable(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`)
}

/** Supplementary gate evidence: a missing report file never invents a verdict. */
function readEvidenceFile(layout, name) {
  const path = join(layout.evidence, name)
  if (!existsSync(path)) return { evidenceFile: `missing: ${path}` }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { evidenceFile: `unreadable: ${path}`, error: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (requireOption(options, 'gates') !== 'G4,G5,G6') throw new Error('gates must be exactly G4,G5,G6')
  const qaRoot = assertIsolatedQaRoot(requireOption(options, 'qa-root'), repoRoot)
  const matrixPath = resolve(requireOption(options, 'matrix'))
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
  const tools = resolveToolPaths(options)
  const layout = createQaLayout(qaRoot)
  process.once('exit', () => cleanupQaRuntimeHome(layout))

  // The report is written even when the lane's setup throws: the candidate
  // identity and the requested paths are the first thing a failed run has to
  // explain. `describeCandidates` records paths; `inspectCandidates` validates.
  const evidence = {
    qaRoot,
    matrix: { path: matrixPath, nodeMajor: matrix.nodeMajor, dsh: matrix.dsh, dshTui: matrix.dshTui },
    candidates: describeCandidates(tools),
    gates: Object.fromEntries(GATE_NAMES.map((name) => [name, 'failed'])),
    gateEvidence: {},
  }
  try {
    // Version probes run against the QA HOME: the dsh-tui launcher reports the
    // profile it would delegate to, and that must never be the user's real one.
    const inspected = await inspectCandidates(tools, matrix, {
      ...process.env,
      HOME: layout.home,
      DSH_HOME: layout.dshHome,
    })
    evidence.candidates = inspected
    evidence.nodeVersion = inspected.node.versionOutput
    evidence.dshVersion = inspected.dsh.versionOutput
    const targetTui = inspected.dshTui.packageRoot

    for (const [label, path] of Object.entries(EXTERNAL_TOOL_DEFAULTS)) {
      if (['clangd', 'rustAnalyzer', 'pythonLanguageServer'].includes(label)) continue
      assertExecutable(tools[label], label)
    }
    const codegraphRealpath = realpathSync(tools.codegraph)
    if (!codegraphRealpath.includes('/.codegraph/versions/')) {
      throw new Error(`QA_CODEGRAPH is not an official bundled release: ${codegraphRealpath}`)
    }
    const wrappers = writeToolWrappers(layout, {
      node: tools.node,
      dsh: tools.dsh,
      pnpm: tools.pnpm,
    })
    const environment = buildQaEnvironment({
      qaRoot,
      runtimeHome: layout.runtimeHome,
      nodeBin: dirname(tools.node),
      codegraph: codegraphRealpath,
      rtk: tools.rtk,
      typescriptLanguageServer: tools.typescriptLanguageServer,
      gopls: tools.gopls,
      realDsh: tools.dsh,
      go: tools.go,
      loopbackPort: await allocatePort(),
    })
    const envFile = writeQaEnvironment(qaRoot, environment)
    const tarballs = await packBundles(repoRoot, layout, tools.pnpm, environment, targetTui)
    await installProfile({ wrapper: wrappers.dsh, dshBin: tools.dsh }, tarballs, repoRoot, environment)
    // Fixture state, recorded as such: the QA home is not a first-run user, so
    // dsh-tui 0.18 must not open its onboarding wizard on it.
    const fixtures = renderProfileFiles(repoRoot, layout, environment)
    evidence.fixtures = fixtures
    evidence.tarballCount = tarballs.length

    // ── Gate steps: each one produces evidence, `runGates` derives the verdicts ──
    const graph = () => runChild(tools.node, [
      resolve(repoRoot, 'scripts/qa/validate-dsh-tui-graph.mjs'),
      '--profile', PROFILE_NAME,
      '--matrix', matrixPath,
      '--env-file', envFile,
    ], { cwd: repoRoot, env: environment }).then(() => ({ validator: 'scripts/qa/validate-dsh-tui-graph.mjs' }))

    const composition = async () => {
      const dump = await runChild(wrappers.dsh, ['--profile', PROFILE_NAME, '--dump-config'], {
        cwd: layout.workspace,
        env: environment,
      })
      const missing = EXPECTED_ROWS.filter((row) => !dump.output.includes(row))
      if (missing.length > 0) throw new Error(`profile dump is missing rows: ${missing.join(', ')}`)
      return { rows: [...EXPECTED_ROWS] }
    }

    // G5 starts the TUI on BOTH 0.18 launch paths: the default in-process
    // host entry and the explicit `DSH_TUI_HOST_ENTRY=0` legacy mount. Each
    // mode's evidence is kept (and its failure named) instead of letting one
    // green path mask the other.
    const ptyStartup = async () => {
      const modes = {}
      const failures = []
      for (const mode of ['host-entry', 'legacy-fallback']) {
        try {
          await runChild(tools.node, [
            resolve(repoRoot, 'scripts/qa/run-dsh-tui-pty.mjs'),
            '--case', 'startup',
            '--env-file', envFile,
            '--matrix', matrixPath,
            '--mode', mode,
          ], { cwd: repoRoot, env: environment })
          modes[mode] = readEvidenceFile(layout, `g5-pty-${mode}.json`)
        } catch (error) {
          modes[mode] = { error: error instanceof Error ? error.message : String(error) }
          failures.push(`${mode}: ${modes[mode].error}`)
        }
      }
      if (failures.length > 0) return { passed: false, modes, failures }
      return { modes }
    }

    // The activation probe boots the profile in this process; the exported step
    // installs the QA-launch environment around it and restores it afterwards.
    const activation = () => probeInstalledProfileActivation({
      layout,
      environment,
      dshBin: tools.dsh,
      tuiPackageRoot: targetTui,
    })

    const realRunArgs = [
      resolve(repoRoot, 'scripts/qa/run-dsh-tui-real.mjs'),
      '--all-core',
      '--env-file', envFile,
      '--matrix', matrixPath,
    ]
    if (options.get('all-real-lsp-providers') === true) {
      realRunArgs.push(
        '--real-lsp-providers', 'typescript,go,clangd,rust,python',
        '--typescript-command', tools.typescriptLanguageServer,
        '--go-command', tools.gopls,
        '--clangd-command', tools.clangd,
        '--rust-command', tools.rustAnalyzer,
        '--python-command', tools.pythonLanguageServer,
      )
    }
    const planResults = async () => {
      await runChild(tools.node, realRunArgs, { cwd: repoRoot, env: environment })
      return readEvidenceFile(layout, 'g6-results.json')
    }

    const report = await runGates({ graph, composition, ptyStartup, activation, planResults })
    evidence.gates = report.gates
    evidence.gateEvidence = report.gateEvidence
    process.exitCode = report.exitCode
    for (const name of GATE_NAMES) {
      if (report.gates[name] === 'passed') continue
      process.stderr.write(`gate ${name} FAILED: ${JSON.stringify(report.gateEvidence[name])}\n`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    evidence.error = message
    evidence.gateEvidence = Object.fromEntries(
      GATE_NAMES.map((name) => [name, { error: `not evaluated: lane setup failed: ${message}` }]),
    )
    process.stderr.write(`${error instanceof Error ? error.stack ?? message : message}\n`)
    process.exitCode = 1
  } finally {
    writeFileSync(resolve(layout.evidence, 'upgrade.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  }
}

function isDirectInvocation() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url))
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
