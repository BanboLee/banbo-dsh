/**
 * Docs-shape contract test for `plugins/codegraph-mcp/README.md`.
 *
 * Asserts the structural and contract strings a user needs from the README:
 * the six required section headings, the official `@deepseek-ai/dsh-mcp-client`
 * bridge, the server-qualified `mcp__codegraph__*` tool naming, the default
 * row (`CODEGRAPH_NO_DAEMON=1`, stdio `codegraph serve --mcp`, no pinned
 * path), the workspace-root install command form (with `-w`), the `--path`
 * profile override as whole-config replacement (no deep merge), the
 * tools-only bridge limitation (Resources/Prompts not bridged), the
 * deterministic fake-MCP verification story (no live binary/daemon/network),
 * and the telemetry/update-check opt-out env options.
 *
 * The checks are section-scoped and binding, not bare token bags: each
 * required commitment is asserted inside the section that must state it, so
 * a reworded or relocated claim is caught. The mutation regression tests run
 * the same `validateCodegraphReadmeContract` used for the real README and pin
 * the scenarios a loose token-bag predicate would miss: `CODEGRAPH_NO_DAEMON`
 * removed, a resources/prompts-bridged claim, the `-w` flag dropped, the
 * `--path` override gutted, and raw (non-server-qualified) tool names
 * surfaced in Model Experience.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const README = readFileSync(fileURLToPath(new URL('../plugins/codegraph-mcp/README.md', import.meta.url)), 'utf8')

const REQUIRED_HEADINGS = [
  'Usage',
  'Config',
  'Profile override for project path',
  'Model Experience',
  'Known Limitations and Deferred Work',
  'Verification',
] as const

/** Extract the body of a `## <heading>` section (exclusive of the next one). */
function section(readme: string, heading: string, nextHeading: string): string {
  const start = readme.indexOf(`## ${heading}`)
  if (start === -1) return ''
  const bodyStart = start + `## ${heading}`.length
  const end = nextHeading !== '' ? readme.indexOf(`## ${nextHeading}`, bodyStart) : -1
  return (end === -1 ? readme.slice(bodyStart) : readme.slice(bodyStart, end)).replace(/\s+/g, ' ').trim()
}

/**
 * Validate every documentation behavior contract of the README. Returns a
 * non-empty list of failure messages when any required commitment is missing
 * or wrong; an empty list means the README satisfies the contract.
 */
function validateCodegraphReadmeContract(readme: string): string[] {
  const failures: string[] = []
  for (const heading of REQUIRED_HEADINGS) {
    if (!readme.includes(`## ${heading}`)) failures.push(`missing required heading: ## ${heading}`)
  }

  if (!readme.includes('@deepseek-ai/dsh-mcp-client')) {
    failures.push('must name the official @deepseek-ai/dsh-mcp-client bridge')
  }
  if (!readme.includes('mcp__codegraph__')) {
    failures.push('must document the server-qualified mcp__codegraph__* tool naming')
  }

  if (!readme.includes('dsh plugin --profile <name> add -w ./plugins/codegraph-mcp')) {
    failures.push('missing the workspace-root (-w) install command')
  }

  const config = section(readme, 'Config', 'Profile override for project path')
  for (const [needle, message] of [
    ['mcp-codegraph', 'Config must name the row id mcp-codegraph'],
    ['serverName', 'Config must state the serverName field'],
    ['codegraph', 'Config must bind serverName/command to codegraph'],
    ['stdio', 'Config must state the stdio transport'],
    ['serve --mcp', 'Config must document the `codegraph serve --mcp` args'],
    ['CODEGRAPH_NO_DAEMON', 'Config must document the default CODEGRAPH_NO_DAEMON env'],
  ] as const) {
    if (!config.includes(needle)) failures.push(message)
  }
  if (config.includes('--path')) {
    failures.push('Config default row must not pin a project path')
  }

  const override = section(readme, 'Profile override for project path', 'Model Experience')
  for (const [needle, message] of [
    ['--path', 'profile override section must document the --path flag'],
    ["['serve', '--mcp', '--path'", 'profile override section must show the args replacement with --path'],
    ['serverName', 'profile override section must restate the full row (serverName included)'],
    ['CODEGRAPH_NO_DAEMON', 'profile override section must restate CODEGRAPH_NO_DAEMON in the row env'],
  ] as const) {
    if (!override.includes(needle)) failures.push(message)
  }
  if (!/(?:no deep merge|whole-config replacement|last write wins)/.test(override)) {
    failures.push('profile override section must state whole-config replacement (no deep merge)')
  }

  const experience = section(readme, 'Model Experience', 'Known Limitations and Deferred Work')
  for (const [needle, message] of [
    ['server-qualified', 'Model Experience must say only server-qualified tools are surfaced'],
    ['mcp__codegraph__echo_context', 'Model Experience must give the observed fake-server tool name'],
    ['codegraph-ok', 'Model Experience must give the observed fake-server output'],
  ] as const) {
    if (!experience.includes(needle)) failures.push(message)
  }

  const limits = section(readme, 'Known Limitations and Deferred Work', 'Verification')
  for (const [needle, message] of [
    ['tools only', 'Known Limitations must state the bridge covers tools only'],
    ['Resources', 'Known Limitations must name MCP Resources as not bridged'],
    ['Prompts', 'Known Limitations must name MCP Prompts as not bridged'],
    ['authoritative', 'Known Limitations must state the deterministic fake tests are authoritative'],
    ['optional', 'Known Limitations must state real CodeGraph smoke is optional'],
    ['without a daemon', 'Known Limitations must state deterministic acceptance runs without a daemon'],
    ['DO_NOT_TRACK', 'Known Limitations must document the DO_NOT_TRACK opt-out env'],
    ['CODEGRAPH_TELEMETRY', 'Known Limitations must document the CODEGRAPH_TELEMETRY opt-out env'],
    ['CODEGRAPH_NO_UPDATE_CHECK', 'Known Limitations must document the CODEGRAPH_NO_UPDATE_CHECK opt-out env'],
  ] as const) {
    if (!limits.includes(needle)) failures.push(message)
  }

  const verification = section(readme, 'Verification', '')
  if (!verification.includes('pnpm exec vitest run plugins/codegraph-mcp/tests/*.spec.ts')) {
    failures.push('Verification must document the deterministic fake-MCP test command')
  }
  if (!verification.includes('fake')) {
    failures.push('Verification must state the tests run against a fake MCP server')
  }

  return failures
}

describe('dsh-codegraph-mcp README shape', () => {
  it('has every required section heading', () => {
    for (const heading of REQUIRED_HEADINGS) {
      expect(README, `missing required heading: ## ${heading}`).toContain(`## ${heading}`)
    }
  })

  it('names the official @deepseek-ai/dsh-mcp-client bridge', () => {
    expect(README).toContain('@deepseek-ai/dsh-mcp-client')
  })

  it('documents the server-qualified mcp__codegraph__* tool naming', () => {
    expect(README).toContain('mcp__codegraph__')
  })

  it('documents the workspace-root install command with -w', () => {
    expect(README).toContain('dsh plugin --profile <name> add -w ./plugins/codegraph-mcp')
  })

  it('documents the default row and the --path override contract', () => {
    const config = section(README, 'Config', 'Profile override for project path')
    expect(config).toContain('mcp-codegraph')
    expect(config).toContain('CODEGRAPH_NO_DAEMON')
    expect(config).not.toContain('--path')
    const override = section(README, 'Profile override for project path', 'Model Experience')
    expect(override).toContain('--path')
    expect(override).toContain("['serve', '--mcp', '--path'")
    expect(override).toMatch(/(?:no deep merge|whole-config replacement|last write wins)/)
  })

  it('scopes Model Experience to observed server-qualified tools only', () => {
    const experience = section(README, 'Model Experience', 'Known Limitations and Deferred Work')
    expect(experience).toContain('server-qualified')
    expect(experience).toContain('mcp__codegraph__echo_context')
    expect(experience).toContain('codegraph-ok')
  })

  it('documents the tools-only limitation and telemetry/update-check opt-outs', () => {
    const limits = section(README, 'Known Limitations and Deferred Work', 'Verification')
    expect(limits).toContain('tools only')
    expect(limits).toContain('Resources')
    expect(limits).toContain('Prompts')
    expect(limits).toContain('without a daemon')
    expect(limits).toContain('DO_NOT_TRACK')
    expect(limits).toContain('CODEGRAPH_TELEMETRY')
    expect(limits).toContain('CODEGRAPH_NO_UPDATE_CHECK')
  })

  it('documents the deterministic fake-MCP verification command', () => {
    expect(README).toContain('pnpm exec vitest run plugins/codegraph-mcp/tests/*.spec.ts')
  })

  it('satisfies the full documentation behavior contract', () => {
    expect(validateCodegraphReadmeContract(README)).toEqual([])
  })

  it('rejects a README that drops CODEGRAPH_NO_DAEMON (mutation regression)', () => {
    const mutated = README.replaceAll('CODEGRAPH_NO_DAEMON', 'CODEGRAPH_KEEP_DAEMON')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README that claims Resources/Prompts are bridged (mutation regression)', () => {
    const mutated = README.replace('tools only', 'tools, resources, and prompts')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README without the -w install flag (mutation regression)', () => {
    const mutated = README.replace('dsh plugin --profile <name> add -w ./plugins/codegraph-mcp', 'dsh plugin --profile <name> add ./plugins/codegraph-mcp')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a README whose profile override loses --path (mutation regression)', () => {
    const mutated = README.replace("['serve', '--mcp', '--path', '/abs/path/to/workspace']", "['serve', '--mcp']")
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a Model Experience that surfaces raw MCP names (mutation regression)', () => {
    const mutated = README.replace(
      'Only server-qualified MCP tools are surfaced',
      'Raw MCP names are surfaced directly',
    )
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })
})
