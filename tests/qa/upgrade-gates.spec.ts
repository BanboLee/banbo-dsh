/**
 * Gate-derivation contract for `scripts/qa/run-dsh-tui-upgrade.mjs`.
 *
 * The upgrade orchestration used to write `gates: { G4: 'passed', G5: 'passed',
 * G6: 'passed' }` unconditionally, so a degraded dsh-tui composition (three
 * interactive rows failing their imports, the front door left pending) could
 * still be reported as a pass. These tests pin the replacement: every gate is
 * derived from the evidence of its own step, a gate whose step never ran is
 * failed rather than assumed, and a failing gate makes the run exit non-zero.
 *
 * `runGates` takes its steps as arguments, which is also what makes the mutation
 * check possible here: flipping one row of the activation snapshot to pending —
 * or injecting a throwing step — must turn the corresponding gate red.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertIsolatedQaRoot,
  buildQaEnvironment,
  cleanupQaRuntimeHome,
  createQaLayout,
} from '../../scripts/qa/lib/environment.mjs'
import {
  installProfile,
  packBundles,
  targetTuiPackagePath,
  writeToolWrappers,
} from '../../scripts/qa/lib/profile.mjs'
import {
  GATE_NAMES,
  INTERACTIVE_ROWS,
  RUNNING_FIBER_STATE,
  activationVerdict,
  exitCodeFor,
  probeInstalledProfileActivation,
  runGates,
} from '../../scripts/qa/run-dsh-tui-upgrade.mjs'

/** A healthy activation snapshot: every interactive row running with its services. */
function runningSnapshot() {
  return {
    rows: INTERACTIVE_ROWS.map((row) => ({
      id: row.id,
      mounted: true,
      disabled: false,
      fiberState: RUNNING_FIBER_STATE,
      servicesPresent: [...row.services],
    })),
  }
}

/** A snapshot with one row mutated to the given fiber state / missing service. */
function mutatedSnapshot(id: string, mutation: Record<string, unknown>) {
  const snapshot = runningSnapshot()
  return {
    rows: snapshot.rows.map((row) => (row.id === id ? { ...row, ...mutation } : row)),
  }
}

/** Every step of a healthy run, plus spies for the one-step-at-a-time cases. */
function healthySteps() {
  const steps = {
    graph: () => Promise.resolve({ validator: 'validate-dsh-tui-graph.mjs' }),
    composition: () => Promise.resolve({ rows: ['fish-shell', 'tool-fish'] }),
    ptyStartup: () => Promise.resolve({ inputReady: true, exitCode: 0 }),
    activation: () => Promise.resolve(activationVerdict(runningSnapshot())),
    planResults: () => Promise.resolve({ results: 30 }),
  }
  return steps
}

describe('upgrade gate verdicts', () => {
  it('accepts an activation snapshot where every interactive row is running', () => {
    // Given: the healthy snapshot of the four interactive rows.
    const snapshot = runningSnapshot()

    // When: the activation verdict is derived.
    const verdict = activationVerdict(snapshot)

    // Then: no row offends and the verdict passes.
    expect(verdict.failures).toEqual([])
    expect(verdict.passed).toBe(true)
  })

  it.each([
    ['pending on a service', { fiberState: 0 }],
    ['without a fiber at all', { fiberState: null }],
    ['failed its activation/import', { fiberState: 3 }],
  ])('fails a row that is %s', (_caseName, mutation) => {
    // Given: one interactive row mutated away from the running state.
    const snapshot = mutatedSnapshot('dsh-tui-extensions', mutation)

    // When: the activation verdict is derived.
    const verdict = activationVerdict(snapshot)

    // Then: the offending row is named with its state, and the verdict fails.
    expect(verdict.passed).toBe(false)
    expect(verdict.failures).toEqual([
      expect.objectContaining({ id: 'dsh-tui-extensions', fiberState: (mutation as { fiberState: number | null }).fiberState }),
    ])
  })

  it('fails the front door row when it stayed pending on the services it owns', () => {
    // Given: the front door pending exactly as the packing bug left it.
    const snapshot = mutatedSnapshot('dsh-tui', { fiberState: 0 })

    // When: the activation verdict is derived.
    const verdict = activationVerdict(snapshot)

    // Then: the front door is the offending row.
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.map((failure: { id: string }) => failure.id)).toEqual(['dsh-tui'])
  })

  it('fails a running row that does not provide the services it owns', () => {
    // Given: the extensions row running but missing one of its services.
    const snapshot = mutatedSnapshot('dsh-tui-extensions', {
      servicesPresent: ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiToast'],
    })

    // When: the activation verdict is derived.
    const verdict = activationVerdict(snapshot)

    // Then: the missing service is named.
    expect(verdict.passed).toBe(false)
    expect(verdict.failures).toEqual([
      expect.objectContaining({ id: 'dsh-tui-extensions', missingServices: ['tuiThemes'] }),
    ])
  })

  it('fails an interactive row that is not mounted at all', () => {
    // Given: a snapshot in which one row never made it into the loader.
    const snapshot = { rows: runningSnapshot().rows.filter((row) => row.id !== 'dsh-tui-auth') }

    // When: the activation verdict is derived.
    const verdict = activationVerdict(snapshot)

    // Then: the absent row is reported instead of silently ignored.
    expect(verdict.passed).toBe(false)
    expect(verdict.failures).toEqual([expect.objectContaining({ id: 'dsh-tui-auth' })])
  })

  it('passes every gate when all five steps produce their evidence', async () => {
    // Given: a healthy harness.
    const steps = healthySteps()

    // When: the gates are derived.
    const report = await runGates(steps)

    // Then: G4/G5/G6 pass, the evidence is kept per gate, and the exit code is 0.
    expect(report.gates).toEqual({ G4: 'passed', G5: 'passed', G6: 'passed' })
    expect(report.exitCode).toBe(0)
    expect(report.gateEvidence.G5.startup).toEqual({ inputReady: true, exitCode: 0 })
    expect(report.gateEvidence.G5.activation.passed).toBe(true)
    expect(report.gateEvidence.G6.planResults).toEqual({ results: 30 })
  })

  it('fails G5 and blocks G6 when a row is mutated to pending', async () => {
    // Given: a harness whose activation probe returns a pending front door.
    const steps = {
      ...healthySteps(),
      activation: () => Promise.resolve(activationVerdict(mutatedSnapshot('dsh-tui', { fiberState: 0 }))),
    }

    // When: the gates are derived.
    const report = await runGates(steps)

    // Then: G4 still passes, G5 fails with the offending row, and G6 — which
    // never ran — is failed rather than assumed, with a non-zero exit code.
    expect(report.gates).toEqual({ G4: 'passed', G5: 'failed', G6: 'failed' })
    expect(report.exitCode).toBe(1)
    expect(report.gateEvidence.G5.activation.failures).toEqual([
      expect.objectContaining({ id: 'dsh-tui', fiberState: 0 }),
    ])
    expect(report.gateEvidence.G6.error).toContain('not evaluated: G5 failed first')
  })

  it('fails G4 and does not evaluate the later gates when the graph step throws', async () => {
    // Given: a graph validation that reports an out-of-matrix dependency. The
    // composition check belongs to G4 itself, so only the G5/G6 steps count as
    // "later": they must not run behind a failed gate.
    let laterGateStepsRun = 0
    const steps = {
      ...healthySteps(),
      graph: () => Promise.reject(new Error('@banbolee/dsh-rtk resolved 1.0.0; expected 0.3.0')),
      ptyStartup: () => { laterGateStepsRun += 1; return Promise.resolve({}) },
      activation: () => { laterGateStepsRun += 1; return Promise.resolve({ passed: true }) },
      planResults: () => { laterGateStepsRun += 1; return Promise.resolve({}) },
    }

    // When: the gates are derived.
    const report = await runGates(steps)

    // Then: G4 carries the failure, G5/G6 say why they are failed, and the
    // steps behind the failing gate never ran.
    expect(report.gates).toEqual({ G4: 'failed', G5: 'failed', G6: 'failed' })
    expect(report.exitCode).toBe(1)
    expect(report.gateEvidence.G4.graph.error).toContain('expected 0.3.0')
    expect(report.gateEvidence.G5.error).toContain('not evaluated: G4 failed first')
    expect(report.gateEvidence.G6.error).toContain('not evaluated: G4 failed first')
    expect(laterGateStepsRun).toBe(0)
  })

  it('fails G5 when the PTY startup step throws but keeps the activation evidence', async () => {
    // Given: a PTY case that never reached its prompt.
    const steps = {
      ...healthySteps(),
      ptyStartup: () => Promise.reject(new Error('PTY readiness deadline exceeded')),
    }

    // When: the gates are derived.
    const report = await runGates(steps)

    // Then: both G5 checks are reported — the startup error AND the (passing)
    // activation snapshot — so the report shows what was and was not verified.
    expect(report.gates).toEqual({ G4: 'passed', G5: 'failed', G6: 'failed' })
    expect(report.exitCode).toBe(1)
    expect(report.gateEvidence.G5.startup.error).toContain('PTY readiness deadline exceeded')
    expect(report.gateEvidence.G5.activation.passed).toBe(true)
  })

  it('fails G6 without touching the earlier gates when the plan run throws', async () => {
    // Given: a plan run whose final result set is incomplete.
    const steps = {
      ...healthySteps(),
      planResults: () => Promise.reject(new Error('missing Plan IDs: TUI-08')),
    }

    // When: the gates are derived.
    const report = await runGates(steps)

    // Then: only G6 fails, and the run still exits non-zero.
    expect(report.gates).toEqual({ G4: 'passed', G5: 'passed', G6: 'failed' })
    expect(report.exitCode).toBe(1)
    expect(report.gateEvidence.G6.planResults.error).toContain('missing Plan IDs: TUI-08')
  })

  it('never reports a pass for a gate that is missing from the verdict set', () => {
    // Given: verdict sets with one gate absent or failed.
    // When/Then: only a complete all-pass set exits zero.
    expect(exitCodeFor({ G4: 'passed', G5: 'passed', G6: 'passed' })).toBe(0)
    expect(exitCodeFor({ G4: 'passed', G5: 'failed', G6: 'passed' })).toBe(1)
    expect(exitCodeFor({ G4: 'passed', G5: 'passed' })).toBe(1)
    expect(exitCodeFor(undefined)).toBe(1)
    expect(GATE_NAMES).toEqual(['G4', 'G5', 'G6'])
  })
})

// ── The G5 activation step against a real QA-packed profile ──────────────────

const TUI_BUNDLE = '@deepseek-harness-tui/dsh-tui'
const TUI_HINT = 'install it beside the global dsh CLI with `npm install -g @deepseek-harness-tui/dsh-tui@0.11.2`'
const repoRoot = resolve(import.meta.dirname, '..', '..')

function findExecutableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const dshBinary = findExecutableOnPath('dsh')
const pnpmBinary = findExecutableOnPath('pnpm')
const tuiTarget: string | undefined = dshBinary === undefined
  ? undefined
  : (() => {
    try {
      const candidate = targetTuiPackagePath(realpathSync(dshBinary))
      return existsSync(join(candidate, 'package.json')) ? candidate : undefined
    } catch {
      return undefined
    }
  })()

const missingPrerequisites = [
  ...(dshBinary === undefined ? ['the `dsh` CLI on PATH'] : []),
  ...(tuiTarget === undefined ? [`the global ${TUI_BUNDLE} package beside it — ${TUI_HINT}`] : []),
  ...(pnpmBinary === undefined ? ['`pnpm` on PATH (the QA pack step runs through it)'] : []),
]
/** A missing prerequisite SKIPS with its reason named; it never passes silently. */
const unrunnable = missingPrerequisites.length === 0
  ? undefined
  : `the QA-packed profile cannot be built here: missing ${missingPrerequisites.join('; ')}`

interface QaLayoutLike {
  readonly root: string
  readonly runtimeHome: string
  readonly dshHome: string
  readonly workspace: string
  readonly packs: string
}

let qaRoot = ''
let qa: QaLayoutLike | undefined

describe(`the G5 activation probe on a QA-packed ${TUI_BUNDLE} profile`, () => {
  beforeAll(async () => {
    if (unrunnable !== undefined) return
    const dshBin = dshBinary as string
    qaRoot = assertIsolatedQaRoot(mkdtempSync(join(tmpdir(), 'banbo-dsh-g5-probe-')), repoRoot)
    qa = createQaLayout(qaRoot) as unknown as QaLayoutLike
    const wrappers = writeToolWrappers(qa as never, {
      node: process.execPath,
      dsh: dshBin,
      pnpm: pnpmBinary as string,
    })
    // The same QA environment the upgrade orchestration builds (no QA fixture
    // slots are rendered here, so the QA_* tool paths stay empty), plus the two
    // overrides the composition lane needs: the published dsh-tui pins
    // `packageManager: pnpm@11.21.0`, and the engine manager would try to fetch
    // that copy into a store this lane does not own before it packs anything.
    const environment = {
      ...buildQaEnvironment({
        qaRoot,
        runtimeHome: qa.runtimeHome,
        nodeBin: dirname(process.execPath),
        codegraph: '',
        rtk: '',
        typescriptLanguageServer: '',
        gopls: '',
        realDsh: dshBin,
        go: '',
        loopbackPort: 1,
      }),
      NODE_ENV: 'development',
      npm_config_manage_package_manager_versions: 'false',
    }
    const tuiVersion = (JSON.parse(readFileSync(join(tuiTarget as string, 'package.json'), 'utf8')) as { version: string }).version
    const tarballs = await packBundles(repoRoot, qa as never, wrappers.pnpm, environment as never, tuiTarget as string) as string[]
    const wanted = [join(qa.packs, `deepseek-harness-tui-dsh-tui-${tuiVersion}.tgz`)]
    if (!existsSync(wanted[0] as string)) {
      throw new Error(`the QA pack step did not produce ${wanted[0]}: ${tarballs.join(', ')}`)
    }
    await installProfile(wrappers.dsh, { dshTui: tuiVersion }, wanted, repoRoot, environment as never)
  }, 600_000)

  afterAll(() => {
    if (qa !== undefined) {
      try { cleanupQaRuntimeHome(qa) } catch { /* already gone */ }
      qa = undefined
    }
    if (qaRoot.length > 0) {
      try { rmSync(qaRoot, { recursive: true, force: true }) } catch { /* best effort */ }
      qaRoot = ''
    }
  }, 120_000)

  it('reports every interactive row as running inside the really installed profile', async (ctx) => {
    if (unrunnable !== undefined) ctx.skip(unrunnable)
    const layout = qa
    if (layout === undefined) throw new Error('the QA layout was not built')

    // Given: the probe environment derived from the real lint-free QA layout…
    const environment = {
      DSH_HOME: layout.dshHome,
      HOME: layout.runtimeHome,
      PATH: `${layout.root}/bin:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    }

    // When: the real G5 activation step boots that profile.
    const verdict = await probeInstalledProfileActivation({
      layout: layout as never,
      environment: environment as never,
      dshBin: dshBinary as string,
    })

    // Then: no row offends — the four rows are running and own their services,
    // which is exactly what the gate derives its verdict from.
    expect(verdict.failures, JSON.stringify(verdict.failures)).toEqual([])
    expect(verdict.passed).toBe(true)
    const byId = new Map(verdict.rows.map((row) => [row.id, row]))
    for (const expected of INTERACTIVE_ROWS) {
      expect(byId.get(expected.id)?.fiberState, `${expected.id} fiber state`).toBe(RUNNING_FIBER_STATE)
      expect(byId.get(expected.id)?.servicesPresent, `${expected.id} services`).toEqual([...expected.services])
    }
  }, 120_000)
})
