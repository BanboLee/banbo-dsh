export const MANDATORY_PLAN_IDS = [
  'SH-01', 'SH-02', 'SH-03',
  'FISH-01', 'FISH-02', 'FISH-03', 'FISH-04',
  'RTK-01', 'RTK-02', 'RTK-03', 'RTK-04',
  'CG-01', 'CG-02', 'CG-03',
  'LLM-01', 'LLM-02', 'LLM-03',
  'LSP-01', 'LSP-02', 'LSP-03', 'LSP-04', 'LSP-05',
  'TUI-01', 'TUI-02', 'TUI-03', 'TUI-04',
  'TUI-05', 'TUI-06', 'TUI-07', 'TUI-08',
]

export const SCENARIOS = {
  'SH-01': 'profile-graph',
  'SH-02': 'profile-dump',
  'SH-03': 'profile-loader',
  'FISH-01': 'fish-provider',
  'FISH-02': 'fish-catalog',
  'FISH-03': 'fish-syntax',
  'FISH-04': 'tui-preset-policy',
  'RTK-01': 'rtk-run',
  'RTK-02': 'rtk-start',
  'RTK-03': 'rtk-deny',
  'RTK-04': 'rtk-grep',
  'CG-01': 'codegraph-registration',
  'CG-02': 'codegraph-read',
  'CG-03': 'codegraph-missing-command',
  'LLM-01': 'llm-route',
  'LLM-02': 'llm-affinity',
  'LLM-03': 'llm-stream',
  'LSP-01': 'lsp-ts-error',
  'LSP-02': 'lsp-ts-clean',
  'LSP-03': 'lsp-tsx-go',
  'LSP-04': 'lsp-editor-actions',
  'LSP-05': 'lsp-run-code',
  'TUI-01': 'tui-preset-baseline-standard',
  'TUI-02': 'tui-preset-persistence-standard',
  'TUI-03': 'tui-persistence',
  'TUI-04': 'tui-resume',
  'TUI-05': 'tui-turn',
  'TUI-06': 'tui-affinity',
  'TUI-07': 'tui-privacy',
  'TUI-08': 'tui-exit',
}

export const REAL_SCENARIO_DRIVERS = {
  'SH-01': 'profile-command',
  'SH-02': 'profile-command',
  'SH-03': 'composition',
  'FISH-01': 'composition',
  'FISH-02': 'composition',
  'FISH-03': 'composition',
  'FISH-04': 'pty-state',
  'RTK-01': 'composition',
  'RTK-02': 'composition',
  'RTK-03': 'composition',
  'RTK-04': 'composition',
  'CG-01': 'composition',
  'CG-02': 'codegraph',
  'CG-03': 'composition',
  'LLM-01': 'composition',
  'LLM-02': 'loopback',
  'LLM-03': 'composition',
  'LSP-01': 'composition',
  'LSP-02': 'composition',
  'LSP-03': 'composition',
  'LSP-04': 'composition',
  'LSP-05': 'composition',
  'TUI-01': 'pty-state',
  'TUI-02': 'pty-state',
  'TUI-03': 'pty-state',
  'TUI-04': 'pty-state',
  'TUI-05': 'pty-state',
  'TUI-06': 'pty-state',
  'TUI-07': 'pty-state',
  'TUI-08': 'pty-state',
}

class QaPlanError extends Error {
  name = 'QaPlanError'

  constructor(message) {
    super(message)
  }
}

function assertSanitizedEvidence(evidence, path = 'evidence') {
  if (Array.isArray(evidence)) {
    for (const [index, value] of evidence.entries()) {
      if (value !== null && typeof value === 'object') assertSanitizedEvidence(value, `${path}[${index}]`)
      if (typeof value === 'string' && /Bearer\s|production-secret/i.test(value)) {
        throw new QaPlanError(`${path}[${index}] is not sanitized`)
      }
    }
    return
  }
  if (evidence === null || typeof evidence !== 'object') {
    throw new QaPlanError(`${path} must be a sanitized object`)
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (
      /authorization|api.?key|raw.?header|prompt|session.?id|transcript/i.test(key) ||
      (typeof value === 'string' && /Bearer\s|production-secret/i.test(value))
    ) {
      throw new QaPlanError(`${path} is not sanitized: ${key}`)
    }
    if (value !== null && typeof value === 'object') assertSanitizedEvidence(value, `${path}.${key}`)
  }
}

function assertScenarioEvidence(result) {
  if (result.id === 'TUI-05' && result.evidence.toolResultVisible !== true) {
    throw new QaPlanError('Plan ID TUI-05 requires toolResultVisible=true')
  }
}

export function assertCompleteResults(results) {
  const expected = new Set(MANDATORY_PLAN_IDS)
  const seen = new Set()
  for (const result of results) {
    if (!expected.has(result.id)) throw new QaPlanError(`unknown Plan ID: ${result.id}`)
    if (seen.has(result.id)) throw new QaPlanError(`duplicate Plan ID: ${result.id}`)
    seen.add(result.id)
    if (result.scenario !== SCENARIOS[result.id]) {
      throw new QaPlanError(`Plan ID ${result.id} used the wrong scenario`)
    }
    if (result.status !== 'passed') {
      throw new QaPlanError(`Plan ID ${result.id} has non-passing status ${result.status}`)
    }
    assertSanitizedEvidence(result.evidence)
    assertScenarioEvidence(result)
  }
  const missing = MANDATORY_PLAN_IDS.filter((id) => !seen.has(id))
  if (missing.length > 0) throw new QaPlanError(`missing Plan IDs: ${missing.join(', ')}`)
  return [...results]
}
