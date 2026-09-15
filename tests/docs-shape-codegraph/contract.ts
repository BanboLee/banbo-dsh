/**
 * Task-7 CodeGraph MCP README contract validator.
 *
 * The checks are structural and binding, not bare token bags: the Config
 * Markdown table is parsed into exact field/value rows, the profile-override
 * YAML block is parsed line-by-line to require full restatement, and
 * sentence-scoped negative bindings reject direct contradictions even when
 * all positive tokens remain (raw MCP names registered alongside qualified
 * names; Resources/Prompts bridged alongside tools only; wrong default-row
 * values; incomplete override; no-network claim dropped).
 */

import { extractYamlBlock, parseConfigTable, rawSection, section, sentences } from './parsers'

export const REQUIRED_HEADINGS = [
  'Usage',
  'Config',
  'Profile override for project path',
  'Agent instructions',
  'Model Experience',
  'Known Limitations and Deferred Work',
  'Verification',
] as const

/** Bind the Config table's exact required field/value pairs (and no default path). */
export function configRowChecks(readme: string): string[] {
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

/**
 * Bind the profile-override YAML block: whole-config replacement must restate
 * serverName, transport, command, args (with --path), and CODEGRAPH_NO_DAEMON.
 */
export function overrideRowChecks(readme: string): string[] {
  const failures: string[] = []
  const yaml = extractYamlBlock(rawSection(readme, 'Profile override for project path', 'Agent instructions'))
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
export function rawNameChecks(experience: string): string[] {
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
export function resourcesPromptsChecks(limits: string): string[] {
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
export function noNetworkChecks(limits: string): string[] {
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
 * Bind the Agent-instructions section to the no-write strategy: it must explain
 * WHY no AGENTS.md block is installed (the DSH bridge does not consume the MCP
 * initialize instructions, so guidance must cross the bridge some other way),
 * state that guidance comes from the upstream tool descriptions (which the
 * bridge registers verbatim, so agents and subagents see them), point agents at
 * the server-qualified tool, and commit to writing no AGENTS.md. No sentence
 * may claim the bridge surfaces the initialize instructions, and none may
 * reference the removed install script or block file.
 */
export function agentInstructionsChecks(readme: string): string[] {
  const failures: string[] = []
  const sectionText = rawSection(readme, 'Agent instructions', 'Model Experience')
  const normalized = section(readme, 'Agent instructions', 'Model Experience')
  if (!sectionText.includes('mcp__codegraph__codegraph_explore')) {
    failures.push('Agent instructions must point agents at mcp__codegraph__codegraph_explore')
  }
  if (!/does NOT consume those instructions|does not consume.*instructions/i.test(normalized)) {
    failures.push('Agent instructions must explain the DSH bridge does not consume initialize instructions')
  }
  // A sentence claiming the instructions reach the model is only a violation
  // when it is not negated ("never reaches the model" is the required stance).
  if (
    sentences(normalized).some(
      (sentence) =>
        /instructions/.test(sentence) &&
        /reach(?:es)? the model/.test(sentence) &&
        !/(?:never|no|not|nor)\b/.test(sentence),
    )
  ) {
    failures.push('Agent instructions contradicts itself: initialize instructions asserted as reaching the model')
  }
  if (!/tool description/i.test(normalized)) {
    failures.push('Agent instructions must state the guidance comes from the tool descriptions')
  }
  if (!/no AGENTS\.md|writes? no|does NOT install|does not install/i.test(normalized)) {
    failures.push('Agent instructions must commit to writing no AGENTS.md (no file installation)')
  }
  if (/install-codegraph-instructions\.sh|instructions\/CODEGRAPH\.md/i.test(sectionText)) {
    failures.push('Agent instructions must not reference the removed install script or block file')
  }
  return failures
}

/**
 * Validate every documentation behavior contract of the README. Returns a
 * non-empty list of failure messages when any required commitment is missing
 * or wrong; an empty list means the README satisfies the contract.
 */
export function validateCodegraphReadmeContract(readme: string): string[] {
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
  const override = section(readme, 'Profile override for project path', 'Agent instructions')
  if (!/(?:no deep merge|whole-config replacement|last write wins)/.test(override)) {
    failures.push('profile override section must state whole-config replacement (no deep merge)')
  }
  failures.push(...overrideRowChecks(readme))

  // Agent instructions: the no-write strategy — guidance via tool descriptions,
  // no AGENTS.md installation, plus the reason (DSH bridge does not consume
  // initialize instructions).
  failures.push(...agentInstructionsChecks(readme))

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
