/**
 * Public entrypoint of `@banbolee/dsh-agents` — the Host half of the bundle
 * (docs/agents-plugin-plan.md §8.4, §9.1, §9.2).
 *
 * The Host does one thing before anything else may run: read the built-in and
 * user catalog, merge and validate it, compile the immutable preset generation
 * and point `current` at it. Everything a preset-scope runtime later needs —
 * definitions, personas, the published ABI — is read once here and published
 * as the `banboAgents` service, because a per-preset standing scope must not do
 * file I/O inside a synchronous `agent/created` listener (§9.3).
 *
 * Failure is deliberately total and early: a bad user file throws out of this
 * plugin's asynchronous apply, which fails the whole plugin tree before the
 * Host reports ready, with the previously active generation still complete and
 * still pointed at (§8.6 crash semantics, §9.2).
 *
 * @module @banbolee/dsh-agents
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCatalog, readAbiManifest } from './catalog.js'
import { BanboAgentsCatalog } from './lib/catalog-remote.js'
import { compilePresets, presetRootDir, readCurrentGeneration, restoreGenerationPointer } from './preset-compiler.js'
import { CatalogError } from './schema.js'
import {
  AgentSettingsSchema,
  SETTINGS_BASE,
  SETTINGS_NAMESPACE,
  createSettingsView,
  validateAgentSettings,
} from './settings-policy.js'

/** The directory inside the harness home that holds all of this bundle's data. */
export const STATE_DIR_NAME = 'banbo-agents'

/** Bundle row id this plugin is mounted under (`cordis.patch.yml`). */
export const name = 'banbo-agents'

/**
 * The roster is patched by this bundle, so it must exist before the two roots
 * can be checked; `dshHomePath` is provided by the harness host at boot.
 */
export const inject = ['dshHomePath', 'agentPresets', 'settings']

/** Where this package's own files live, taken from the module URL. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

const CATALOG_DIR = 'catalog'
const PRESETS_DIR = 'presets'
const PRESET_METADATA_FILE = 'preset.yml'
const TEMPLATE_PATH = join('templates', 'agent.cordis.template.yml')
const HARNESS_PREFIX = '@deepseek-ai/dsh-'

/**
 * Plugin configuration: the state root is overridable for tests and for a
 * deployment that keeps its data outside the harness home, and `enabled: false`
 * removes the bundle from the running Host without uninstalling it.
 */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: '@banbolee/dsh-agents',
    validate(value) {
      const input = value ?? {}
      return {
        value: {
          rootDir: input.rootDir ?? undefined,
          enabled: input.enabled ?? true,
        },
      }
    },
  },
}

/** Read this package's manifest, the source of its declared version and ranges. */
function readPackageManifest(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
}

/**
 * The one harness dependency-family range this build targets (§11.2).
 *
 * The range is read from the manifest rather than resolved from the installed
 * tree: it must be identical on every machine, and the whole point of the
 * declaration is that the supported range is pinned in one reviewable place.
 * A manifest whose harness dependencies disagree is itself the defect, so it is
 * reported instead of silently picking one.
 *
 * @param manifest - a package manifest; defaults to this package's own.
 * @returns the declared range, or `'unknown'` when none is declared.
 * @throws {Error} when the harness dependencies declare more than one range.
 */
export function dependencyFamilyVersion(manifest = readPackageManifest(PACKAGE_ROOT)) {
  const ranges = new Set()
  for (const [dependency, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (dependency.startsWith(HARNESS_PREFIX)) ranges.add(range)
  }
  if (ranges.size === 0) return 'unknown'
  if (ranges.size > 1) {
    throw new Error(
      `@banbolee/dsh-agents: every ${HARNESS_PREFIX}* dependency must declare one uniform family range, found ${[...ranges].sort().join(', ')}`,
    )
  }
  return [...ranges][0]
}

/**
 * Preset ids that already ship inside this package (§8.2).
 *
 * A built-in main agent is read through the merged definition by its own
 * runtime; only a user agent whose `presetId` is absent here needs a generated
 * preset directory.
 *
 * @param packageRoot - the package root; defaults to this package's.
 * @returns the shipped preset ids, empty when the directory is unreadable.
 */
export function shippedPresetIds(packageRoot = PACKAGE_ROOT) {
  try {
    return new Set(
      readdirSync(join(packageRoot, PRESETS_DIR), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    )
  } catch {
    return new Set()
  }
}

/**
 * The ABI manifest of the generation currently pointed at.
 *
 * A missing `current` pointer is the legitimate first-startup state and yields
 * `undefined`. A pointer that resolves while its `abi.json` is absent, however,
 * means the ACTIVE generation is incomplete; continuing would silently drop the
 * published-ABI protection of §11.2, so that fails loud instead.
 */
function readPreviousAbi(rootDir) {
  const current = readCurrentGeneration(rootDir)
  if (current === undefined) return undefined
  const manifest = readAbiManifest(join(current, 'abi.json'))
  if (manifest === undefined) {
    throw new CatalogError(
      'abi-missing',
      `the active generation has no abi.json; refusing to start with published-ABI protection disabled. Restore the file or delete "${current}" and restart`,
      { file: join(current, 'abi.json'), field: 'abi.json' },
    )
  }
  return manifest
}

/**
 * @typedef {object} HostCatalogState
 * @property {string} rootDir the plugin's state root
 * @property {string} packageRoot this package's install root
 * @property {object | undefined} previous the ABI manifest that was active
 * @property {Map<string, object>} definitions the merged, validated catalog
 * @property {Set<string>} builtinIds ids supplied by the installed package
 * @property {Map<string, object>} personas resolved persona texts
 * @property {number} totalPersonaBytes
 * @property {string} generation
 * @property {string} generationDir
 * @property {boolean} reused
 * @property {string} presetRootDir the root the roster mounts
 * @property {object} abi the manifest now published
 */

/**
 * Load, merge, validate and compile — the whole of Host startup (§9.2).
 *
 * @param options - `rootDir`, optional `packageRoot` and `previous`.
 * @returns the {@link HostCatalogState}.
 * @throws {CatalogError | Error} on the first violation; nothing is activated.
 */
export function initialiseCatalog(options) {
  const rootDir = options.rootDir
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('initialiseCatalog requires an absolute rootDir')
  }
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT
  const manifest = readPackageManifest(packageRoot)
  const previous = options.previous ?? readPreviousAbi(rootDir)

  const catalog = loadCatalog({
    rootDir,
    builtinDir: join(packageRoot, CATALOG_DIR),
    builtinRootDir: packageRoot,
    previous,
  })

  const compiled = compilePresets({
    rootDir,
    templateText: readFileSync(join(packageRoot, TEMPLATE_PATH), 'utf8'),
    definitions: catalog.definitions,
    builtinPresetIds: shippedPresetIds(packageRoot),
    dshVersion: dependencyFamilyVersion(manifest),
    selfVersion: manifest.version,
    previous,
  })

  return { rootDir, packageRoot, previous, ...catalog, ...compiled }
}

/**
 * Duplicate preset ids across the roster's roots (§8.5).
 *
 * The official roster resolves a duplicate by taking the earlier root. That is
 * exactly the silent shadowing a user cannot debug, so any duplicate is a
 * configuration error here and both source paths are reported.
 *
 * @param roots - the roster's resolved roots.
 * @returns one entry per duplicated id, `paths` in root order.
 */
export function findPresetIdConflicts(roots) {
  const seen = new Map()
  const conflicts = []
  for (const root of roots ?? []) {
    const dir = root?.path
    if (typeof dir !== 'string' || dir === '') continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // A configured root that does not exist yet is not a conflict.
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (!existsSync(join(path, PRESET_METADATA_FILE))) continue
      const previous = seen.get(entry.name)
      if (previous === undefined) seen.set(entry.name, path)
      else conflicts.push({ presetId: entry.name, paths: [previous, path] })
    }
  }
  return conflicts
}

/**
 * Compare root paths the way the roster stores them: resolved, no trailing
 * separator, and — when the path exists — canonicalised through symlinks.
 *
 * The canonicalisation is load-bearing for a linked ("source") install. The
 * roster stores its configured root verbatim, so it holds
 * `<profile>/node_modules/@banbolee/dsh-agents/presets`, while Node resolves the
 * same package through that symlink and `import.meta.url` therefore yields the
 * checkout path. Comparing the two lexically rejects a perfectly correct install
 * and blames another bundle for it.
 */
function normaliseDir(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const absolute = resolve(value)
  const stripped = absolute.endsWith(sep) ? absolute.slice(0, -1) : absolute
  try {
    return realpathSync(stripped)
  } catch {
    // A root that does not exist keeps its lexical form, so the caller still
    // reports it as missing — which is the accurate answer.
    return stripped
  }
}

/**
 * Refuse to run when the roster does not mount both of this bundle's roots
 * (§8.4).
 *
 * Cordis patches replace a config object wholesale, so another bundle that
 * patches the same `agent-presets` row silently removes our roots. Failing
 * loudly here names the missing path; silently ignoring another bundle's roots
 * would leave a roster that mounts none of our presets.
 *
 * @param roots - the roster's resolved roots.
 * @param expected - the absolute root directories this bundle mounts.
 * @throws {Error} naming every missing root.
 */
export function verifyRosterRoots(roots, expected) {
  const present = new Set()
  for (const root of roots ?? []) {
    const path = normaliseDir(root?.path)
    if (path !== undefined) present.add(path)
  }
  const missing = expected.filter((path) => !present.has(normaliseDir(path)))
  if (missing.length === 0) return
  throw new Error(
    `@banbolee/dsh-agents: the \`agent-presets\` roster is missing ${missing.length === 1 ? 'the root' : 'the roots'} this bundle mounts: ` +
      `${missing.join(', ')}. Another bundle is patching the same roster row; merge the roots by hand instead of removing one of the bundles.`,
  )
}

/**
 * Mount the Host half: prepare the generation, prove the roster mounts it, and
 * publish the catalog for the per-preset runtimes.
 *
 * `apply` is asynchronous on purpose. Cordis awaits a plugin's apply before the
 * fiber reports ready, so every file read and every validation error lands
 * before the Host is ready and no half-read catalog can ever be observed.
 *
 * @param ctx - the harness context.
 * @param config - validated {@link Config}.
 */
export default async function apply(ctx, config) {
  if (config?.enabled === false) return
  const rootDir = config?.rootDir ?? ctx.dshHomePath(STATE_DIR_NAME)

  // Prove the roster composition BEFORE compiling anything. Both checks below
  // used to run after `initialiseCatalog`, which meant a duplicate preset id
  // failed startup with a NEW generation already activated — the one failure
  // class where "nothing is activated on failure" did not hold (§9.2). The
  // expected generated root is a pure function of `rootDir`, so it is known
  // before the compile.
  const expectedPresetRoot = presetRootDir(rootDir)
  const rosterRoots = ctx.agentPresets.roots
  verifyRosterRoots(rosterRoots, [join(PACKAGE_ROOT, PRESETS_DIR), expectedPresetRoot])

  const conflicts = findPresetIdConflicts(rosterRoots)
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((conflict) => `${conflict.presetId}: ${conflict.paths.join(' and ')}`)
      .join('; ')
    throw new Error(`@banbolee/dsh-agents: duplicate preset id(s) across the roster roots — ${detail}`)
  }

  // The generation live BEFORE this boot, so a post-activation failure can put
  // it back instead of leaving a catalog that never ran pointed at.
  const previousGenerationDir = readCurrentGeneration(rootDir)

  const state = initialiseCatalog({ rootDir, packageRoot: PACKAGE_ROOT })
  /* v8 ignore next -- presetRootDir is a pure function of rootDir; this guards a future refactor. */
  if (state.presetRootDir !== expectedPresetRoot) {
    throw new Error(
      `@banbolee/dsh-agents: internal invariant violated — compiled preset root ${state.presetRootDir} does not match the verified root ${expectedPresetRoot}`,
    )
  }

  // `compilePresets` activates as part of compiling, so every step below this
  // point runs with the NEW generation already live. Anything that can still
  // fail must roll the pointer back, or a failed boot would leave a catalog
  // that never ran pointing `current` (§9.2, README's "旧 generation 与 current
  // 指针保持原样"). `restoreGenerationPointer` is that rollback.
  try {
    // §13.1.1 `catalog/generation`: the one startup fact an operator needs to
    // answer "did this boot reuse a generation or write a new one".
    // Privacy-safe by construction — a content hash and two counts, never a
    // path or a persona.
    ctx.logger.info('banbo-agents: catalog/generation', {
      generation: state.generation,
      agentCount: state.definitions.size,
      reused: state.reused,
    })

    const settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, AgentSettingsSchema, {
      base: SETTINGS_BASE,
      validate: (value) => validateAgentSettings(value, state),
    })
    const settings = createSettingsView(settingsScope, state)

    const warnIgnoredSettings = (value) => {
      for (const agentId of Object.keys(value.agents ?? {})) {
        if (state.definitions.has(agentId)) continue
        ctx.logger.warn(
          `@banbolee/dsh-agents: settings for deleted or retired agent "${agentId}" are retained but ignored; restore its YAML and restart, or remove the stale settings entry`,
        )
      }
    }
    warnIgnoredSettings(settings.get())
    settingsScope.watch?.((next) => warnIgnoredSettings(next))

    // Preloaded data only: a preset-scope runtime reads this instead of touching
    // the filesystem inside a synchronous `agent/created` listener (§9.3).
    ctx.provide('banboAgents', Object.freeze({
      rootDir: state.rootDir,
      packageRoot: state.packageRoot,
      generation: state.generation,
      generationDir: state.generationDir,
      presetRootDir: state.presetRootDir,
      definitions: state.definitions,
      builtinIds: state.builtinIds,
      personas: state.personas,
      abi: state.abi,
      settings,
      // The composition's tool registry, captured per preset BEFORE any agent's
      // own `tools.restrict()` narrows it (§16.5 / R3). A child's capability
      // must be resolved against what the COMPOSITION registers, and the
      // plugin's own context cannot observe that: `dsh-scope` tags scopes with
      // a module-private symbol, so a `link:` install that resolves its own copy
      // of that module reads `scopeOf(ctx)` as undefined and `schemas(...)`
      // degrades to the GLOBAL layer. `main-runtime` fills this in at the one
      // moment the unrestricted surface is observable — main-agent activation.
      // Do not replace this with a scope lookup, and do not rely on
      // cross-package module identity here.
      compositionTools: new Map(),
      // The delegation surface THIS bundle registers into each preset scope
      // (`agent_<id>` and `delegate_batch`), published by the delegation runtime
      // at apply time. Capability resolution needs it to tell the plugin's own
      // tools apart from third-party ones: the former are not in the capability
      // vocabulary but must never be handed to an Agent that is not authorised
      // to call them (§5.2).
      delegationTools: new Set(),
    }))
    new BanboAgentsCatalog(ctx)
  } catch (error) {
    restoreGenerationPointer(rootDir, previousGenerationDir)
    throw error
  }
}

// Cordis reads plugin metadata off the entry object: attach the named exports
// so both `ctx.plugin(defaultImport)` and a namespace-object load honour them.
apply.inject = inject
apply.Config = Config
