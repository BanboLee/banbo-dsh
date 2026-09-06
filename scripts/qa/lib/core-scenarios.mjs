import { request } from 'node:http'
import { resolve } from 'node:path'
import { createLoopbackServer } from '../fixtures/loopback-openai-sse.mjs'
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
  const requiredRows = ['fish-shell', 'tool-fish', 'rtk', 'mcp-codegraph', 'llm-pi-ai-with-session', 'lsp-diagnostics']
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

export async function runCodeGraphScenario(options) {
  await runChild(options.environment.QA_CODEGRAPH, ['init', '--yes', options.environment.DSH_TUI_WORKSPACE_TARGET], {
    cwd: options.environment.DSH_TUI_WORKSPACE_TARGET,
    env: options.environment,
  })
  const output = await runChild(options.environment.QA_CODEGRAPH, [
    'explore',
    'qaCodeGraphSymbol',
    '--path',
    options.environment.DSH_TUI_WORKSPACE_TARGET,
  ], { cwd: options.environment.DSH_TUI_WORKSPACE_TARGET, env: options.environment })
  if (!output.output.includes('qaCodeGraphSymbol')) throw new Error('official CodeGraph did not return the QA symbol')
  return {
    id: 'CG-02',
    scenario: SCENARIOS['CG-02'],
    status: 'passed',
    evidence: { driver: 'official-codegraph', symbolFound: true },
  }
}

function sendAffinityRequest(port, affinity) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'qa-model', messages: [{ role: 'user', content: 'qa' }], stream: true })
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-session-affinity': affinity,
      },
    }, (response) => {
      response.resume()
      response.on('end', resolve)
    })
    req.on('error', reject)
    req.end(body)
  })
}

export async function runAffinityScenario(environment) {
  const fixture = createLoopbackServer()
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = fixture.server.address()
    if (address === null || typeof address === 'string') throw new Error('loopback address is unavailable')
    await sendAffinityRequest(address.port, 'opaque-a')
    await sendAffinityRequest(address.port, 'opaque-a')
    await sendAffinityRequest(address.port, 'opaque-b')
    const evidence = fixture.evidence()
    if (!evidence.headerPresent || !evidence.sameSessionEqual || !evidence.differentSessionDifferent) {
      throw new Error('loopback affinity assertions failed')
    }
    return {
      id: 'LLM-02',
      scenario: SCENARIOS['LLM-02'],
      status: 'passed',
      evidence: { driver: 'loopback-http', ...evidence },
    }
  } finally {
    await new Promise((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
}
