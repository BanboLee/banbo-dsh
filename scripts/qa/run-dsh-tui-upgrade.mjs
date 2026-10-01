#!/usr/bin/env node
/**
 * Isolated dsh-tui upgrade orchestration — QA gates G4, G5, G6.
 *
 * External contract (unchanged): `--gates G4,G5,G6`, `--qa-root <dir>`,
 * `--matrix <file>`; the report lands at `<qa-root>/evidence/upgrade.json` with
 * `qaRoot`, `nodeVersion`, `dshVersion`, `tarballCount` and `gates`; a failing
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
 *        `g5-pty.json`) AND the profile's interactive rows really activate —
 *        `dsh-tui-plugin-host`, `dsh-tui-extensions`, `dsh-tui-auth` and the
 *        front door `dsh-tui` reach cordis fiber state 2 and provide the
 *        services they own. A composition that renders a prompt while those
 *        rows failed their imports or stayed pending is degraded, not started.
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
  installProfile,
  packBundles,
  renderProfileFiles,
  targetTuiPackagePath,
  writeToolWrappers,
} from './lib/profile.mjs'
import { runChild } from './lib/process.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULTS = {
  node: '/home/lixingxin/.local/share/nvm/v26.7.0/bin/node',
  dsh: '/home/lixingxin/.local/share/nvm/v26.7.0/bin/dsh',
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
 * The four interactive dsh-tui rows and the services each one owns (its patch
 * rows): `dsh-tui-plugin-host` is the plugin-interop anchor, `dsh-tui-extensions`
 * mounts the plugin-facing UI seams, `dsh-tui-auth` owns subscription OAuth, and
 * the front door `dsh-tui` injects every one of them.
 */
export const INTERACTIVE_ROWS = [
  { id: 'dsh-tui-plugin-host', services: ['tuiPluginHost'] },
  { id: 'dsh-tui-extensions', services: ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiToast', 'tuiThemes'] },
  { id: 'dsh-tui-auth', services: ['dshAuth'] },
  { id: 'dsh-tui', services: [] },
]
export const GATE_NAMES = ['G4', 'G5', 'G6']

/**
 * Judge one activation snapshot. Pure: the probe only collects `{ rows }`, the
 * verdict (and the offending row names, states and missing services) lives here
 * so it can be unit-tested — and mutated — without a QA environment.
 */
export function activationVerdict(snapshot) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : []
  const failures = []
  for (const expected of INTERACTIVE_ROWS) {
    const row = rows.find((candidate) => candidate.id === expected.id)
    if (row === undefined) {
      failures.push({ id: expected.id, reason: 'row is not mounted in the booted profile' })
      continue
    }
    if (row.disabled === true) {
      failures.push({ id: expected.id, fiberState: row.fiberState ?? null, reason: 'row is administratively disabled' })
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

/** Load the installed `@deepseek-ai/dsh-app-boot` beside the global `dsh`. */
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

function snapshotInteractiveRows(ctx) {
  const loader = ctx.get('loader')
  const entries = loader === undefined || loader === null ? [] : [...loader.entries()]
  return INTERACTIVE_ROWS.map((row) => {
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
 * composition lane uses — and collect the interactive rows' fiber states and
 * services. The rows are polled until they settle: an import failure or a
 * pending row never reaches fiber state 2, so the deadline only costs time on
 * real failures.
 */
async function probeInteractiveRows({ dshBin, dshHome, profileName }) {
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
      const rows = snapshotInteractiveRows(ctx)
      const verdict = activationVerdict({ rows })
      if (verdict.passed || Date.now() >= deadline) return { ...verdict, rows }
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
export async function probeInstalledProfileActivation({ layout, environment, dshBin }) {
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
    return await probeInteractiveRows({ dshBin, dshHome: layout.dshHome, profileName: PROFILE_NAME })
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
  const layout = createQaLayout(qaRoot)
  process.once('exit', () => cleanupQaRuntimeHome(layout))
  for (const [label, path] of Object.entries(DEFAULTS)) {
    if (['clangd', 'rustAnalyzer', 'pythonLanguageServer'].includes(label)) continue
    assertExecutable(path, label)
  }
  const codegraphRealpath = realpathSync(DEFAULTS.codegraph)
  if (!codegraphRealpath.includes('/.codegraph/versions/')) {
    throw new Error(`QA_CODEGRAPH is not an official bundled release: ${codegraphRealpath}`)
  }
  const nodeVersion = (await runChild(DEFAULTS.node, ['--version'], { cwd: repoRoot, env: {} })).output.trim()
  if (!nodeVersion.startsWith(`v${matrix.nodeMajor}.`)) throw new Error(`Node version mismatch: ${nodeVersion}`)
  const dshVersion = (await runChild(DEFAULTS.node, [DEFAULTS.dsh, '--version'], { cwd: repoRoot, env: {} })).output.trim()
  if (dshVersion !== matrix.dsh) throw new Error(`dsh version mismatch: ${dshVersion}`)
  const wrappers = writeToolWrappers(layout, {
    node: DEFAULTS.node,
    dsh: DEFAULTS.dsh,
    pnpm: DEFAULTS.pnpm,
  })
  const environment = buildQaEnvironment({
    qaRoot,
    runtimeHome: layout.runtimeHome,
    nodeBin: dirname(DEFAULTS.node),
    codegraph: codegraphRealpath,
    rtk: DEFAULTS.rtk,
    typescriptLanguageServer: DEFAULTS.typescriptLanguageServer,
    gopls: DEFAULTS.gopls,
    realDsh: DEFAULTS.dsh,
    go: DEFAULTS.go,
    loopbackPort: await allocatePort(),
  })
  const envFile = writeQaEnvironment(qaRoot, environment)
  const targetTui = targetTuiPackagePath(realpathSync(DEFAULTS.dsh))
  const targetTuiVersion = JSON.parse(readFileSync(resolve(targetTui, 'package.json'), 'utf8')).version
  if (targetTuiVersion !== matrix.dshTui) throw new Error(`installed dsh-tui version mismatch: ${targetTuiVersion}`)
  const tarballs = await packBundles(repoRoot, layout, DEFAULTS.pnpm, environment, targetTui)
  await installProfile(wrappers.dsh, matrix, tarballs, repoRoot, environment)
  renderProfileFiles(repoRoot, layout, environment)

  // ── Gate steps: each one produces evidence, `runGates` derives the verdicts ──
  const graph = () => runChild(DEFAULTS.node, [
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

  const ptyStartup = async () => {
    await runChild(DEFAULTS.node, [
      resolve(repoRoot, 'scripts/qa/run-dsh-tui-pty.mjs'),
      '--case', 'startup',
      '--env-file', envFile,
    ], { cwd: repoRoot, env: environment })
    return readEvidenceFile(layout, 'g5-pty.json')
  }

  // The activation probe boots the profile in this process; the exported step
  // installs the QA-launch environment around it and restores it afterwards.
  const activation = () => probeInstalledProfileActivation({ layout, environment, dshBin: DEFAULTS.dsh })

  const realRunArgs = [
    resolve(repoRoot, 'scripts/qa/run-dsh-tui-real.mjs'),
    '--all-core',
    '--env-file', envFile,
    '--matrix', matrixPath,
  ]
  if (options.get('all-real-lsp-providers') === true) {
    realRunArgs.push(
      '--real-lsp-providers', 'typescript,go,clangd,rust,python',
      '--typescript-command', DEFAULTS.typescriptLanguageServer,
      '--go-command', DEFAULTS.gopls,
      '--clangd-command', DEFAULTS.clangd,
      '--rust-command', DEFAULTS.rustAnalyzer,
      '--python-command', DEFAULTS.pythonLanguageServer,
    )
  }
  const planResults = async () => {
    await runChild(DEFAULTS.node, realRunArgs, { cwd: repoRoot, env: environment })
    return readEvidenceFile(layout, 'g6-results.json')
  }

  const report = await runGates({ graph, composition, ptyStartup, activation, planResults })

  const evidence = {
    qaRoot,
    nodeVersion,
    dshVersion,
    tarballCount: tarballs.length,
    gates: report.gates,
    gateEvidence: report.gateEvidence,
  }
  writeFileSync(resolve(layout.evidence, 'upgrade.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  for (const name of GATE_NAMES) {
    if (report.gates[name] === 'passed') continue
    process.stderr.write(`gate ${name} FAILED: ${JSON.stringify(report.gateEvidence[name])}\n`)
  }
  process.exitCode = report.exitCode
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
