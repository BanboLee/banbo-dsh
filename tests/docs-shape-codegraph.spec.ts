/**
 * Docs-shape behavior tests for `plugins/codegraph-mcp/README.md`.
 *
 * These cases assert the documented behavior contract through the shared
 * validator in `./contract.ts` (parsing helpers live in `./parsers.ts`).
 * The full set of required headings, exact Config-table rows, profile-override
 * restatement, raw-name negative binding, Resources/Prompts limitation,
 * deterministic-acceptance no-live/no-network/no-daemon claim, and the seven
 * contradiction/value mutation regressions all run the SAME
 * `validateCodegraphReadmeContract` used for the real README, so the checks
 * cannot drift loose.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  REQUIRED_HEADINGS,
  agentInstructionsChecks,
  configRowChecks,
  noNetworkChecks,
  overrideRowChecks,
  rawNameChecks,
  resourcesPromptsChecks,
  validateCodegraphReadmeContract,
} from './docs-shape-codegraph/contract'
import { parseConfigTable, section } from './docs-shape-codegraph/parsers'

const README = readFileSync(fileURLToPath(new URL('../plugins/codegraph-mcp/README.md', import.meta.url)), 'utf8')

describe('@banbolee/dsh-codegraph-mcp README shape', () => {
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

  it('binds the Config table exact field/value pairs', () => {
    expect(configRowChecks(README)).toEqual([])
    const table = parseConfigTable(README)
    expect(table.get('id')).toBe('mcp-codegraph')
    expect(table.get('name')).toBe('@deepseek-ai/dsh-mcp-client')
    expect(table.get('serverName')).toBe('codegraph')
    expect(table.get('transport')).toBe('stdio')
    expect(table.get('command')).toBe('codegraph')
    expect(table.get('args')).toBe("['serve', '--mcp']")
    expect(table.get('env.CODEGRAPH_NO_DAEMON')).toBe("'1'")
    expect(table.get('args')).not.toContain('--path')
  })

  it('explains the CODEGRAPH_NO_DAEMON direct-mode default and no pinned path', () => {
    const config = section(README, 'Config', 'Profile override for project path')
    expect(config).toMatch(/CODEGRAPH_NO_DAEMON[^.]*direct mode/)
    expect(config).toMatch(/no (?:project )?path (?:is )?pinned/i)
  })

  it('requires the profile override to restate every row field with --path', () => {
    expect(overrideRowChecks(README)).toEqual([])
    const override = section(README, 'Profile override for project path', 'Agent instructions')
    expect(override).toMatch(/(?:no deep merge|whole-config replacement|last write wins)/)
  })

  it('documents the no-write agent-guidance strategy (tool descriptions, no AGENTS.md)', () => {
    expect(agentInstructionsChecks(README)).toEqual([])
    const block = section(README, 'Agent instructions', 'Model Experience')
    expect(block).toContain('mcp__codegraph__codegraph_explore')
    expect(block).toMatch(/does NOT consume/i)
    expect(block).toMatch(/tool description/i)
    expect(block).toMatch(/no AGENTS\.md|writes? no|does NOT install/i)
    expect(block).not.toMatch(/install-codegraph-instructions\.sh|instructions\/CODEGRAPH\.md/)
  })

  it('scopes Model Experience to observed server-qualified tools only', () => {
    const experience = section(README, 'Model Experience', 'Known Limitations and Deferred Work')
    expect(experience).toContain('server-qualified')
    expect(experience).toContain('mcp__codegraph__echo_context')
    expect(experience).toContain('codegraph-ok')
    expect(rawNameChecks(experience)).toEqual([])
  })

  it('documents the tools-only limitation and telemetry/update-check opt-outs', () => {
    const limits = section(README, 'Known Limitations and Deferred Work', 'Verification')
    expect(limits).toContain('tools only')
    expect(resourcesPromptsChecks(limits)).toEqual([])
    expect(limits).toContain('without a daemon')
    expect(noNetworkChecks(limits)).toEqual([])
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

  it('rejects raw MCP names also registered alongside qualified names while server-qualified tokens remain (mutation regression)', () => {
    const mutated = README.replace(
      /raw MCP names are\s+never registered directly/,
      'raw MCP names are also registered directly alongside server-qualified names',
    )
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects Resources/Prompts bridged while tools only/Resources/Prompts tokens remain (mutation regression)', () => {
    const mutated = README.replace(
      'so this bundle does not bridge them.',
      'so this bundle bridges them alongside tools only after startup.',
    )
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a swapped CODEGRAPH_NO_DAEMON table value (mutation regression)', () => {
    const mutated = README.replace("| `env.CODEGRAPH_NO_DAEMON` | `'1'` |", "| `env.CODEGRAPH_NO_DAEMON` | `'0'` |")
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a swapped command table value (mutation regression)', () => {
    const mutated = README.replace('| `command` | `codegraph` |', '| `command` | `npx` |')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects an override that omits the transport restatement (mutation regression)', () => {
    const mutated = README.replace('    transport: stdio\n', '')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects an override that swaps the command restatement (mutation regression)', () => {
    const mutated = README.replace('    command: codegraph', '    command: npx')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects deterministic acceptance that loses the no-network claim (mutation regression)', () => {
    const mutated = README.replace(', no network', '')
    expect(mutated).not.toEqual(README)
    expect(validateCodegraphReadmeContract(mutated)).not.toEqual([])
  })
})
