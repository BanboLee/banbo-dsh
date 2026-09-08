#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOptions, requireOption } from './lib/cli.mjs'
import { runCodeGraphScenario, runProfileScenarios } from './lib/core-scenarios.mjs'
import { readQaEnvironment } from './lib/environment.mjs'
import { MANDATORY_PLAN_IDS, REAL_SCENARIO_DRIVERS, SCENARIOS, assertCompleteResults } from './lib/plan.mjs'
import { runChild } from './lib/process.mjs'
import { runTuiScenarios } from './lib/tui-scenarios.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const TEST_CASES = {
  'SH-03': ['tests/composition/fish-rtk-coexist.spec.ts', 'tests/composition/rtk-codegraph-profile.spec.ts'],
  'FISH-01': ['tests/composition/fish-rtk-coexist.spec.ts'],
  'FISH-02': ['tests/composition/fish-rtk-coexist.spec.ts'],
  'FISH-03': ['plugins/fish-shell/tests/tool.spec.ts'],
  'RTK-01': ['plugins/rtk/tests/resolve-foreground.spec.ts'],
  'RTK-02': ['plugins/rtk/tests/background-lifecycle.spec.ts'],
  'RTK-03': ['plugins/rtk/tests/resolve-foreground.spec.ts', 'plugins/rtk/tests/background-lifecycle.spec.ts'],
  'RTK-04': ['plugins/rtk/tests/grep-compress.spec.ts'],
  'CG-01': ['tests/composition/rtk-codegraph-profile.spec.ts'],
  'CG-03': ['tests/composition/rtk-codegraph-profile.spec.ts'],
  'LLM-01': ['plugins/dsh-llm-pi-ai-with-session/tests'],
  'LLM-03': ['plugins/dsh-llm-pi-ai-with-session/tests'],
  'LSP-01': ['tests/composition/lsp-diagnostics.spec.ts', 'tests/composition/lsp-http-repair.spec.ts'],
  'LSP-02': ['tests/composition/lsp-diagnostics.spec.ts', 'tests/composition/lsp-http-repair.spec.ts'],
  'LSP-03': ['tests/composition/lsp-diagnostics.spec.ts'],
  'LSP-04': ['tests/composition/lsp-diagnostics.spec.ts'],
  'LSP-05': ['tests/composition/lsp-diagnostics.spec.ts'],
}

async function runCompositionScenarios(node, vitest, environment) {
  const results = []
  const testCache = new Map()
  for (const id of MANDATORY_PLAN_IDS) {
    if (REAL_SCENARIO_DRIVERS[id] !== 'composition') continue
    const files = TEST_CASES[id]
    if (files === undefined) throw new Error(`composition scenario is missing files: ${id}`)
    const key = files.join(',')
    if (!testCache.has(key)) {
      testCache.set(key, runChild(node, [vitest, 'run', ...files], { cwd: repoRoot, env: environment }))
    }
    await testCache.get(key)
    results.push({
      id,
      scenario: SCENARIOS[id],
      status: 'passed',
      evidence: { driver: 'exact-vitest-command', files },
    })
  }
  return results
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.get('all-core') !== true) throw new Error('--all-core is required')
  const envFile = resolve(requireOption(options, 'env-file'))
  const environment = readQaEnvironment(envFile)
  const matrixPath = resolve(requireOption(options, 'matrix'))
  const node = environment.PATH.split(':').map((path) => resolve(path, 'node'))
    .find((candidate) => candidate.includes('/v26.'))
  if (node === undefined) throw new Error('Node 26 is missing from QA PATH')
  const vitest = resolve(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
  const compositionEnvironment = {
    ...environment,
    DSH_REAL_E2E_DSH_BIN: environment.QA_REAL_DSH,
    PATH: `${dirname(environment.QA_REAL_DSH)}:${dirname(environment.QA_GO)}:${environment.PATH}`,
  }
  const profileResults = await runProfileScenarios({
    node,
    repoRoot,
    environment,
    envFile,
    matrixPath,
  })
  const compositionResults = await runCompositionScenarios(node, vitest, compositionEnvironment)
  const codegraphResult = await runCodeGraphScenario({ environment })
  const tuiResults = await runTuiScenarios(environment)
  const unordered = [...profileResults, ...compositionResults, codegraphResult, ...tuiResults]
  const results = MANDATORY_PLAN_IDS.map((id) => {
    const result = unordered.find((candidate) => candidate.id === id)
    if (result === undefined) throw new Error(`real scenario produced no result: ${id}`)
    return result
  })
  const reportPath = resolve(dirname(envFile), 'evidence', 'g6-results.json')
  writeFileSync(reportPath, `${JSON.stringify({ matrixPath, results }, null, 2)}\n`)
  assertCompleteResults(results)
  const realLspProviders = options.get('real-lsp-providers')
  let realLspEvidencePath
  if (typeof realLspProviders === 'string') {
    realLspEvidencePath = resolve(dirname(envFile), 'evidence', 'g6-real-lsp-results.json')
    const providers = realLspProviders.split(',').map((provider) => provider.trim())
    const args = [
      resolve(repoRoot, 'scripts/qa/run-lsp-real-servers.mjs'),
      '--providers', providers.join(','),
      '--evidence', realLspEvidencePath,
    ]
    for (const provider of providers) {
      args.push(`--${provider}-command`, requireOption(options, `${provider}-command`))
    }
    await runChild(node, args, { cwd: repoRoot, env: compositionEnvironment })
  }
  process.stdout.write(`${JSON.stringify({
    planIds: results.length,
    status: 'passed',
    ...(realLspEvidencePath === undefined ? {} : { realLspEvidencePath }),
  })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
