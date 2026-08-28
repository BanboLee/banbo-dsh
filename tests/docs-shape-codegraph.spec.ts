/**
 * Docs-shape contract test for `plugins/codegraph-mcp/README.md`.
 *
 * Asserts the structural and contract strings a user needs from the README:
 * the six required section headings, the official `@deepseek-ai/dsh-mcp-client`
 * bridge, the server-qualified `mcp__codegraph__*` tool naming, the exact
 * default row (`CODEGRAPH_NO_DAEMON: '1'`, stdio `codegraph serve --mcp`, no
 * pinned path), the workspace-root install command form (with `-w`), the
 * `--path` profile override as whole-config replacement restating every field
 * (no deep merge), the tools-only bridge limitation (Resources/Prompts not
 * bridged/deferred), the deterministic fake-MCP acceptance (no live binary,
 * no network, no daemon), and the telemetry/update-check opt-out env options.
 *
 * The checks are structural and binding, not bare token bags: the Config
 * Markdown table is parsed into exact field/value rows, the profile-override
 * YAML block is parsed line-by-line to require full restatement, and
 * sentence-scoped negative bindings reject direct contradictions even when
 * all positive tokens remain (raw MCP names registered alongside qualified
 * names; Resources/Prompts bridged alongside tools only; wrong default-row
 * values; incomplete override; no-network claim dropped). Every mutation
 * regression runs the same `validateCodegraphReadmeContract` used for the
 * real README, so the checks cannot drift loose.
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

/** Raw (newline-preserving) body of a `## <heading>` section. */
function rawSection(readme: string, heading: string, nextHeading: string): string {
  const start = readme.indexOf(`## ${heading}`)
  if (start === -1) return ''
  const bodyStart = start + `## ${heading}`.length
  const end = nextHeading !== '' ? readme.indexOf(`## ${nextHeading}`, bodyStart) : -1
  return end === -1 ? readme.slice(bodyStart) : readme.slice(bodyStart, end)
}

/** Normalized prose body of a `## <heading>` section (single-spaced). */
function section(readme: string, heading: string, nextHeading: string): string {
  return rawSection(readme, heading, nextHeading).replace(/\s+/g, ' ').trim()
}

/** Split normalized prose into sentences on '. ' (period-space). */
function sentences(text: string): string[] {
  return text
    .split('. ')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * Parse the Config section's Markdown table into exact field/value pairs
 * (backticks stripped). The `args` cell keeps its bracketed literal and the
 * env cell keeps its quoted literal, so values are compared verbatim.
 */
function parseConfigTable(readme: string): Map<string, string> {
  const table = new Map<string, string>()
  const raw = rawSection(readme, 'Config', 'Profile override for project path')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/`/g, ''))
    if (cells.length < 2) continue
    const [field, value] = cells
    if (field === 'Field' || field === '---' || /^-+$/.test(field)) continue
    table.set(field, value)
  }
  return table
}

/** Bind the Config table's exact required field/value pairs (and no default path). */
function configRowChecks(readme: string): string[] {
  const failures: string[] = []
  const table = parseConfigTable(readme)
  const required: ReadonlyArray<readonly [field: string, value: string, message: string]> = [
    ['id', 'mcp-codegraph', 'default row id must be mcp-codegraph'],
    ['name', '@deepseek-ai/dsh-mcp-client', 'default row must consume the official @deepseek-ai/dsh-mcp-client bridge'],
    ['serverName', 'codegraph', 'default row serverName must be codegraph'],
    ['transport', 'stdio', 'default row transport must be stdio'],
    ['command', 'codegraph', 'default row command must be codegraph'],
    ['args', "['serve', '--mcp']", "default row args must be exactly ['serve', '--mcp']"],
    ['env.CODEGRAPH_NO_DAEMON', "'1'", "default row env.CODEGRAPH_NO_DAEMON must be '1'"],
  ]
  for (const [field, value, message] of required) {
    const actual = table.get(field)
    if (actual === undefined) failures.push(`${message} (missing ${field} row)`)
    else if (actual !== value) failures.push(`${message} (got ${field}=${actual})`)
  }
  const args = table.get('args')
  if (args !== undefined && args.includes('--path')) failures.push('default row must not pin a project path')
  return failures
}

/** Extract the body of the first ```yaml code block in a raw section. */
function extractYamlBlock(raw: string): string {
  const match = /```yaml\n([\s\S]*?)```/.exec(raw)
  return match === null ? '' : match[1]
}

/**
 * Bind the profile-override YAML block: whole-config replacement must restate
 * serverName, transport, command, args (with --path), and CODEGRAPH_NO_DAEMON.
 */
function overrideRowChecks(readme: string): string[] {
  const failures: string[] = []
  const yaml = extractYamlBlock(rawSection(readme, 'Profile override for project path', 'Model Experience'))
  const lineValue = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(yaml)
    return match === null ? undefined : match[1]
  }
  const serverName = lineValue(/^ {4}serverName:\s*(\S+)$/m)
  const transport = lineValue(/^ {4}transport:\s*(\S+)$/m)
  const command = lineValue(/^ {4}command:\s*(\S+)$/m)
  const args = lineValue(/^ {4}args:\s*(\[.*\])$/m)
  const noDaemon = lineValue(/^ {6}CODEGRAPH_NO_DAEMON:\s*(\S+)$/m)
  if (serverName !== 'codegraph') failures.push('override must restate serverName: codegraph')
  if (transport !== 'stdio') failures.push('override must restate transport: stdio')
  if (command !== 'codegraph') failures.push('override must restate command: codegraph')
  if (args === undefined || !(args.includes("'serve'") && args.includes("'--mcp'") && args.includes("'--path'"))) {
    failures.push("override args must restate ['serve', '--mcp', '--path', ...]")
  }
  if (noDaemon !== "'1'") failures.push("override must restate CODEGRAPH_NO_DAEMON: '1'")
  return failures
}

/**
 * Bind the negative raw-name claim in Model Experience: a sentence naming
 * `raw MCP names` must commit to never/not registered/surfaced, and no
 * sentence may assert raw names are registered/surfaced without negation.
 */
function rawNameChecks(experience: string): string[] {
  const failures: string[] = []
  const raw = sentences(experience).filter((sentence) => sentence.includes('raw MCP names'))
  if (raw.length === 0) {
    failures.push('Model Experience must state that raw MCP names are never directly registered/surfaced')
    return failures
  }
  if (!raw.some((sentence) => /(?:never|no|not|nor)\b/.test(sentence) && /(?:registered|surfaced|exposed)/.test(sentence))) {
    failures.push('Model Experience must bind raw MCP names to never/not registered/surfaced')
  }
  if (raw.some((sentence) => !/(?:never|no|not|nor)\b/.test(sentence) && /(?:registered|surfaced|exposed)/.test(sentence))) {
    failures.push('Model Experience contradicts itself: raw MCP names asserted as registered/surfaced without negation')
  }
  return failures
}

/**
 * Bind the tools-only limitation: a sentence naming both Resources and
 * Prompts must commit to not-bridged/deferred semantics, and no sentence may
 * assert they are bridged.
 */
function resourcesPromptsChecks(limits: string): string[] {
  const failures: string[] = []
  const named = sentences(limits).filter((sentence) => sentence.includes('Resources') && sentence.includes('Prompts'))
  if (named.length === 0) {
    failures.push('Known Limitations must name MCP Resources and Prompts as not bridged/deferred')
    return failures
  }
  if (!named.some((sentence) => /(?:not bridged|does not bridge|no harness consumer|deferred)/.test(sentence))) {
    failures.push('Known Limitations must bind Resources/Prompts to not-bridged/deferred semantics')
  }
  if (named.some((sentence) => /(?:bridges|bridged|is bridged|are bridged|will bridge|can bridge)\b/.test(sentence))) {
    failures.push('Known Limitations contradicts itself: Resources/Prompts asserted as bridged')
  }
  return failures
}

/**
 * Bind the deterministic-acceptance claim: the sentence stating no live
 * binary must also commit to no network and no daemon.
 */
function noNetworkChecks(limits: string): string[] {
  const failures: string[] = []
  const acceptance = sentences(limits).find((sentence) => /(?:no|without)\s+live/.test(sentence))
  if (acceptance === undefined) {
    failures.push('Known Limitations must state deterministic acceptance needs no live codegraph binary')
    return failures
  }
  if (!/(?:no|without)\s+network/.test(acceptance)) failures.push('Known Limitations must bind deterministic acceptance to no network')
  if (!/(?:no|without)\s+daemon/.test(acceptance)) failures.push('Known Limitations must bind deterministic acceptance to no daemon')
  return failures
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

  // Config: exact default-row field/value pairs plus the direct-mode prose.
  failures.push(...configRowChecks(readme))
  const config = section(readme, 'Config', 'Profile override for project path')
  if (!/CODEGRAPH_NO_DAEMON[^.]*direct mode/.test(config)) {
    failures.push('Config must explain CODEGRAPH_NO_DAEMON pins direct mode (no daemon)')
  }
  if (!/no (?:project )?path (?:is )?pinned/i.test(config)) {
    failures.push('Config must state the default row pins no project path')
  }

  // Profile override: whole-config replacement restating every field.
  const override = section(readme, 'Profile override for project path', 'Model Experience')
  if (!/(?:no deep merge|whole-config replacement|last write wins)/.test(override)) {
    failures.push('profile override section must state whole-config replacement (no deep merge)')
  }
  failures.push(...overrideRowChecks(readme))

  // Model Experience: only server-qualified tools surfaced; raw names never.
  const experience = section(readme, 'Model Experience', 'Known Limitations and Deferred Work')
  if (!experience.includes('server-qualified')) {
    failures.push('Model Experience must say only server-qualified tools are surfaced')
  }
  if (!experience.includes('mcp__codegraph__echo_context')) {
    failures.push('Model Experience must give the observed fake-server tool name')
  }
  if (!experience.includes('codegraph-ok')) {
    failures.push('Model Experience must give the observed fake-server output')
  }
  failures.push(...rawNameChecks(experience))

  // Known Limitations: tools-only, Resources/Prompts deferred, no live/network/daemon.
  const limits = section(readme, 'Known Limitations and Deferred Work', 'Verification')
  if (!limits.includes('tools only')) failures.push('Known Limitations must state the bridge covers tools only')
  failures.push(...resourcesPromptsChecks(limits))
  if (!limits.includes('authoritative')) failures.push('Known Limitations must state the deterministic fake tests are authoritative')
  if (!limits.includes('optional')) failures.push('Known Limitations must state real CodeGraph smoke is optional')
  if (!limits.includes('without a daemon')) failures.push('Known Limitations must state deterministic acceptance runs without a daemon')
  failures.push(...noNetworkChecks(limits))
  for (const env of ['DO_NOT_TRACK', 'CODEGRAPH_TELEMETRY', 'CODEGRAPH_NO_UPDATE_CHECK']) {
    if (!limits.includes(env)) failures.push(`Known Limitations must document the ${env} opt-out env`)
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
    const override = section(README, 'Profile override for project path', 'Model Experience')
    expect(override).toMatch(/(?:no deep merge|whole-config replacement|last write wins)/)
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
