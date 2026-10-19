/**
 * Prompt-variable contract — what the agents bundle is allowed to put in `{{…}}`.
 *
 * THE BUG THIS PINS. `plugins/agents/cordis.patch.yml` and
 * `templates/agent.cordis.template.yml` used to carry
 *
 *     suffix: Your working directory is {{cwd}}.
 *
 * on the persona row of BOTH presets. dsh 0.2.1-rc.2 registers exactly two prompt
 * variables — `provider` and `model` (`ctx.systemPrompt.variable(...)` in
 * `dsh-agent-loop`) — so rendering the persona threw
 *
 *     unknown prompt variable "{{cwd}}" in section "persona:suffix"
 *
 * on the FIRST turn of every root session: a 100% failure of the Banbo agent, not
 * a cosmetic issue.
 *
 * TWO `{{…}}` MECHANISMS, TWO RULES:
 *
 *   - `{{agentId}}` is OURS. `preset-compiler.js` substitutes it while rendering,
 *     so it may appear BEFORE rendering and must be gone after.
 *   - Everything else reaches the system prompt's interpolator, so only the
 *     variables the harness registers may appear — before or after.
 *
 * WHY THE SCAN IS SOURCE-LEVEL. A first version of this contract walked
 * `document.toJS()` and inspected string VALUES. That has a hole a reviewer found:
 * the template wrote `agentId: {{agentId}}` UNQUOTED, and YAML parses a bare
 * `{{…}}` as a flow mapping — the value becomes an object, not a string. A
 * string-value walk therefore never saw it, and the same hole would have hidden
 * `agentId: {{cwd}}`. So the template now QUOTES its placeholder (making the
 * unrendered file valid YAML with a string value) AND the scan reads the raw SOURCE,
 * which sees a placeholder whether or not it survived parsing as a string.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderComposition } from '../preset-compiler.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(pluginRoot, 'cordis.patch.yml')
const templatePath = join(pluginRoot, 'templates', 'agent.cordis.template.yml')

/**
 * The prompt variables dsh 0.2.1-rc.2 actually registers.
 *
 * Source of truth: `ctx.systemPrompt.variable("provider", …)` and
 * `ctx.systemPrompt.variable("model", …)` are the only registrations in the
 * installed harness (`dsh-agent-loop/lib/index.js`). Anything else throws at
 * render time, so this list IS the contract — extending it requires a DSH release
 * that registers more.
 */
const REGISTERED_PROMPT_VARIABLES = ['provider', 'model'] as const

/** Our own composition placeholder, substituted before the harness sees it. */
const OUR_PLACEHOLDER = 'agentId'

/**
 * Every `{{…}}` occurrence in a YAML file's SOURCE, with a location.
 *
 * NO REGEX COMMENT STRIPPING. A line regex cannot tell a `#` that starts a comment
 * from one that is DATA, so it silently lost three real shapes:
 *
 *     key: '# {{cwd}}'        a single-quoted scalar whose VALUE starts with #
 *     key: "# {{cwd}}"        the same in double quotes
 *     key: |                  a block scalar whose first content line starts with #
 *       # live {{cwd}}
 *
 * All three are live values that reach the prompt; a `#`-stripping regex deleted
 * them and reported a clean bill of health. The scan therefore reads YAML's own
 * node ranges, which by construction contain value text and never a comment:
 *
 *   - every SCALAR node is scanned over `range[0]..range[1]`, which for a quoted
 *     scalar includes the quotes and for a block scalar includes its content;
 *   - every FLOW collection is scanned too, because YAML parses a bare
 *     `{{cwd}}` as a flow mapping (`{ {cwd: null}: null }`) rather than a string —
 *     its range still covers the literal `{{cwd}}`, which is what makes the
 *     malformed shape detectable at all;
 *   - BLOCK collections are NOT scanned. Their range spans their children and
 *     would pull in the comments between them. They contribute nothing else: a
 *     placeholder can only live in a scalar or a flow collection.
 *
 * `range[2]` (`nodeEnd`) is deliberately unused: it extends past the value to
 * include a trailing comment, which `range[1]` (`valueEnd`) excludes.
 *
 * @param text the file contents.
 * @returns the placeholders found, with their 1-based line number.
 */
function sourcePlaceholders(text: string): Array<{ line: number, name: string, source: string }> {
  const { isMap, isPair, isScalar, isSeq, parseDocument } = require('yaml') as typeof import('yaml')
  const document = parseDocument(text, { schema: 'core', merge: false })
  // A file that does not parse cannot be trusted to be scanned; `parseDocument`
  // collects the failures instead of throwing, so surface them here.
  if (document.errors.length > 0) throw document.errors[0]

  /** The source text a node's VALUE covers (never its trailing comment). */
  const valueText = (node: { range?: [number, number, number] | null }): string | undefined => {
    const range = node.range
    if (!Array.isArray(range)) return undefined
    return text.slice(range[0], range[1])
  }

  /** 1-based line number of an absolute offset. */
  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length

  const found: Array<{ line: number, name: string, source: string }> = []
  const scan = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const candidate = node as { range?: [number, number, number] | null, flow?: boolean, items?: unknown[], key?: unknown, value?: unknown }

    if (isScalar(candidate)) {
      const slice = valueText(candidate)
      if (slice !== undefined) {
        const base = candidate.range![0]
        for (const match of slice.matchAll(/\{\{([^{}\n]*)\}\}/gu)) {
          found.push({
            line: lineOf(base + (match.index ?? 0)),
            name: match[1]!.trim(),
            source: slice.trim(),
          })
        }
      }
      return
    }
    if (isMap(candidate) || isSeq(candidate)) {
      if (candidate.flow === true) {
        // The malformed `{{…}}` shape: scan the literal source, then stop (its
        // children are the fragments the parser invented, not real values).
        const slice = valueText(candidate)
        if (slice !== undefined) {
          const base = candidate.range![0]
          for (const match of slice.matchAll(/\{\{([^{}\n]*)\}\}/gu)) {
            found.push({
              line: lineOf(base + (match.index ?? 0)),
              name: match[1]!.trim(),
              source: slice.trim(),
            })
          }
        }
        return
      }
      for (const item of candidate.items ?? []) scan(item)
      return
    }
    if (isPair(candidate)) {
      scan(candidate.key)
      scan(candidate.value)
    }
  }
  scan(document.contents)
  // De-duplicate: a flow collection and the scalars inside it can both report the
  // same offset when the parser splits `{{cwd}}` into fragments.
  const seen = new Set<string>()
  return found.filter((entry) => {
    const key = `${entry.line}:${entry.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Whether one placeholder name is allowed, given the scanning stage.
 *
 * @param name the bare name inside `{{…}}`.
 * @param stage `template` before rendering (our own placeholder is legal) or
 *   `rendered` after it (nothing of ours may survive).
 * @returns whether it is allowed.
 */
function isAllowed(name: string, stage: 'template' | 'rendered'): boolean {
  if (stage === 'template' && name === OUR_PLACEHOLDER) return true
  return (REGISTERED_PROMPT_VARIABLES as readonly string[]).includes(name)
}

/** Every disallowed placeholder in one text, formatted for the assertion message. */
function violations(text: string, where: string, stage: 'template' | 'rendered'): string[] {
  return sourcePlaceholders(text)
    .filter((entry) => !isAllowed(entry.name, stage))
    .map((entry) => `${where}:${entry.line} uses "{{${entry.name}}}" in \`${entry.source}\``)
}

describe('prompt variables in the agents configuration', () => {
  it('declares only prompt variables the target DSH actually registers', () => {
    // Both files: the patch is what a profile mounts directly, and the template is
    // what every per-agent preset is generated from. Fixing one and not the other
    // is exactly how this shipped broken.
    const found = [
      ...violations(readFileSync(patchPath, 'utf8'), 'cordis.patch.yml', 'template'),
      ...violations(readFileSync(templatePath, 'utf8'), 'templates/agent.cordis.template.yml', 'template'),
    ]
    expect(
      found,
      'these placeholders are not registered by dsh 0.2.1-rc.2 '
      + `(registered: ${REGISTERED_PROMPT_VARIABLES.join(', ')}); rendering the persona would throw `
      + '`unknown prompt variable` on the first turn of every root session',
    ).toEqual([])
  })

  it('sees a placeholder even when YAML parses it as a MAPPING instead of a string', () => {
    // The hole this closes, asserted directly. A bare `{{cwd}}` becomes an object in
    // `toJS()`, so a value-level walk misses it — the node-range scan does not.
    const bare = 'config:\n  agentId: {{cwd}}\n'
    // The reported text is the offending VALUE (`{{cwd}}`), with the line number
    // pinning it to `agentId:` above it.
    expect(violations(bare, 'bare', 'template')).toEqual([
      'bare:2 uses "{{cwd}}" in `{{cwd}}`',
    ])
    // Sanity: the parser really does produce a non-string there, which is exactly
    // why the value-level approach could not see it.
    const { parseDocument } = require('yaml') as typeof import('yaml')
    const parsed = parseDocument(bare, { schema: 'core', merge: false }).toJS() as {
      config?: { agentId?: unknown }
    }
    expect(typeof parsed.config?.agentId).not.toBe('string')
  })

  /* ---------------- the four shapes a `#`-stripping regex used to lose --- */

  it.each([
    [
      'a SINGLE-QUOTED scalar whose value starts with #',
      "key: '# {{cwd}}'\n",
    ],
    [
      'a DOUBLE-QUOTED scalar whose value starts with #',
      'key: "# {{cwd}}"\n',
    ],
    [
      'a BLOCK scalar whose first content line starts with #',
      'key: |\n  # live {{cwd}}\n',
    ],
    [
      'a BARE placeholder that YAML turns into a flow mapping',
      'key: {{cwd}}\n',
    ],
  ])('flags %s', (_label, text) => {
    // Every one of these is a LIVE value that reaches the prompt. The previous
    // line-regex scanner deleted the `#`-prefixed three and reported a clean bill
    // of health; only the fourth survived even that.
    const found = violations(text, 'fixture', 'template')
    expect(found, `${_label} must be flagged`).toHaveLength(1)
    expect(found[0]).toContain('{{cwd}}')
  })

  it('IGNORES a pure comment that mentions a placeholder', () => {
    // The positive control: documentation about the old bug must not fail the gate.
    // A comment is not inside any node's value range, which is why the AST scan can
    // tell the difference without guessing at `#`.
    const text = [
      '# This is what broke the release: `Your working directory is {{cwd}}`.',
      'key: ok',
    ].join('\n') + '\n'
    expect(violations(text, 'fixture', 'template')).toEqual([])
  })

  it('IGNORES a TRAILING comment on a value line', () => {
    // `nodeEnd` (range[2]) includes the trailing comment; `valueEnd` (range[1])
    // does not. Using the wrong end would reintroduce the same false positive.
    const text = 'key: ok # see {{cwd}}\n'
    expect(violations(text, 'fixture', 'template')).toEqual([])
  })

  it('carries no cwd prompt variable in either preset', () => {
    // The specific regression, at the source level so a comment cannot satisfy it
    // and a bare (mapping-parsed) value cannot evade it.
    expect(violations(readFileSync(patchPath, 'utf8'), 'cordis.patch.yml', 'template')
      .filter((line) => line.includes('{{cwd}}'))).toEqual([])
    expect(violations(readFileSync(templatePath, 'utf8'), 'templates/agent.cordis.template.yml', 'template')
      .filter((line) => line.includes('{{cwd}}'))).toEqual([])
  })

  it('leaves the persona suffix unset rather than pointing at a variable', () => {
    // `suffix` defaults to "" in the official schema, so the correct shape is to
    // omit it. The working directory reaches the model natively through
    // `@deepseek-ai/dsh-working-directory`, which `dsh-base` mounts.
    const { parseDocument } = require('yaml') as typeof import('yaml')
    const patches = parseDocument(readFileSync(patchPath, 'utf8'), { schema: 'core', merge: false }).toJS() as Array<{
      insert?: Array<Record<string, unknown>>
    }>
    const presets = patches
      .flatMap((patch) => patch.insert ?? [])
      .filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
    expect(presets).toHaveLength(2)
    for (const preset of presets) {
      const config = preset.config as { id: string, plugins: Array<Record<string, unknown>> }
      const persona = config.plugins.find((row) => row.id === 'persona')
      expect(persona, `${config.id} must mount a persona row`).toBeDefined()
      const personaConfig = persona!.config as Record<string, unknown>
      expect(personaConfig['suffix'], `${config.id} persona suffix must not be set`).toBeUndefined()
      // `prefix` is required by the schema; an empty string keeps it silent.
      expect(personaConfig['prefix']).toBe('')
    }
  })

  it('renders the banbo and planner compositions with NO placeholder left', () => {
    // After rendering, our own `{{agentId}}` must be gone and only harness-registered
    // variables may remain. Scanned on the SERIALIZED YAML a profile mounts, so a
    // placeholder rendering left behind cannot hide inside a mapping.
    const templateText = readFileSync(templatePath, 'utf8')
    const { parseDocument } = require('yaml') as typeof import('yaml')
    for (const presetId of ['banbo', 'planner']) {
      const rendered = renderComposition(templateText, presetId)
      expect(rendered, `${presetId} composition must not contain our placeholder`)
        .not.toContain('{{agentId}}')
      expect(
        violations(rendered, `${presetId} composition`, 'rendered'),
        `${presetId} composition still carries a prompt variable; the harness registers only `
        + REGISTERED_PROMPT_VARIABLES.join(', '),
      ).toEqual([])
      // …and the rendered text is still valid YAML whose runtime configs read back
      // as plain strings, i.e. quoting the placeholder did not change the semantics.
      const document = parseDocument(rendered, { schema: 'core', merge: false })
      expect(document.errors, `${presetId} composition must parse`).toEqual([])
      const rows = document.toJS() as Array<{ id?: string, config?: Record<string, unknown> }>
      for (const row of rows) {
        if (row.id !== 'banbo-main-runtime' && row.id !== 'banbo-delegation') continue
        expect(row.config?.['agentId'], `${presetId}/${String(row.id)} agentId`).toBe(presetId)
      }
    }
  })

  it('flags an unknown placeholder substituted into the real template', () => {
    // MUTATION test: take the shipped template and swap our placeholder for `cwd`.
    // Under the old value-level scan this passed silently.
    const templateText = readFileSync(templatePath, 'utf8')
    const mutated = templateText.split(`{{${OUR_PLACEHOLDER}}}`).join('{{cwd}}')
    expect(mutated, 'the mutation must actually change the template').not.toBe(templateText)
    const found = violations(mutated, 'mutated template', 'template')
    expect(found.length, 'the mutated template must be rejected').toBeGreaterThan(0)
    expect(found.join('\n')).toContain('{{cwd}}')
  })

  it('flags an unknown BARE, unquoted placeholder inside the template', () => {
    // The exact textual shape that used to evade the scan: no quotes around `{{…}}`,
    // so YAML turns it into a mapping rather than a string.
    const templateText = readFileSync(templatePath, 'utf8')
    const mutated = templateText.replace(/^(\s*agentId: )'\{\{agentId\}\}'$/mu, '$1{{cwd}}')
    expect(mutated).not.toBe(templateText)
    expect(mutated).toContain('agentId: {{cwd}}')
    expect(violations(mutated, 'mutated template', 'template').join('\n')).toContain('{{cwd}}')
  })
})
