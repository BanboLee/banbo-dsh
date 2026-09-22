/**
 * Specification for `plugins/agents/preset-compiler.js`.
 *
 * Three responsibilities, all testable offline:
 *
 *   - **Template rendering** — the shipped `presets/<id>/agent.cordis.yml` files
 *     are the template with the agent id substituted, and nothing else. A
 *     hand-edited shipped preset is a defect this suite catches.
 *   - **Standard inventory** — a digest of the official `standard` composition
 *     the template was derived from. It exists so a harness upgrade cannot let
 *     our full-copy template rot silently (§8.3).
 *   - **Generation compilation** — user main agents become preset directories
 *     inside an immutable generation, activated by swapping one `current`
 *     pointer (§8.6). No locks, no directory exchange, no partially written
 *     generation ever becoming live.
 */

import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  COMPLETE_MARKER,
  PARTIAL_PREFIX,
  compilePresets,
  computeStandardInventory,
  renderComposition,
  standardCompositionPath,
} from '../preset-compiler.js'
import { FORBIDDEN_DELEGATION_TOOLS } from '../schema.js'

const require = createRequire(import.meta.url)
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templateText = readFileSync(join(pluginRoot, 'templates', 'agent.cordis.template.yml'), 'utf8')

/** One parsed composition row, as `computeStandardInventory` reports it. */
interface InventoryRow {
  id?: string
  name?: string
  disabled?: unknown
  isolate?: unknown
  config?: unknown
}

/**
 * Every key path reachable in a config value, sorted.
 *
 * Recurses through objects and arrays so a field dropped anywhere in a row's
 * config changes this list — that is what makes the R1 defect class visible.
 */
function configKeyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return []
  const paths: string[] = []
  const entries = Array.isArray(value)
    ? value.map((child, index) => [String(index), child] as const)
    : Object.entries(value as Record<string, unknown>)
  for (const [key, child] of entries) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    paths.push(path)
    paths.push(...configKeyPaths(child, path))
  }
  return paths.sort()
}

const scratch: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'banbo-compiler-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** A definition carrying a main form, as `validateAgentDefinition` returns it. */
const mainAgent = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  displayName: id,
  description: `${id} probe`,
  allowedChildren: [],
  main: {
    presetId: id,
    persona: 'prompts/lead-main.md',
    tools: ['read'],
    maxDepth: 1,
    budget: {
      maxConcurrentChildren: 6,
      maxBatchWidth: 4,
      foregroundDeadlineMs: 900_000,
      backgroundDeadlineMs: 1_800_000,
      batchDeadlineMs: 600_000,
      drainGraceMs: 30_000,
    },
    ...(patch.main as Record<string, unknown> ?? {}),
  },
  ...patch,
})

/* ---------------------------------------------------- template rendering --- */

describe('renderComposition', () => {
  it('substitutes every placeholder', () => {
    const rendered = renderComposition(templateText, 'my-lead')
    expect(rendered).not.toContain('{{agentId}}')
    expect(rendered).toContain('agentId: my-lead')
  })

  it('leaves every other byte untouched', () => {
    const rendered = renderComposition(templateText, 'my-lead')
    expect(rendered.length).toBe(templateText.length - '{{agentId}}'.length * 2 + 'my-lead'.length * 2)
  })

  it('rejects an id that is not a usable agent id', () => {
    expect(() => renderComposition(templateText, 'Not An Id')).toThrow(/agent id/i)
  })
})

describe('the shipped built-in presets are the template, not hand-written copies', () => {
  for (const id of ['banbo', 'planner']) {
    it(`presets/${id}/agent.cordis.yml equals the rendered template`, () => {
      const shipped = readFileSync(join(pluginRoot, 'presets', id, 'agent.cordis.yml'), 'utf8')
      expect(shipped).toBe(renderComposition(templateText, id))
    })
  }

  it('ships display metadata beside every composition', () => {
    for (const id of ['banbo', 'planner']) {
      const metadata = readFileSync(join(pluginRoot, 'presets', id, 'preset.yml'), 'utf8')
      expect(metadata).toMatch(/^name: /m)
      expect(metadata).toMatch(/^description: /m)
    }
  })
})

/* ------------------------------------------- forbidden delegation surface --- */

describe('the template keeps the official general-purpose delegation entries out', () => {
  /** Parse the composition with the `!!js` gates left as inert strings. */
  function parseComposition(text: string) {
    const { parseDocument } = require('yaml') as typeof import('yaml')
    return parseDocument(text, { schema: 'core', merge: false }).toJS() as Array<Record<string, unknown>>
  }

  it('registers no row whose tool name is a forbidden entry point', () => {
    const rows = parseComposition(renderComposition(templateText, 'probe'))
    const forbidden = ['subagent', 'subagent_fork', 'workflow', 'ralph', 'subagent_codex', 'subagent_claude_code']
    const names = rows
      .flatMap((row) => [row, ...(Array.isArray(row.config) ? row.config as Array<Record<string, unknown>> : [])])
      .map((row) => (row.config as Record<string, unknown> | undefined)?.toolName)
      .filter((value): value is string => typeof value === 'string')
    for (const tool of forbidden) expect(names, tool).not.toContain(tool)
  })

  it('registers no row for the official workflow or fork backends', () => {
    const rows = parseComposition(renderComposition(templateText, 'probe'))
    const ids = rows
      .flatMap((row) => [row, ...(Array.isArray(row.config) ? row.config as Array<Record<string, unknown>> : [])])
      .map((row) => row.id)
    for (const id of ['tool-workflow', 'workflow-worker-thread', 'tool-subagent', 'tool-subagent-fork', 'tool-ralph']) {
      expect(ids, id).not.toContain(id)
    }
  })

  it('keeps the control rows that address already-existing children', () => {
    const rows = parseComposition(renderComposition(templateText, 'probe'))
    const ids = rows
      .flatMap((row) => [row, ...(Array.isArray(row.config) ? row.config as Array<Record<string, unknown>> : [])])
      .map((row) => row.id)
    for (const id of ['tool-subagent-control', 'tool-subagent-list-agents']) expect(ids, id).toContain(id)
  })

  it('mounts both banbo-agents runtime rows with the agent id', () => {
    const rows = parseComposition(renderComposition(templateText, 'probe'))
    const runtime = rows.filter((row) => typeof row.name === 'string' && row.name.startsWith('@banbolee/dsh-agents/'))
    expect(runtime.map((row) => row.name).sort()).toEqual(['@banbolee/dsh-agents/delegation', '@banbolee/dsh-agents/main-runtime'])
    for (const row of runtime) expect((row.config as Record<string, unknown>).agentId).toBe('probe')
  })
})

/* ------------------------------------------------------- standard digest --- */

describe('computeStandardInventory — the §8.3 drift gate', () => {
  const sample = [
    '- id: alpha',
    "  name: '@deepseek-ai/dsh-alpha'",
    '- id: beta',
    "  name: '@deepseek-ai/dsh-beta'",
    '  disabled: true',
    '- id: grp',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    engine: true',
    '  config:',
    '    - id: inner',
    "      name: '@deepseek-ai/dsh-inner'",
    '',
  ].join('\n')

  it('records every row, including nested group members', () => {
    const inventory = computeStandardInventory(sample)
    expect(inventory.rows.map((row) => row.id)).toEqual(['alpha', 'beta', 'grp', 'inner'])
  })

  it('records the disable gate, isolate realms, and complete non-group config', () => {
    const configured = sample.replace(
      "  name: '@deepseek-ai/dsh-alpha'",
      "  name: '@deepseek-ai/dsh-alpha'\n  config:\n    nested:\n      enabled: true\n      order: [a, b]",
    ).replace(
      "      name: '@deepseek-ai/dsh-inner'",
      "      name: '@deepseek-ai/dsh-inner'\n      config:\n        threshold: 3",
    )
    const inventory = computeStandardInventory(configured)
    expect(inventory.rows.find((row) => row.id === 'beta')!.disabled).toBe(true)
    expect(inventory.rows.find((row) => row.id === 'grp')!.isolate).toEqual({ engine: true })
    expect(inventory.rows.find((row) => row.id === 'alpha')!.config).toEqual({
      nested: { enabled: true, order: ['a', 'b'] },
    })
    expect(inventory.rows.find((row) => row.id === 'inner')!.config).toEqual({ threshold: 3 })
    expect(inventory.rows.find((row) => row.id === 'grp')).not.toHaveProperty('config')
  })

  it('produces a stable digest independent of source formatting', () => {
    // Same structure, different spelling: flow style for one row, a comment and
    // a blank line for another. Neither is a change to what is mounted.
    const same = sample
      .replace("- id: alpha\n  name: '@deepseek-ai/dsh-alpha'\n", "- {id: alpha, name: '@deepseek-ai/dsh-alpha'}\n")
      .replace('  disabled: true\n', '\n  # the disable gate, spelled the same way\n  disabled: true\n')
    expect(computeStandardInventory(same).digest).toBe(computeStandardInventory(sample).digest)
  })

  it('changes the digest when a row is added, removed or renamed', () => {
    const base = computeStandardInventory(sample).digest
    expect(computeStandardInventory(`${sample}\n- id: gamma\n  name: '@deepseek-ai/dsh-gamma'\n`).digest).not.toBe(base)
    expect(computeStandardInventory(sample.replace('dsh-beta', 'dsh-beta-renamed')).digest).not.toBe(base)
    expect(computeStandardInventory(sample.replace("- id: alpha\n  name: '@deepseek-ai/dsh-alpha'\n", '')).digest).not.toBe(base)
  })

  it('changes the digest when an isolate realm or any non-group config value changes', () => {
    const base = computeStandardInventory(sample).digest
    expect(computeStandardInventory(sample.replace('engine: true', 'engine: false')).digest).not.toBe(base)
    const configured = sample.replace(
      "  name: '@deepseek-ai/dsh-alpha'",
      "  name: '@deepseek-ai/dsh-alpha'\n  config:\n    nested:\n      value: before",
    )
    expect(computeStandardInventory(configured.replace('value: before', 'value: after')).digest)
      .not.toBe(computeStandardInventory(configured).digest)
  })

  it('records final runtime tool names, including config-driven names and model discovery', () => {
    const composition = [
      '- id: fs',
      "  name: '@deepseek-ai/dsh-tool-fs'",
      '- id: spawn',
      "  name: '@deepseek-ai/dsh-tool-subagent'",
      '  config:',
      '    provider: spawn',
      '    toolName: my_delegate',
      '    modelSelectionSettings: true',
      '- id: disabled-provider',
      "  name: '@deepseek-ai/dsh-tool-subagent'",
      '  disabled: true',
      '  config:',
      '    provider: unavailable',
      '    toolName: unavailable_delegate',
      '',
    ].join('\n')
    expect(computeStandardInventory(composition).tools).toEqual([
      'edit', 'list_subagent_models', 'my_delegate', 'read', 'read_image', 'write',
    ])
  })

  it('the shipped inventory matches official rows and the managed template tool surface', () => {
    const officialPath = standardCompositionPath()
    expect(officialPath, 'the official standard composition must be resolvable').toBeDefined()
    const official = computeStandardInventory(readFileSync(officialPath!, 'utf8'))
    const managed = computeStandardInventory(renderComposition(templateText, 'probe'))
    const shipped = JSON.parse(readFileSync(join(pluginRoot, 'templates', 'dsh-standard-inventory.json'), 'utf8'))
    // A mismatch means the harness changed `standard` or our full-copy template's
    // fixed tool surface drifted. Update the inventory only after review.
    expect(official.digest).toBe(shipped.standardDigest)
    expect(official.rows).toEqual(shipped.rows)
    expect(managed.tools).toEqual(shipped.tools)
  })

  it('the managed template removes only general delegation creation tools from the standard ABI', () => {
    const officialPath = standardCompositionPath()
    expect(officialPath, 'the official standard composition must be resolvable').toBeDefined()
    const official = computeStandardInventory(readFileSync(officialPath!, 'utf8')).tools
    const managed = computeStandardInventory(renderComposition(templateText, 'probe')).tools
    const removed = official.filter((name) => !managed.includes(name))
    expect(removed).toEqual([
      'list_subagent_models', ...FORBIDDEN_DELEGATION_TOOLS,
    ].sort())
  })

  it('every shared row keeps the official config shape, isolate and disabled gate', () => {
    // THE R1 GATE. The template is a full COPY of the official `standard`
    // composition, so a row this bundle does not deliberately touch must keep
    // the official config shape exactly. Comparing only derived TOOL NAMES (the
    // digest gate above) cannot see a dropped REQUIRED config field: removing
    // `prefix` from the `persona` row left the whole suite green while every
    // real profile failed with
    //   `preset "banbo" failed to mount: $.prefix missing required value`.
    const officialPath = standardCompositionPath()
    expect(officialPath, 'the official standard composition must be resolvable').toBeDefined()
    const official = computeStandardInventory(readFileSync(officialPath!, 'utf8'))
    const managed = computeStandardInventory(renderComposition(templateText, 'probe'))

    const byId = (rows: readonly InventoryRow[]) =>
      new Map(rows.filter((row) => row.id !== undefined).map((row) => [row.id as string, row]))
    const officialById = byId(official.rows)
    const managedById = byId(managed.rows)

    // Rows this bundle deliberately drops from the copy. They cannot appear in
    // the shared set, so they are listed only to document the intent.
    const deliberatelyRemoved = new Set([
      'delegation',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-codex',
      'tool-subagent-claude-code',
      'workflow-worker-thread',
      'tool-workflow',
      'tool-ralph',
    ])
    for (const id of deliberatelyRemoved) {
      expect(managedById.has(id), `${id} is deliberately removed and must stay removed`).toBe(false)
    }

    const shared = [...officialById.keys()].filter((id) => managedById.has(id))
    // The copy is 23 shared rows today (31 official minus the 8 deliberate
    // removals). A vacuity guard, not a snapshot: if the template ever stops
    // being a full copy this gate must fail loudly rather than compare nothing.
    expect(shared.length, 'the template must still be a full copy of standard').toBeGreaterThan(20)
    expect(managedById.size - shared.length, 'only the 3 added rows may be ours alone').toBe(3)

    for (const id of shared) {
      const expected = officialById.get(id)!
      const actual = managedById.get(id)!
      expect(configKeyPaths(actual.config), `row ${id}: config shape drifted from official`).toEqual(
        configKeyPaths(expected.config),
      )
      expect(actual.isolate, `row ${id}: isolate drifted from official`).toEqual(expected.isolate)
      expect(actual.disabled, `row ${id}: disabled gate drifted from official`).toEqual(expected.disabled)
    }

    // The rows this bundle ADDS are its own business, but they must exist.
    for (const id of ['delegation-control', 'banbo-main-runtime', 'banbo-delegation']) {
      expect(managedById.has(id), `${id} is added by this bundle and must exist`).toBe(true)
    }
  })
})

/* ----------------------------------------------------------- compilation --- */

describe('compilePresets — immutable generation with a current pointer', () => {
  const options = (root: string, definitions: unknown[], extra: Record<string, unknown> = {}) => ({
    rootDir: root,
    templateText,
    definitions: new Map((definitions as Array<{ id: string }>).map((definition) => [definition.id, definition])),
    builtinPresetIds: new Set(['banbo', 'planner']),
    dshVersion: '0.1.5-rc.2',
    selfVersion: '0.0.0',
    ...extra,
  })

  it('writes one preset directory per user main agent', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, [mainAgent('my-lead'), mainAgent('other')]) as never)
    const dir = join(result.generationDir, 'presets')
    expect(readdirSync(dir).sort()).toEqual(['my-lead', 'other'])
    expect(existsSync(join(dir, 'my-lead', 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(dir, 'my-lead', 'preset.yml'))).toBe(true)
  })

  it('skips agents whose preset already ships in the package', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, [mainAgent('banbo'), mainAgent('my-lead')]) as never)
    expect(readdirSync(join(result.generationDir, 'presets'))).toEqual(['my-lead'])
  })

  it('skips child-only agents entirely', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, [mainAgent('my-lead'), { id: 'helper', displayName: 'h', description: 'd', allowedChildren: [], child: {} }]) as never)
    expect(readdirSync(join(result.generationDir, 'presets'))).toEqual(['my-lead'])
  })

  it('writes the agent id into the composition', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const text = readFileSync(join(result.generationDir, 'presets', 'my-lead', 'agent.cordis.yml'), 'utf8')
    expect(text).toContain('agentId: my-lead')
    expect(text).not.toContain('{{agentId}}')
  })

  it('points `current` at the new generation', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    expect(result.reused).toBe(false)
    const current = join(root, '.generated', 'current')
    expect(existsSync(current)).toBe(true)
    expect(resolve(dirname(current), readlinkSync(current))).toBe(resolve(result.generationDir))
    expect(readdirSync(join(current, 'presets'))).toEqual(['my-lead'])
  })

  it('marks the generation complete and records the ABI manifest inside it', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    expect(existsSync(join(result.generationDir, COMPLETE_MARKER))).toBe(true)
    const abi = JSON.parse(readFileSync(join(result.generationDir, 'abi.json'), 'utf8'))
    expect(abi.agents.map((agent: { id: string }) => agent.id)).toEqual(['my-lead'])
    expect(abi.agents[0].presetId).toBe('my-lead')
    expect(abi.agents[0].hasMain).toBe(true)
    expect(abi.agents[0].toolName).toBe('agent_my_lead')
    expect(abi.dshVersion).toBe('0.1.5-rc.2')
  })

  it('reuses an existing generation for identical input without rewriting it', () => {
    const root = scratchDir()
    const first = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const stamp = readFileSync(join(first.generationDir, COMPLETE_MARKER), 'utf8')
    const second = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    expect(second.reused).toBe(true)
    expect(second.generationDir).toBe(first.generationDir)
    expect(readFileSync(join(second.generationDir, COMPLETE_MARKER), 'utf8')).toBe(stamp)
  })

  it('cleans a crashed build\'s .partial- directory without touching the live generation', () => {
    // §14.3 item 14 asks for the "killed mid-write" kill point. Our own staging
    // directories are the only residue a crash can leave, and cleanup must
    // remove them while leaving the active generation and pointer intact.
    const root = scratchDir()
    const first = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const generationsDir = join(root, '.generated', 'generations')
    const partial = join(generationsDir, `${PARTIAL_PREFIX}${first.generation}.99999.deadbeef`)
    mkdirSync(join(partial, 'presets', 'ghost'), { recursive: true })
    writeFileSync(join(partial, 'abi.json'), '{}')

    const second = compilePresets(options(root, [mainAgent('my-lead')]) as never)

    expect(existsSync(partial), 'the crashed staging directory must be cleaned').toBe(false)
    expect(second.reused).toBe(true)
    expect(existsSync(join(root, '.generated', 'current', COMPLETE_MARKER))).toBe(true)
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toEqual(['my-lead'])
  })

  it('adopts a complete same-hash generation instead of deleting and rebuilding it', () => {
    // Two Host processes may compile one content hash at once. A COMPLETE
    // generation must always win over a peer's rebuild, because the name is a
    // hash of the payload (§8.6).
    const root = scratchDir()
    const first = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const stamp = readFileSync(join(first.generationDir, COMPLETE_MARKER), 'utf8')
    rmSync(join(root, '.generated', 'current'), { force: true })

    const second = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    expect(second.reused).toBe(true)
    expect(second.generationDir).toBe(first.generationDir)
    expect(readFileSync(join(second.generationDir, COMPLETE_MARKER), 'utf8')).toBe(stamp)
  })

  it('still clears an INCOMPLETE same-named directory before rebuilding it', () => {
    // A same-named directory without our marker is not trusted: only that case
    // is removed, and it is rebuilt into a complete generation.
    const root = scratchDir()
    const first = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    rmSync(join(first.generationDir, COMPLETE_MARKER))

    const second = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    expect(second.reused).toBe(false)
    expect(existsSync(join(second.generationDir, COMPLETE_MARKER))).toBe(true)
    expect(readdirSync(join(second.generationDir, 'presets'))).toEqual(['my-lead'])
  })

  it('produces a different generation when the catalog changes', () => {    const root = scratchDir()
    const first = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const second = compilePresets(options(root, [mainAgent('my-lead'), mainAgent('added')]) as never)
    expect(second.generation).not.toBe(first.generation)
    // The new generation is a complete mirror, not an incremental patch.
    expect(readdirSync(join(second.generationDir, 'presets')).sort()).toEqual(['added', 'my-lead'])
  })

  it('a deleted main agent disappears from the next generation (§6.3)', () => {
    const root = scratchDir()
    compilePresets(options(root, [mainAgent('my-lead'), mainAgent('doomed')]) as never)
    const after = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    expect(readdirSync(join(after.generationDir, 'presets'))).toEqual(['my-lead'])
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toEqual(['my-lead'])
  })

  it('never activates a generation that lacks its completion marker', () => {
    const root = scratchDir()
    const first = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    // Simulate a crash between writing the payload and marking completion.
    const orphan = join(root, '.generated', 'generations', 'sha256-orphan')
    mkdirSync(join(orphan, 'presets', 'ghost'), { recursive: true })
    writeFileSync(join(orphan, 'abi.json'), '{}')
    const second = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    // The pointer still resolves to a complete generation, not the orphan.
    expect(existsSync(join(root, '.generated', 'current', COMPLETE_MARKER))).toBe(true)
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toEqual(['my-lead'])
    expect(second.generationDir).toBe(first.generationDir)
  })

  it('retains the current generation plus exactly one previous one', () => {
    const root = scratchDir()
    for (const agent of ['a', 'b', 'c', 'd']) {
      compilePresets(options(root, [mainAgent(agent)]) as never)
    }
    const generations = readdirSync(join(root, '.generated', 'generations'))
    expect(generations.length).toBe(2)
  })

  it('an empty catalog still produces a valid, activatable generation', () => {
    const root = scratchDir()
    const result = compilePresets(options(root, []) as never)
    expect(readdirSync(join(result.generationDir, 'presets'))).toEqual([])
    expect(existsSync(join(root, '.generated', 'current', COMPLETE_MARKER))).toBe(true)
  })

  it('does not follow or delete content it does not own', () => {
    const root = scratchDir()
    const foreign = join(root, '.generated', 'generations', 'not-ours')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'keep-me'), 'x')
    compilePresets(options(root, [mainAgent('my-lead')]) as never)
    // No completion marker means it is not a generation this plugin manages;
    // cleanup must leave it alone.
    expect(existsSync(join(foreign, 'keep-me'))).toBe(true)
  })

  it('escapes a stale `current` symlink pointing outside .generated', () => {
    const root = scratchDir()
    const outside = scratchDir()
    mkdirSync(join(root, '.generated', 'generations'), { recursive: true })
    symlinkSync(outside, join(root, '.generated', 'current'))
    // Replacing the pointer must not touch whatever it used to name.
    expect(() => compilePresets(options(root, [mainAgent('my-lead')]) as never)).not.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('activates through a directory symlink on POSIX (§8.7 step 1)', () => {
    const root = scratchDir()
    const compiled = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const pointer = join(root, '.generated', 'current')
    expect(lstatSync(pointer).isSymbolicLink()).toBe(true)
    // The roster reads through the link, so it must resolve to real content.
    expect(readdirSync(join(pointer, 'presets'))).toEqual(['my-lead'])
    expect(readlinkSync(pointer)).toBe(relative(join(root, '.generated'), compiled.generationDir))
  })

  // Runs only on the Windows CI runner: macOS/Linux cannot exercise the junction
  // branch, so a skip here is honest rather than a false green.
  it.skipIf(process.platform !== 'win32')('activates through a link the roster can read on Windows (§8.7 step 2)', () => {
    const root = scratchDir()
    const compiled = compilePresets(options(root, [mainAgent('my-lead')]) as never)
    const pointer = join(root, '.generated', 'current')
    // Windows reports a junction as a symlink reparse point.
    expect(lstatSync(pointer).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(pointer, 'presets'))).toEqual(['my-lead'])
    expect(compiled.reused).toBe(false)
    // A second compile of the same content must reuse it through the link.
    expect(compilePresets(options(root, [mainAgent('my-lead')]) as never).reused).toBe(true)
  })
})
