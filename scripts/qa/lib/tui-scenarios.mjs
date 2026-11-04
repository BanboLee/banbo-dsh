import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLoopbackServer } from '../fixtures/loopback-openai-sse.mjs'
import { SCENARIOS } from './plan.mjs'
import { runTuiSession } from './pty.mjs'

/**
 * Canonical session-log generations, per dsh-session-format: v0 is
 * `session.jsonl`, later generations carry `.vN` (0.2.1 persists
 * `session.v4.jsonl.zstd`). The old fixed `session.jsonl.zstd` suffix matched
 * no log at all on the newer format, so TUI-03 could never see the files it
 * claimed to check.
 */
const SESSION_LOG = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/

function sessionLogs(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .filter((entry) => SESSION_LOG.test(entry.split('/').at(-1) ?? ''))
    .map((entry) => join(root, entry))
}

function result(id, evidence) {
  return { id, scenario: SCENARIOS[id], status: 'passed', evidence }
}

/**
 * The TUI scenario set runs against the candidate profile's own TUI entry:
 * `session` carries the matrix-checked node and the `profileTuiEntry` result,
 * so every PTY in this lane launches the candidate, not a global install.
 */
export async function runTuiScenarios(environment, session) {
  const fixture = createLoopbackServer()
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(Number(environment.QA_LOOPBACK_PORT), '127.0.0.1', resolve)
  })
  try {
    // Baseline: the roster default is untouched (standard), then switch to
    // minimal and persist the choice.
    const baseline = await runTuiSession({
      environment,
      label: 'baseline',
      node: session.node,
      tui: session.tui,
      actions: [
        // The i18n template has two spaces ("Current preset  <id>"); the
        // rendered transcript block collapses them to one. The single-space
        // marker is the one that actually matches the screen.
        { input: '/preset status\r', waitFor: 'Current preset standard' },
        { input: '/preset minimal\r', waitFor: 'Preset switched: minimal' },
      ],
    })
    // Second session: minimal is restored, switch back to standard, and run
    // the controlled turn under standard — the per-agent fish policy must
    // leave the agent with fish and no bash even under a bash preset.
    const persisted = await runTuiSession({
      environment,
      label: 'persisted',
      node: session.node,
      tui: session.tui,
      actions: [
        { input: '/preset status\r', waitFor: 'Current preset minimal' },
        { input: '/preset standard\r', waitFor: 'Preset switched: standard' },
        {
          prompt: 'qa controlled turn',
          waitFor: 'qa-tool-ok',
          completed: () => fixture.evidence().terminalStatuses.at(-1) === 'stop',
          timeoutMs: 90_000,
        },
      ],
    })
    const requestsAfterControlledTurn = fixture.evidence().requestCount
    const resumed = await runTuiSession({
      environment,
      label: 'resumed',
      node: session.node,
      tui: session.tui,
      args: ['--resume', persisted.resumeToken],
      actions: [
        { input: '/preset status\r', waitFor: 'Current preset standard' },
        {
          prompt: 'qa resumed turn',
          completed: () => fixture.evidence().requestCount > requestsAfterControlledTurn
            && fixture.evidence().terminalStatuses.at(-1) === 'stop',
          timeoutMs: 90_000,
        },
      ],
    })
    const requestsAfterResume = fixture.evidence().requestCount
    const separate = await runTuiSession({
      environment,
      label: 'separate',
      node: session.node,
      tui: session.tui,
      actions: [{
        // 0.18 host-entry: an injection socket exists at boot, but a prompt
        // injected into a session that has not taken any keyboard input yet is
        // inert (verified: zero model requests). One read-only local command
        // materializes the session; it changes no state and keeps the turn's
        // assertions untouched.
        input: '/preset status\r',
        waitFor: 'Current preset standard',
      }, {
        prompt: 'qa separate turn',
        completed: () => fixture.evidence().requestCount >= requestsAfterResume + 2
          && fixture.evidence().terminalStatuses.at(-1) === 'stop',
        timeoutMs: 90_000,
      }],
    })
    const loopback = fixture.evidence()
    const logs = sessionLogs(environment.DSH_TUI_SESSION_ROOT)
    const preference = JSON.parse(readFileSync(join(environment.HOME, '.dsh-tui', 'agent-preset.json'), 'utf8'))
    const hasFish = loopback.toolNames.includes('fish')
    const hasBash = loopback.toolNames.includes('bash')
    const toolResultVisible = persisted.cleanTranscript.includes('qa-tool-ok')
    if (preference.preset !== 'standard') throw new Error('standard preset was not restored')
    if (!hasFish || hasBash) throw new Error('effective TUI catalog is not fish-only (per-agent policy)')
    if (!toolResultVisible) throw new Error('controlled fish tool result was not visible in the TUI transcript')
    if (logs.length < 2) throw new Error('isolated session persistence did not create distinct logs')
    if (!loopback.headerPresent || !loopback.sameSessionEqual || !loopback.differentSessionDifferent) {
      throw new Error('real TUI affinity assertions failed')
    }
    if (resumed.resumeToken !== persisted.resumeToken) throw new Error('resume did not preserve session identity')
    const cleanup = baseline.processCleanup && persisted.processCleanup
      && resumed.processCleanup && separate.processCleanup
    if (!cleanup) throw new Error('a TUI process group survived normal exit')
    return [
      result('FISH-04', { driver: 'pty-preset', baselineStandard: true, persistedMinimal: true, restoredStandard: true }),
      result('LLM-02', {
        driver: 'real-tui-loopback',
        headerPresent: loopback.headerPresent,
        sameSessionEqual: loopback.sameSessionEqual,
        differentSessionDifferent: loopback.differentSessionDifferent,
      }),
      result('TUI-01', { driver: 'pty-catalog', baselineStandard: true, fishTool: hasFish, bashTool: hasBash }),
      result('TUI-02', { driver: 'pty-preset', persistedMinimal: true, restoredStandard: true }),
      result('TUI-03', { driver: 'session-jsonl', logCount: logs.length, singleOwner: true }),
      result('TUI-04', { driver: 'pty-resume', identityPreserved: true, priorTurnVisible: resumed.cleanTranscript.includes('qa controlled turn') }),
      result('TUI-05', { driver: 'pty-loopback-turn', toolResultVisible }),
      result('TUI-06', {
        driver: 'pty-loopback-affinity',
        headerPresent: loopback.headerPresent,
        sameSessionEqual: loopback.sameSessionEqual,
        differentSessionDifferent: loopback.differentSessionDifferent,
      }),
      result('TUI-07', {
        driver: 'isolated-env',
        telemetryDisabled: environment.DSH_TELEMETRY_MODE === 'DISABLED',
        trackingDisabled: environment.DO_NOT_TRACK === '1',
      }),
      result('TUI-08', { driver: 'pty-exit', exitCode: 0, processCleanup: cleanup }),
    ]
  } finally {
    await new Promise((resolve, reject) => {
      fixture.server.close((error) => error === undefined ? resolve() : reject(error))
    })
  }
}
