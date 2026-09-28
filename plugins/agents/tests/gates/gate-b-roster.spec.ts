/**
 * Gate B — rc.2 preset-ROW platform probes.
 *
 * 0.1.7 replaced the 0.1.5 roster model wholesale: `@deepseek-ai/dsh-agent-presets`
 * does not exist at 0.1.7-rc.2, presets are no longer directories discovered
 * under `roots`, and a preset is declared as one
 * `@deepseek-ai/dsh-agent-preset` ROW (`config = { id, name?, description?,
 * order?, plugins }`) that the profile's own `@deepseek-ai/dsh-agent-preset-registry`
 * row owns. This file locks only platform facts about that model:
 *
 *   - the rows this bundle declares are VALID according to the real 0.1.7
 *     packages (their own schema and entry-list validator), not according to a
 *     copy of it;
 *   - they compose cleanly with the official `dsh-web-app` layer, which is the
 *     layer that declares the registry row and the four official presets;
 *   - the dead 0.1.5 model (a `roots` roster patch, `includeShippedRoot`, a
 *     directory scan) is gone from this bundle.
 *
 * It never starts an app, provider, or network. Where a probe needs the real
 * packages it resolves them the way the Loader does: from this package, else
 * from the global `dsh` installation CI provisions.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')
const patchText = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8')
const require = createRequire(import.meta.url)

const AGENT_PRESET = '@deepseek-ai/dsh-agent-preset'
const PRESET_REGISTRY = '@deepseek-ai/dsh-agent-preset-registry'
const OFFICIAL_BUNDLE = '@deepseek-ai/dsh-web-app'
const PRESET_ROW_PREFIX = 'preset-'

interface JsExpr { __jsExpr: string }
interface PatchRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
  insert?: unknown[]
  disabled?: unknown
}

function parsePatches(text: string): PatchRow[] {
  const document = parseDocument(text, { schema: 'core', customTags: [{
    tag: 'tag:yaml.org,2002:js',
    resolve: (value: string) => ({ __jsExpr: value }),
  }] })
  if (document.errors.length > 0) throw document.errors[0]
  return document.toJS() as PatchRow[]
}

function flatten(rows: PatchRow[]): PatchRow[] {
  return rows.flatMap((row) => [row, ...(Array.isArray(row.insert) ? flatten(row.insert as PatchRow[]) : [])])
}

const ownRows = flatten(parsePatches(patchText))
const presetRows = ownRows.filter((row) => row.name === AGENT_PRESET)

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  throw new Error(`${name} is required on PATH for Gate B`)
}

/** Resolve a package the Loader would resolve: local first, then beside `dsh`. */
function packageRoot(name: string): string {
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    const dshRoot = dirname(dirname(executable('dsh')))
    const globalModules = dirname(dirname(dshRoot))
    const candidates = [
      join(dshRoot, 'node_modules', name),
      join(globalModules, name),
    ]
    const match = candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
    if (match !== undefined) return realpathSync(match)
    throw new Error(`cannot resolve Gate B package ${name}`)
  }
}

/** Every bundle patch file the package declares, in `dsh.bundle.patch` order. */
function bundlePatches(name: string): PatchRow[] {
  const root = packageRoot(name)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string | string[] } }
  }
  const declared = manifest.dsh?.bundle?.patch
  const files = declared === undefined ? [] : (Array.isArray(declared) ? declared : [declared])
  return files.flatMap((relative) => parsePatches(readFileSync(join(root, relative.replace(/^\.\//, '')), 'utf8')))
}

/** Compose layers through the platform's own patch composer. */
async function composeOfficial(layers: PatchRow[][]): Promise<{ rows: PatchRow[]; warnings: string[] }> {
  const dshRoot = dirname(dirname(executable('dsh')))
  const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
  const appBootPath = requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')
  const appBoot = await import(pathToFileURL(appBootPath).href) as {
    composeEntries(layers: unknown[][], warn?: (message: string) => void): unknown[]
  }
  const warnings: string[] = []
  const rows = appBoot.composeEntries(layers, (message) => warnings.push(message)) as PatchRow[]
  return { rows, warnings }
}

/** The real preset plugin, whose `Config` is the registry's `PresetDefinition`. */
async function realPresetContract(): Promise<{
  validate(config: Record<string, unknown>): Record<string, unknown>
  entryListProblem(rows: unknown): string | undefined
}> {
  const presetRoot = packageRoot(AGENT_PRESET)
  const { default: AgentPreset } = await import(pathToFileURL(join(presetRoot, 'lib', 'index.js')).href) as {
    default: { Config: (value: unknown) => Record<string, unknown> }
  }
  const definitions = await import(
    pathToFileURL(join(packageRoot(PRESET_REGISTRY), 'lib', 'types', 'definition.js')).href
  ) as { entryListProblem(rows: unknown): string | undefined }
  return {
    validate: (config) => AgentPreset.Config(config),
    entryListProblem: (rows) => definitions.entryListProblem(rows),
  }
}

/* ------------------------------------------------------------------- B1 --- */

describe('B1 — the preset rows this bundle declares', () => {
  it('declares one valid @deepseek-ai/dsh-agent-preset row per built-in preset', () => {
    expect(presetRows.map((row) => row.id).sort()).toEqual(['preset-banbo', 'preset-planner'])
    for (const row of presetRows) {
      const config = row.config ?? {}
      // The declaration row's id addresses Loader edits; `config.id` is the
      // preset identity sessions save. They are conventionally related but not
      // required to match, so the patch pins both.
      expect(row.id).toBe(`${PRESET_ROW_PREFIX}${String(config.id)}`)
      expect(config.id).toEqual(expect.any(String))
      expect(config.name).toEqual(expect.any(String))
      expect(config.description).toEqual(expect.any(String))
      expect(config.order).toEqual(expect.any(Number))
      expect(Array.isArray(config.plugins)).toBe(true)
    }
    // The ids must be distinct: the roster is keyed by `config.id`.
    expect(new Set(presetRows.map((row) => (row.config ?? {}).id)).size).toBe(presetRows.length)
  })

  it('mounts both banbo runtimes inside each declared preset, keyed to that preset', () => {
    for (const row of presetRows) {
      const id = (row.config ?? {}).id as string
      const plugins = (row.config ?? {}).plugins as Array<Record<string, unknown>>
      const runtime = plugins.filter((child) => typeof child.name === 'string' && child.name.startsWith('@banbolee/dsh-agents/'))
      expect(runtime.map((child) => child.name).sort()).toEqual([
        '@banbolee/dsh-agents/delegation',
        '@banbolee/dsh-agents/main-runtime',
      ])
      for (const child of runtime) expect((child.config as Record<string, unknown>).agentId).toBe(id)
      for (const child of plugins) expect(typeof child.name, `${id} has a row without a package name`).toBe('string')
    }
  })

  it('the real 0.1.7 preset schema and entry-list validator accept every row', async () => {
    const contract = await realPresetContract()
    for (const row of presetRows) {
      const config = row.config ?? {}
      // The plugin's own Config schema is the authority on the declaration.
      expect(contract.validate(config)).toMatchObject({ id: config.id })
      // …and the registry's validator owns the child list, including groups.
      expect(contract.entryListProblem(config.plugins)).toBeUndefined()
    }
    // Negative control, so a validator that silently accepts anything cannot
    // make the two assertions above vacuous.
    expect(contract.entryListProblem([{ id: 'nameless' }])).toMatch(/names no plugin/)
    expect(() => contract.validate({ id: 'no-plugins' })).toThrow()
  })
})

/* ------------------------------------------------------------------- B2 --- */

describe('B2 — composing with the official web bundle', () => {
  it('adds our rows without touching the official registry row or preset ids', async () => {
    const official = bundlePatches(OFFICIAL_BUNDLE)
    const result = await composeOfficial([official, parsePatches(patchText)])
    const composed = flatten(result.rows)
    const byId = new Map(composed.filter((row) => row.id !== undefined).map((row) => [row.id as string, row]))

    // The registry row belongs to the official layer, and our patch leaves its
    // config exactly as it found it: `default: standard`.
    const registry = byId.get('agent-preset-registry')
    expect(registry?.name).toBe(PRESET_REGISTRY)
    expect(registry?.config).toMatchObject({ default: 'standard' })

    // The official presets and ours coexist, each id appearing once.
    for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
      expect(byId.get(id)?.name, `${id} must survive our layer`).toBe(AGENT_PRESET)
    }
    for (const row of presetRows) expect(byId.get(row.id as string)?.config).toEqual(row.config)
    expect(byId.get('banbo-agents')?.name).toBe('@banbolee/dsh-agents')

    const ids = composed.map((row) => row.id).filter((id): id is string => id !== undefined)
    expect(new Set(ids).size, 'our layer must not duplicate a composed row id').toBe(ids.length)
    expect(result.warnings.filter((warning) => /preset-banbo|preset-planner|banbo-agents/.test(warning))).toEqual([])
  })

  it("a user's own profile patch declares a preset the same way", async () => {
    // The documented shape (README.md, and `@deepseek-ai/dsh-agent-preset`'s own
    // `editing-cordis-compositions` skill): one inserted row, in the user's own
    // `$DSH_HOME/profiles/<profile>/cordis.patch.yml` or in a bundle they
    // install. Nothing scans a directory for it.
    const userPatch = parsePatches([
      '- insert:',
      '    - id: preset-review',
      `      name: '${AGENT_PRESET}'`,
      '      config:',
      '        id: review',
      '        name: Review',
      '        description: Reviews changes with the shell only.',
      '        order: 30',
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '            config:',
      '              prefix: You review software changes.',
      '          - id: tool-bash',
      "            name: '@deepseek-ai/dsh-tool-bash'",
      '',
    ].join('\n'))
    const userRows = flatten(userPatch).filter((row) => row.name === AGENT_PRESET)
    expect(userRows).toHaveLength(1)

    const contract = await realPresetContract()
    expect(contract.validate(userRows[0]!.config ?? {})).toMatchObject({ id: 'review' })
    expect(contract.entryListProblem((userRows[0]!.config ?? {}).plugins)).toBeUndefined()

    const result = await composeOfficial([
      bundlePatches(OFFICIAL_BUNDLE),
      parsePatches(patchText),
      userPatch,
    ])
    const ids = flatten(result.rows).map((row) => row.id)
    expect(ids).toContain('preset-review')
    expect(new Set(ids).size).toBe(ids.length)
    // A user preset does not disturb what this bundle declares.
    for (const row of presetRows) expect(ids).toContain(row.id)
  })
})

/* ------------------------------------------------------------------- B3 --- */

describe('B3 — the 0.1.5 directory-roster model is gone', () => {
  it('declares no roster patch, no roots and no shipped-root flag', () => {
    expect(patchText).not.toContain('agent-presets')
    expect(patchText).not.toContain('includeShippedRoot')
    expect(patchText).not.toContain('includeUserRoot')
    expect(patchText).not.toContain('roots')
    expect(ownRows.map((row) => row.name)).not.toContain(PRESET_REGISTRY)
    expect(existsSync(join(pluginRoot, 'presets')), 'a preset is a row, not a directory').toBe(false)
  })

  it('leaves no source-level use of the deleted roster API', () => {
    const host = readFileSync(join(pluginRoot, 'index.js'), 'utf8')
    // The 0.1.5 API read `ctx.agentPresets.roots`; 0.1.7's registry has no
    // `roots` member at all. `composedPreset` is the one member this bundle
    // still uses, and it is unchanged.
    expect(host).not.toMatch(/agentPresets\.roots/)
    expect(host).not.toMatch(/verifyRosterRoots|findPresetIdConflicts|shippedPresetIds/)
    expect(host).not.toMatch(/settings\.register\(/)
  })

  it('owns no dsh-tui seat and depends on no TUI package', () => {
    // 0.1.5 made this bundle patch the TUI's roster row as well
    // (`dsh-tui-agent-presets`, the id of the 0.1.2-era model). A preset is a
    // declaration now, so the registry row a profile composes manages it; a
    // TUI-specific patch target would be an assumption about another bundle's
    // internals, and neither the id nor the dead package may come back here.
    expect(patchText).not.toContain('dsh-tui')
    expect(patchText).not.toContain('@deepseek-ai/dsh-agent-presets')
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    const declared = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies), ...Object.keys(manifest.peerDependencies)]
    expect(declared.filter((name) => name.startsWith('@deepseek-harness-tui/'))).toEqual([])
  })
})

/* ------------------------------------------------------------------- B4 --- */

/**
 * dsh-tui's side of the same contract, read from the TUI bundle the way the
 * profile Loader reads it — never assumed.
 *
 * dsh-tui 0.11.1 is the release that adopts 0.1.7: its patch declares its OWN
 * registry row (`dsh-tui-agent-preset-registry`, package
 * `@deepseek-ai/dsh-agent-preset-registry`, config `{ default: standard }`) and
 * retires the 0.1.2-era `dsh-tui-agent-presets` roster whenever that registry
 * package resolves. A preset declared as a row therefore mounts under whichever
 * registry row the profile composes, which is why this bundle needs no TUI
 * patch target — and why the probe has to pin the BOUNDARY rather than one
 * happy version: an installed TUI that does not speak 0.1.7 is recorded as out
 * of family (no registry seat, and a peer range that stops below this bundle's
 * family), so a silent downgrade cannot pass as compatibility.
 */
describe('B4 — dsh-tui: which side of the 0.1.7 boundary is installed', () => {
  const TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui'

  function tuiBundle(): { version: string, text: string, peer: string | undefined } | undefined {
    try {
      const root = packageRoot(TUI_PACKAGE)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version: string
        peerDependencies?: Record<string, string>
      }
      return {
        version: manifest.version,
        text: readFileSync(join(root, 'cordis.patch.yml'), 'utf8'),
        peer: manifest.peerDependencies?.['@deepseek-ai/dsh-agent'],
      }
    } catch {
      return undefined
    }
  }

  /** Numeric compare of `x.y.z`, enough for the one floor this gate pins. */
  const atLeast = (version: string, floor: readonly number[]): boolean => {
    const parts = version.split('.')
    for (let index = 0; index < floor.length; index += 1) {
      const left = Number.parseInt(parts[index] ?? '0', 10)
      const right = floor[index]!
      if (left !== right) return left > right
    }
    return true
  }

  const tui = tuiBundle()

  it.skipIf(tui === undefined)('records which dsh-tui generation is installed, and that it is consistent', () => {
    const rows = flatten(parsePatches(tui!.text))
    const registry = rows.find((row) => row.name === PRESET_REGISTRY)
    const legacy = rows.find((row) => row.name === '@deepseek-ai/dsh-agent-presets')
    if (registry !== undefined) {
      // 0.1.7 generation (verified against 0.11.1).
      expect(atLeast(tui!.version, [0, 11, 0]), `registry seat from 0.11.0, installed ${tui!.version}`).toBe(true)
      expect(registry.config).toMatchObject({ default: 'standard' })
      expect(tui!.peer, 'its own peer range must accept this bundle family').toContain('0.1.7-rc.2')
      // The legacy roster survives only for a profile the registry cannot
      // serve: its disable expression names the registry package.
      expect(legacy, 'the legacy row is still declared for old profiles').toBeDefined()
      expect(JSON.stringify(legacy!.disabled)).toContain(PRESET_REGISTRY)
      return
    }
    // 0.1.5 generation (0.10.2 and older): no registry seat at all, and its
    // `@deepseek-ai/dsh-agent` peer stops below this bundle's family. This
    // bundle therefore does not support it — README states the floor.
    expect(tui!.peer, 'an old TUI must not claim this family').not.toContain('0.1.7-rc.2')
    expect(legacy, 'an old TUI has only the directory-scanning roster').toBeDefined()
  })

  it.skipIf(tui === undefined || !tui.text.includes(PRESET_REGISTRY))(
    'our rows are registry declarations, so the TUI layer manages them unchanged',
    async () => {
      // The same rows, composed with the TUI layer instead of the Web layer: no
      // id collision, and it is the TUI's registry row that carries them.
      const result = await composeOfficial([bundlePatches(TUI_PACKAGE), parsePatches(patchText)])
      const composed = flatten(result.rows)
      expect(composed.find((row) => row.name === PRESET_REGISTRY), 'the TUI layer must leave a registry row composed').toBeDefined()
      for (const row of presetRows) {
        expect(composed.find((candidate) => candidate.id === row.id)?.config).toEqual(row.config)
      }
      const ids = composed.map((row) => row.id).filter((id): id is string => id !== undefined)
      expect(new Set(ids).size, 'our layer must not duplicate a composed row id').toBe(ids.length)
      expect(result.warnings.filter((warning) => /preset-banbo|preset-planner|banbo-agents/.test(warning))).toEqual([])
    },
  )
})
