import { resolve } from 'node:path'
import { SCENARIOS } from './plan.mjs'
import { runChild } from './process.mjs'

export async function runProfileScenarios(options) {
  const dsh = resolve(options.environment.PATH.split(':')[0], 'dsh')
  const graph = await runChild(options.node, [
    resolve(options.repoRoot, 'scripts/qa/validate-dsh-tui-graph.mjs'),
    '--profile', 'dsh-tui',
    '--matrix', options.matrixPath,
    '--env-file', options.envFile,
  ], { cwd: options.repoRoot, env: options.environment })
  const graphResult = JSON.parse(graph.output)
  const dump = await runChild(dsh, ['--profile', 'dsh-tui', '--dump-config'], {
    cwd: options.environment.DSH_TUI_WORKSPACE_TARGET,
    env: options.environment,
  })
  const requiredRows = ['fish-shell', 'tool-fish', 'fish-preset-policy', 'rtk', 'lsp-diagnostics', 'banbo-agents']
  const presentRows = requiredRows.filter((row) => dump.output.includes(row))
  if (presentRows.length !== requiredRows.length) throw new Error('profile dump is missing required QA rows')
  return [
    {
      id: 'SH-01',
      scenario: SCENARIOS['SH-01'],
      status: 'passed',
      evidence: { driver: 'graph-validator', packageCount: Object.keys(graphResult.realpaths).length },
    },
    {
      id: 'SH-02',
      scenario: SCENARIOS['SH-02'],
      status: 'passed',
      evidence: { driver: 'config-dump', requiredRows: presentRows },
    },
  ]
}

