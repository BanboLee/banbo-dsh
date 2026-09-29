/**
 * Gate B — preset-ROW platform probes (the 0.1.7 model, unchanged at the
 * runtime this bundle now targets, dsh 0.2.0-rc.1).
 *
 * 0.1.7 replaced the 0.1.5 roster model wholesale: `@deepseek-ai/dsh-agent-presets`
 * does not exist at 0.1.7-rc.2, presets are no longer directories discovered
 * under `roots`, and a preset is declared as one
 * `@deepseek-ai/dsh-agent-preset` ROW (`config = { id, name?, description?,
 * order?, plugins }`) that the profile's own `@deepseek-ai/dsh-agent-preset-registry`
 * row owns. This file locks only platform facts about that model:
 *
 *   - the rows this bundle declares are VALID according to the real packages
 *     the `dsh` on PATH ships — 0.2.0-rc.1 as verified here, the version this
 *     bundle's `^0.2.0-rc.1` family names — (their own schema and entry-list
 *     validator), not according to a copy of it;
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
import { fallbackPeerChecker, type PeerChecker, type SemverLike } from './peer-compatibility-fallback.js'

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

  it('the real preset schema and entry-list validator of the installed runtime accept every row', async () => {
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
 * dsh-tui 0.11.1 was the release that adopted the 0.1.7 model this bundle
 * targets; 0.11.2 is the release installed and verified here, whose
 * `@deepseek-ai/dsh-agent` peer admits the `0.2.0-rc.1` runtime (0.11.1's peer
 * stops at `0.1.7-rc.2`). Its patch declares its OWN registry row
 * (`dsh-tui-agent-preset-registry`, package
 * `@deepseek-ai/dsh-agent-preset-registry`, config `{ default: standard }`) and
 * retires the 0.1.2-era `dsh-tui-agent-presets` roster whenever that registry
 * package resolves. A preset declared as a row therefore mounts under whichever
 * registry row the profile composes, which is why this bundle needs no TUI
 * patch target — and why the probe has to pin the BOUNDARY rather than one
 * happy version: an installed TUI that does not speak 0.1.7 is recorded as out
 * of family (no registry seat, and a peer range that stops below this bundle's
 * family), so a silent downgrade cannot pass as compatibility.
 *
 * Which side of that boundary a range falls on is a SEMVER question, never a
 * substring one: a range need not name a version it admits (`>=0.2.0-rc.0`),
 * and naming one can mean the opposite (`<0.2.0-rc.1`).
 */
describe('B4 — dsh-tui: which side of the 0.1.7 boundary is installed', () => {
  const TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui'

  /** The runtime this bundle's `^0.2.0-rc.1` family names. */
  const TARGET_DSH_VERSION = '0.2.0-rc.1'
  /** A runtime nothing here claims, so "it was accepted" can be shown to fail. */
  const UNSUPPORTED_DSH_VERSION = '0.3.0'

  type PeerEvaluator = (
    manifest: object,
    exemptions?: Readonly<Record<string, readonly string[]>>,
    runtimeVersion?: string,
  ) => { peers: Record<string, string> } | undefined

  // `PeerChecker` — "does EVERY `@deepseek-ai/dsh*` peer one manifest declares
  // admit a runtime" — lives beside the fallback it describes.

  /** `createRequire`, which resolves a package the way the Loader does. */
  type RequireFromDsh = (specifier: string) => unknown

  /** Resolve the evaluator. A rejection here is the fallback trigger. */
  type EvaluatorLoader = () => Promise<PeerEvaluator>

  /** Obtain semver; the fallback asks for the copy beside the `dsh` on PATH. */
  type SemverLoader = (fromDsh: RequireFromDsh) => SemverLike

  /** The evaluator the plugin manager refuses a plugin with, from `dsh` on PATH. */
  async function officialEvaluator(): Promise<PeerEvaluator> {
    const requireFromDsh = createRequire(join(dirname(dirname(executable('dsh'))), 'package.json'))
    const module = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')).href) as {
      evaluatePluginCompatibility: PeerEvaluator
    }
    return module.evaluatePluginCompatibility
  }

  /**
   * The platform's own answer to "do these peers admit this runtime": the
   * evaluator, resolved the way `composeOfficial` resolves it (from the `dsh`
   * installation on PATH), with plain `semver` beside that installation as the
   * documented fallback — the same call the evaluator itself delegates to,
   * prereleases participating.
   *
   * Both halves are injectable so a test can force the fallback branch (an
   * unresolvable app-boot) and observe which semver it consulted. The fallback
   * itself lives in `peer-compatibility-fallback.ts` and is held to the
   * official semantics case by case below.
   */
  async function peerChecker(
    loadEvaluator: EvaluatorLoader = officialEvaluator,
    loadSemver: SemverLoader = (fromDsh) => fromDsh('semver') as SemverLike,
  ): Promise<PeerChecker> {
    const requireFromDsh = createRequire(join(dirname(dirname(executable('dsh'))), 'package.json'))
    try {
      const evaluate = await loadEvaluator()
      return (manifest, runtimeVersion) => evaluate(manifest as object, {}, runtimeVersion) === undefined
    } catch {
      return fallbackPeerChecker(loadSemver(requireFromDsh))
    }
  }

  /** One declared peer, so the platform decision can be asked about a range. */
  const peerManifest = (range: string): object => ({
    name: 'gate-b-peer-probe',
    version: '0.0.0',
    peerDependencies: { '@deepseek-ai/dsh-agent': range },
  })

  /**
   * Ranges where "does it name `0.2.0-rc.1`?" and "does it admit `0.2.0-rc.1`?"
   * disagree — the substring question this file used to ask instead. All three
   * were rehearsed as counterexamples against the old assertion: the first two
   * were refused as incompatible while being compatible, the third was accepted
   * while being incompatible.
   */
  const PEER_RANGE_PROBES = [
    { range: '>=0.2.0-rc.0 <0.2.1', names: false, admits: true },
    { range: '>=0.2.0-rc.0', names: false, admits: true },
    { range: '<0.2.0-rc.1', names: true, admits: false },
  ] as const

  it('decides a peer range by semver, not by whether it names the target', async () => {
    const admits = await peerChecker()
    for (const probe of PEER_RANGE_PROBES) {
      // The substring answer, kept explicit because it is what the gate got
      // wrong: right only by accident on the row that names the target.
      expect(probe.range.includes(TARGET_DSH_VERSION), `${probe.range} spells the target out`).toBe(probe.names)
      // The real answer, from the platform's own evaluator.
      expect(admits(peerManifest(probe.range), TARGET_DSH_VERSION), `${probe.range} vs ${TARGET_DSH_VERSION}`)
        .toBe(probe.admits)
    }
  })

  it('still refuses what a range excludes, so acceptance is not vacuous', async () => {
    const admits = await peerChecker()
    // An exact pin names the target and still refuses every other runtime.
    expect(admits(peerManifest('0.2.0-rc.1'), UNSUPPORTED_DSH_VERSION)).toBe(false)
    // A bounded range admits the target and refuses a runtime above its ceiling.
    expect(admits(peerManifest('>=0.2.0-rc.0 <0.2.1'), UNSUPPORTED_DSH_VERSION)).toBe(false)
    // An unbounded floor admits both — what `>=` means, and the proof that the
    // probe reads the range instead of answering a constant.
    expect(admits(peerManifest('>=0.2.0-rc.0'), UNSUPPORTED_DSH_VERSION)).toBe(true)
  })

  /* ---- the fallback branch: reached only when app-boot does not resolve --- */

  /** The documented trigger: no `@deepseek-ai/dsh-app-boot` beside `dsh`. */
  const appBootMissing: EvaluatorLoader = () => Promise.reject(
    new Error('@deepseek-ai/dsh-app-boot is not resolvable from the dsh installation on PATH'),
  )

  /** What a checker answers, a throw included — the unit the two paths are compared in. */
  function outcome(check: PeerChecker, manifest: unknown, runtimeVersion: string): 'true' | 'false' | 'throw' {
    try {
      return check(manifest, runtimeVersion) ? 'true' : 'false'
    } catch {
      return 'throw'
    }
  }

  const PROBE_IDENTITY = { name: 'gate-b-peer-probe', version: '0.0.0' }

  /**
   * Every shape the fallback and the evaluator must agree on: the ranges a
   * manifest can declare (the `workspace:` protocol and the blank range
   * `semver.satisfies` alone would read as `*` included), the malformed peer
   * fields and manifests, and both runtimes.
   */
  const FALLBACK_PROBES: ReadonlyArray<{ label: string, manifest: unknown, runtime?: string }> = [
    { label: 'caret range', manifest: peerManifest('^0.2.0-rc.1') },
    { label: 'exact pin of the target', manifest: peerManifest(TARGET_DSH_VERSION) },
    { label: 'workspace:^', manifest: peerManifest('workspace:^') },
    { label: 'workspace:~', manifest: peerManifest('workspace:~') },
    { label: 'workspace:*', manifest: peerManifest('workspace:*') },
    { label: 'padded workspace:^', manifest: peerManifest(' workspace:^') },
    { label: 'empty range', manifest: peerManifest('') },
    { label: 'blank range', manifest: peerManifest('   ') },
    { label: 'no peers declared', manifest: PROBE_IDENTITY },
    { label: 'no dsh peer declared', manifest: { ...PROBE_IDENTITY, peerDependencies: { lodash: 'not a range' } } },
    { label: 'the bare @deepseek-ai/dsh peer', manifest: { ...PROBE_IDENTITY, peerDependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.1' } } },
    { label: 'a name that only looks like a dsh peer', manifest: { ...PROBE_IDENTITY, peerDependencies: { '@deepseek-ai/dshxy': 'not a range' } } },
    { label: 'peerDependencies is a number', manifest: { ...PROBE_IDENTITY, peerDependencies: 5 } },
    { label: 'peerDependencies is a string', manifest: { ...PROBE_IDENTITY, peerDependencies: 'range' } },
    { label: 'peerDependencies is an array', manifest: { ...PROBE_IDENTITY, peerDependencies: [] } },
    { label: 'peerDependencies is null', manifest: { ...PROBE_IDENTITY, peerDependencies: null } },
    { label: 'peerDependencies is undefined', manifest: { ...PROBE_IDENTITY, peerDependencies: undefined } },
    { label: 'a dsh range that is a number', manifest: { ...PROBE_IDENTITY, peerDependencies: { '@deepseek-ai/dsh-agent': 5 } } },
    { label: 'a non-dsh range that is a number', manifest: { ...PROBE_IDENTITY, peerDependencies: { lodash: 5 } } },
    { label: 'manifest is null', manifest: null },
    { label: 'manifest is undefined', manifest: undefined },
    { label: 'manifest is a number', manifest: 5 },
    { label: 'manifest is an array', manifest: [] },
    ...PEER_RANGE_PROBES.map((probe) => ({ label: `counterexample ${probe.range}`, manifest: peerManifest(probe.range) })),
    { label: 'caret range at an unsupported runtime', manifest: peerManifest('^0.2.0-rc.1'), runtime: UNSUPPORTED_DSH_VERSION },
    { label: 'workspace:^ at an unsupported runtime', manifest: peerManifest('workspace:^'), runtime: UNSUPPORTED_DSH_VERSION },
    { label: 'floor at an unsupported runtime', manifest: peerManifest('>=0.2.0-rc.0'), runtime: UNSUPPORTED_DSH_VERSION },
    { label: 'incompatible with no identity to name', manifest: { peerDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0-rc.1' } }, runtime: UNSUPPORTED_DSH_VERSION },
  ]

  describe('when the official evaluator does not resolve', () => {
    it('takes the fallback branch, and the semver beside dsh, prereleases on', async () => {
      // A recording double, so "the fallback ran" is observed rather than
      // assumed: the official path never consults semver itself, and the
      // fallback must consult the semver that ships beside dsh.
      const asked: Array<{ version: string, range: string, includePrerelease: boolean }> = []
      const semver: SemverLike = {
        valid: (value) => (value === TARGET_DSH_VERSION ? value : null),
        satisfies: (version, range, options) => {
          asked.push({ version, range, includePrerelease: options?.includePrerelease === true })
          return range.startsWith('^')
        },
      }
      const admits = await peerChecker(appBootMissing, () => semver)
      expect(admits(peerManifest('^0.2.0-rc.1'), TARGET_DSH_VERSION)).toBe(true)
      expect(admits(peerManifest(TARGET_DSH_VERSION), TARGET_DSH_VERSION)).toBe(false)
      expect(asked).toEqual([
        { version: TARGET_DSH_VERSION, range: '^0.2.0-rc.1', includePrerelease: true },
        { version: TARGET_DSH_VERSION, range: TARGET_DSH_VERSION, includePrerelease: true },
      ])
    })

    it('accepts the workspace protocol, exactly as the official evaluator does', async () => {
      const admits = await peerChecker(appBootMissing)
      // `workspace:^`/`~`/`*` mean "the runtime that is running", so they admit
      // it by construction. Asking semver about the string instead answers
      // false — the drift this test exists to catch.
      for (const range of ['workspace:^', 'workspace:~', 'workspace:*']) {
        expect(admits(peerManifest(range), TARGET_DSH_VERSION), range).toBe(true)
      }
      // Exact spellings only, as officially: a padded one is an ordinary
      // (invalid) range, refused rather than silently accepted.
      for (const range of [' workspace:^', 'workspace:^ ']) {
        expect(admits(peerManifest(range), TARGET_DSH_VERSION), JSON.stringify(range)).toBe(false)
      }
    })

    it('refuses an empty or blank range instead of reading it as `*`', async () => {
      const admits = await peerChecker(appBootMissing)
      // `semver.satisfies(v, '')` is TRUE — an empty range parses as `*` — so
      // the trim check is the whole difference between "did not constrain" and
      // "constrained, by accident".
      for (const range of ['', '   ', '\t\n']) {
        expect(admits(peerManifest(range), TARGET_DSH_VERSION), JSON.stringify(range)).toBe(false)
      }
    })

    it('fails closed on a malformed manifest or peer field, instead of passing an empty set', async () => {
      const admits = await peerChecker(appBootMissing)
      // `.filter(...).every(...)` answered `true` over the empty set here: a
      // number, a string, an array or `null` in place of the peer map went
      // silently green, and a malformed manifest was never examined at all.
      for (const peerDependencies of [5, 'range', ['@deepseek-ai/dsh-agent'], null, undefined]) {
        expect(() => admits({ ...PROBE_IDENTITY, peerDependencies }, TARGET_DSH_VERSION), JSON.stringify(peerDependencies)).toThrow()
      }
      // A range that is not a string is refused for EVERY peer, a non-dsh one
      // included: the official loop type-checks before it filters names.
      for (const range of [5, null, ['^0.2.0-rc.1'], { range: '^0.2.0-rc.1' }]) {
        expect(() => admits({ ...PROBE_IDENTITY, peerDependencies: { '@deepseek-ai/dsh-agent': range } }, TARGET_DSH_VERSION), JSON.stringify(range)).toThrow()
        expect(() => admits({ ...PROBE_IDENTITY, peerDependencies: { lodash: range } }, TARGET_DSH_VERSION), JSON.stringify(range)).toThrow()
      }
      // A manifest that is not an object, and a runtime that is not a semver,
      // are refused too — never answered with a boolean.
      for (const manifest of [null, undefined, 5, 'manifest', ['manifest']]) {
        expect(() => admits(manifest, TARGET_DSH_VERSION), JSON.stringify(manifest)).toThrow()
      }
      expect(() => admits(PROBE_IDENTITY, 'not-a-version')).toThrow()
      // …while the fail-closed posture did not turn acceptance into a throw.
      expect(admits(PROBE_IDENTITY, TARGET_DSH_VERSION)).toBe(true)
    })

    it('decides the same ranges the official path decides, counterexamples included', async () => {
      const admits = await peerChecker(appBootMissing)
      // A normal caret range still ADMITS the target: the fallback is not a
      // blanket refusal either.
      expect(admits(peerManifest('^0.2.0-rc.1'), TARGET_DSH_VERSION)).toBe(true)
      for (const probe of PEER_RANGE_PROBES) {
        expect(admits(peerManifest(probe.range), TARGET_DSH_VERSION), probe.range).toBe(probe.admits)
      }
      // And the shapes the probes cannot show: a floor admits a runtime above
      // the target, an exact pin refuses one.
      expect(admits(peerManifest('>=0.2.0-rc.0'), UNSUPPORTED_DSH_VERSION)).toBe(true)
      expect(admits(peerManifest(TARGET_DSH_VERSION), UNSUPPORTED_DSH_VERSION)).toBe(false)
    })

    it('agrees with the official evaluator on every probe, outcome for outcome', async () => {
      // The evaluator itself, not `peerChecker()`: without app-boot that path
      // would BE the fallback, and the comparison would prove nothing.
      const evaluate = await officialEvaluator()
      const official: PeerChecker = (manifest, runtimeVersion) => evaluate(manifest as object, {}, runtimeVersion) === undefined
      const fallback = await peerChecker(appBootMissing)
      for (const probe of FALLBACK_PROBES) {
        const runtime = probe.runtime ?? TARGET_DSH_VERSION
        expect(outcome(fallback, probe.manifest, runtime), `${probe.label} under the fallback`)
          .toBe(outcome(official, probe.manifest, runtime))
      }
      // The same answer repeated would satisfy a comparison too, so the table
      // has to contain acceptances, refusals AND throws.
      const kinds = FALLBACK_PROBES.map((probe) => outcome(fallback, probe.manifest, probe.runtime ?? TARGET_DSH_VERSION))
      expect([...new Set(kinds)].sort()).toEqual(['false', 'throw', 'true'])
    })
  })

  function tuiBundle(): { version: string, manifest: object, text: string, peer: string | undefined } | undefined {
    try {
      const root = packageRoot(TUI_PACKAGE)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version: string
        peerDependencies?: Record<string, string>
      }
      return {
        version: manifest.version,
        manifest,
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

  it.skipIf(tui === undefined)('records which dsh-tui generation is installed, and that it is consistent', async () => {
    const admits = await peerChecker()
    const rows = flatten(parsePatches(tui!.text))
    const registry = rows.find((row) => row.name === PRESET_REGISTRY)
    const legacy = rows.find((row) => row.name === '@deepseek-ai/dsh-agent-presets')
    if (registry !== undefined) {
      // 0.1.7 generation (registry seat from 0.11.0; verified against 0.11.2).
      expect(atLeast(tui!.version, [0, 11, 0]), `registry seat from 0.11.0, installed ${tui!.version}`).toBe(true)
      expect(registry.config).toMatchObject({ default: 'standard' })
      expect(
        admits(tui!.manifest, TARGET_DSH_VERSION),
        `installed dsh-tui ${tui!.version} declares peer ${JSON.stringify(tui!.peer)}, which must admit ${TARGET_DSH_VERSION}`,
      ).toBe(true)
      // A probe that cannot fail proves nothing: the same manifest against a
      // runtime no TUI release claims must be refused, peer by peer.
      expect(admits(tui!.manifest, UNSUPPORTED_DSH_VERSION)).toBe(false)
      // The legacy roster survives only for a profile the registry cannot
      // serve: its disable expression names the registry package.
      expect(legacy, 'the legacy row is still declared for old profiles').toBeDefined()
      expect(JSON.stringify(legacy!.disabled)).toContain(PRESET_REGISTRY)
      return
    }
    // 0.1.5 generation (0.10.2 and older): no registry seat at all, and its
    // `@deepseek-ai/dsh-agent` peer stops below this bundle's family. This
    // bundle therefore does not support it — README states the floor.
    expect(
      admits(tui!.manifest, TARGET_DSH_VERSION),
      `an old dsh-tui ${tui!.version} must not claim this family (peer ${JSON.stringify(tui!.peer)})`,
    ).toBe(false)
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
