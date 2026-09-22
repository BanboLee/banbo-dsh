/**
 * The preset compiler — docs/agents-plugin-plan.md §8.2–§8.7.
 *
 * A user agent is a YAML definition; the harness only mounts compositions that
 * live inside a preset directory. The compiler is the bridge between the two,
 * and it owns exactly three things:
 *
 *   - **the composition template** — one in-package file, with a single
 *     `<agentId>` placeholder. Every shipped preset and every generated preset
 *     is that template rendered, so a shipped preset can never drift from it;
 *   - **the standard inventory** — a digest of the official `standard`
 *     composition the template was copied from, so a harness upgrade cannot let
 *     the copy rot silently (§8.3);
 *   - **generations** — user presets are written into an immutable
 *     `generations/<hash>/` directory that is only ever activated by atomically
 *     replacing one `current` pointer (§8.6). Nothing is ever edited in place,
 *     so a running process keeps reading the generation it started with.
 *
 * Crash safety rests on three rules, and on nothing else — there is no lock:
 *
 *   1. a generation is built under a `.partial-*` name and `rename`d into place
 *      only after its `complete` marker exists, so a half-written generation is
 *      never visible under a generation name;
 *   2. the pointer is swapped by writing a temporary link and `rename`ing it
 *      over `current`, which is atomic on POSIX;
 *   3. cleanup removes only directories this plugin can prove it owns — a
 *      generation carrying our `complete` marker, or one still under our
 *      `.partial-` prefix. Anything else in `.generated/` is left alone.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

import { AGENT_ID_PATTERN, CatalogError, deriveToolName } from './schema.js'

/** The one placeholder the composition template carries, substituted per agent. */
export const COMPOSITION_TEMPLATE_PLACEHOLDER = '{{agentId}}'

/** Written last inside a generation; its presence is what makes one activatable. */
export const COMPLETE_MARKER = 'complete'

/** The ABI manifest file name inside a generation. */
export const ABI_MANIFEST = 'abi.json'

/** The plugin-owned state directory under the host state root. */
export const GENERATED_ROOT = '.generated'

/** Holds one directory per generation hash. */
export const GENERATIONS_DIR = 'generations'

/** The single mutable name: a symlink to the active generation directory. */
export const CURRENT_POINTER = 'current'

/** Prefix marking a directory the compiler is still building. */
export const PARTIAL_PREFIX = '.partial-'

/** The shipped preset the composition template was derived from. */
export const STANDARD_PRESET_ID = 'standard'

/** The package the official `standard` composition is read from. */
export const PRESET_PACKAGE_ID = '@deepseek-ai/dsh-agent-presets'

/**
 * Bumped when the on-disk layout below `.generated/` changes shape, so an old
 * generation can never be mistaken for a current one.
 */
export const GENERATION_LAYOUT_VERSION = 1

/** Symlink creation itself is unavailable on Windows without a developer mode. */
const SYMLINK_UNAVAILABLE_CODES = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EACCES'])

/* ---------------------------------------------------------------- helpers --- */

/** Whether a value is a plain record (not an array, not null). */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Deterministic, key-sorted JSON — the only form any digest in here hashes. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Lowercase hex SHA-256 of one UTF-8 string. */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** `lstat`-based existence, so a dangling symlink still counts as present. */
function lexists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Remove one path without following it and without failing when it is absent. */
function removePath(path) {
  rmSync(path, { recursive: true, force: true })
}

/** Sort by `id`, the stable order every manifest and payload uses. */
const byId = (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

/* ------------------------------------------------------ template renderer --- */

/**
 * Render the composition template for one agent.
 *
 * Only the agent-id placeholder is substituted; `{{model}}` and `{{cwd}}` are
 * the harness's own placeholders and must survive into the mounted composition
 * verbatim, which is why the guard below names one placeholder rather than
 * rejecting every `{{...}}` it sees.
 *
 * @param templateText - the in-package template bytes.
 * @param agentId - the catalog agent id to substitute in.
 * @returns the composition text for that agent.
 * @throws {Error} when the id is not usable or the template lost its placeholder.
 */
export function renderComposition(templateText, agentId) {
  if (typeof templateText !== 'string') {
    throw new TypeError('composition template must be a string')
  }
  if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`agent id ${JSON.stringify(agentId)} is not usable: it must match ${AGENT_ID_PATTERN}`)
  }
  if (!templateText.includes(COMPOSITION_TEMPLATE_PLACEHOLDER)) {
    throw new Error(`composition template does not contain ${COMPOSITION_TEMPLATE_PLACEHOLDER}; it cannot be rendered per agent`)
  }
  return templateText.split(COMPOSITION_TEMPLATE_PLACEHOLDER).join(agentId)
}

/* ---------------------------------------------------- standard inventory --- */

/** Final runtime tool names registered by one rc.2 package row. */
const FIXED_RUNTIME_TOOLS = Object.freeze({
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-fs': ['edit', 'read', 'read_image', 'write'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-jobs': ['job_kill', 'job_list', 'job_output'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  '@deepseek-ai/dsh-plan-mode': ['exit_plan_mode'],
  '@deepseek-ai/dsh-tool-subagent-control': ['interrupt_agent', 'send_message'],
  '@deepseek-ai/dsh-tool-subagent-control/list-agents': ['list_agents'],
  '@deepseek-ai/dsh-tool-ralph': ['ralph'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-present': ['present'],
})

/** Derive current public runtime tool names from one non-disabled row. */
function runtimeTools(row) {
  if (row.disabled === true || typeof row.name !== 'string') return []
  const fixed = FIXED_RUNTIME_TOOLS[row.name]
  if (fixed !== undefined) return fixed
  const config = isRecord(row.config) ? row.config : {}
  if (row.name === '@deepseek-ai/dsh-tool-subagent') {
    const toolName = typeof config.toolName === 'string' ? config.toolName : 'subagent'
    return [toolName, ...(config.modelSelectionSettings === true ? ['list_subagent_models'] : [])]
  }
  if (row.name === '@deepseek-ai/dsh-tool-workflow') {
    return [typeof config.toolName === 'string' ? config.toolName : 'workflow']
  }
  if (row.name === '@deepseek-ai/dsh-tool-web') {
    return [
      ...(config.search === false ? [] : ['web_search']),
      ...(config.fetch === false ? [] : ['web_fetch']),
    ]
  }
  return []
}

/**
 * @typedef {object} StandardRow
 * @property {string} [id] the loader row id
 * @property {string} [name] the package or `cordis:group` marker
 * @property {unknown} [disabled] the disable gate, verbatim
 * @property {unknown} [group] the group marker, verbatim
 * @property {Record<string, unknown>} [isolate] the isolate realms this row opens
 * @property {unknown} [config] the complete non-group plugin config, verbatim
 */

/** Parse a composition into its loader rows, or fail loudly. */
function parseCompositionRows(source) {
  const document = parseDocument(source, { schema: 'core', merge: false })
  const firstError = document.errors[0]
  if (firstError !== undefined) {
    throw new Error(`composition is not readable YAML: ${firstError.message}`)
  }
  const value = document.toJS()
  if (!Array.isArray(value)) {
    throw new Error('composition root must be a sequence of loader rows')
  }
  return value
}

/** Flatten rows depth-first, keeping one summary record per row. */
function collectRows(value, out, tools) {
  if (!Array.isArray(value)) return
  for (const row of value) {
    if (!isRecord(row)) continue
    /** @type {StandardRow} */
    const record = {}
    if (typeof row.id === 'string') record.id = row.id
    if (typeof row.name === 'string') record.name = row.name
    if (row.disabled !== undefined) record.disabled = row.disabled
    if (row.group !== undefined) record.group = row.group
    if (isRecord(row.isolate)) record.isolate = row.isolate
    // A group's config is its child-row sequence, represented by the flattened
    // rows below. Every other config is plugin behavior and must participate in
    // both the readable inventory and the digest.
    if (row.config !== undefined && !Array.isArray(row.config)) record.config = row.config
    out.push(record)
    for (const name of runtimeTools(row)) tools.add(name)
    // Group members are rows too: a member appearing or leaving is exactly the
    // kind of change the inventory exists to make visible.
    if (Array.isArray(row.config)) collectRows(row.config, out, tools)
  }
}

/**
 * Summarise a composition into the rows it mounts and one digest over them.
 *
 * The digest is computed from the parsed structure, never from the source text,
 * so reformatting or re-commenting the official file does not raise a false
 * alarm while adding, removing, renaming, disabling or re-isolating a row does.
 *
 * @param compositionText - a composition file's contents.
 * @returns the frozen `{rows, digest, tools}` inventory.
 */
export function computeStandardInventory(compositionText) {
  /** @type {StandardRow[]} */
  const rows = []
  const tools = new Set()
  collectRows(parseCompositionRows(compositionText), rows, tools)
  const digest = `sha256:${sha256(canonical(rows))}`
  return Object.freeze({
    rows: Object.freeze(rows),
    digest,
    tools: Object.freeze([...tools].sort()),
  })
}

/**
 * Locate the installed official `standard` composition.
 *
 * Returns `undefined` rather than throwing when the presets package is absent:
 * the inventory is a CI-time drift gate, not a runtime dependency.
 *
 * @returns the absolute path, or undefined.
 */
export function standardCompositionPath() {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`${PRESET_PACKAGE_ID}/package.json`)
    const path = join(dirname(manifest), 'presets', STANDARD_PRESET_ID, 'agent.cordis.yml')
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

/* --------------------------------------------------------- ABI manifest --- */

/**
 * @typedef {object} AgentAbiRecord
 * @property {string} id
 * @property {string} toolName
 * @property {string} [presetId]
 * @property {boolean} hasMain
 * @property {boolean} hasChild
 * @property {'one-shot' | 'optional'} [childContinuation]
 * @property {string[]} toolCapabilityNames
 * @property {string[]} allowedChildren
 * @property {boolean} [retired]
 * @property {'definition-file-missing'} [retiredReason]
 * @property {string} [definitionHash]
 * @property {string} displayName
 * @property {string} description
 */

/** Every ordinary tool capability a definition's two forms request. */
function capabilityNamesOf(definition) {
  const names = new Set()
  for (const form of [definition.main, definition.child]) {
    if (form === undefined || form === null) continue
    for (const tool of [...(form.tools ?? []), ...(form.extraTools ?? [])]) names.add(tool)
  }
  return [...names].sort()
}

/**
 * Project one definition onto its published ABI shape (§11.2).
 *
 * Everything a retired row still needs to render lives here, because once the
 * definition file is gone this record is the only surviving source.
 *
 * @param definition - a merged, validated definition.
 * @returns the ABI record.
 */
function abiRecordFor(definition) {
  /** @type {AgentAbiRecord} */
  const record = {
    id: definition.id,
    toolName: deriveToolName(definition.id),
    hasMain: definition.main !== undefined,
    hasChild: definition.child !== undefined,
    toolCapabilityNames: capabilityNamesOf(definition),
    allowedChildren: [...(definition.allowedChildren ?? [])],
    displayName: definition.displayName,
    description: definition.description,
    definitionHash: sha256(canonical(definition)),
  }
  if (definition.main !== undefined) record.presetId = definition.main.presetId
  if (definition.child !== undefined) record.childContinuation = definition.child.continuation
  return record
}

/** Accept one manifest, a list of manifests, or nothing. */
function previousRecords(previous) {
  if (previous === undefined || previous === null) return []
  const manifests = Array.isArray(previous) ? previous : [previous]
  return manifests.flatMap((manifest) => (Array.isArray(manifest?.agents) ? manifest.agents : []))
}

/**
 * Build the ABI manifest for one generation.
 *
 * Two rules meet here. A published id keeps its shape, and an id whose
 * definition file has disappeared becomes a durable empty shell instead of
 * vanishing: the tool name stays reserved so a historical child's frozen
 * `toolFilter` still resolves and so the name can never be handed to a
 * different agent (§4.1, §6.3, §11.2).
 *
 * @param options - `definitions`, `previous`, `generation`, `dshVersion`, `selfVersion`.
 * @returns the manifest, agents sorted by id.
 */
export function computeAbiManifest(options) {
  const definitions = options.definitions
  const generation = options.generation ?? ''
  const dshVersion = options.dshVersion ?? 'unknown'
  const selfVersion = options.selfVersion ?? '0.0.0'

  /** @type {Map<string, AgentAbiRecord>} */
  const records = new Map()
  for (const definition of definitions) records.set(definition.id, abiRecordFor(definition))

  for (const record of previousRecords(options.previous)) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue
    if (record.retired === true) {
      // A retired shell is carried forward only while its id is STILL gone.
      // Restoring the definition revives it (§12.1), and the freshly computed
      // record already sitting in `records` is the one that wins.
      if (records.has(record.id)) continue
      records.set(record.id, {
        ...record,
        retired: true,
        retiredReason: record.retiredReason ?? 'definition-file-missing',
      })
      continue
    }
    if (!records.has(record.id)) {
      records.set(record.id, { ...record, retired: true, retiredReason: 'definition-file-missing' })
    }
  }

  return {
    layout: GENERATION_LAYOUT_VERSION,
    generation,
    dshVersion,
    selfVersion,
    agents: [...records.values()].sort(byId),
  }
}

/* ------------------------------------------------------------ filesystem --- */

/** The directory a roster root must mount: the active generation's presets. */
export function presetRootDir(rootDir) {
  return join(rootDir, GENERATED_ROOT, CURRENT_POINTER, 'presets')
}

/**
 * Undo one activation: re-point `current` at the generation that was live
 * before it, or remove the pointer when there was none.
 *
 * `compilePresets` activates as part of compiling, so any startup step that can
 * still fail afterwards would otherwise leave a NEW generation live for a
 * catalog that never ran — breaking "nothing is activated on failure" (§9.2)
 * and advancing the published ABI behind a failed boot. This is the rollback
 * for exactly that window.
 *
 * @param rootDir - the plugin's state root.
 * @param previousGenerationDir - the generation that was live before, if any.
 */
export function restoreGenerationPointer(rootDir, previousGenerationDir) {
  const base = join(rootDir, GENERATED_ROOT)
  const pointer = join(base, CURRENT_POINTER)
  if (previousGenerationDir === undefined) {
    // No earlier generation existed, so the honest post-failure state is "no
    // pointer" rather than one naming a generation the Host never accepted.
    removePath(pointer)
    return
  }
  activateGeneration(rootDir, previousGenerationDir)
}

/** Whether a directory holds a generation this plugin completed. */
function isCompleteGeneration(dir) {
  try {
    return lstatSync(join(dir, COMPLETE_MARKER)).isFile()
  } catch {
    return false
  }
}

/** Resolve the active generation directory, or undefined when there is none. */
export function readCurrentGeneration(rootDir) {
  const base = join(rootDir, GENERATED_ROOT)
  const pointer = join(base, CURRENT_POINTER)
  try {
    const stats = lstatSync(pointer)
    const target = stats.isSymbolicLink() ? readlinkSync(pointer) : readFileSync(pointer, 'utf8').trim()
    if (target === '') return undefined
    const resolved = resolve(dirname(pointer), target)
    // The pointer may only ever name a directory under `generations/`. Anything
    // else is stale or hostile and must not be followed, let alone cleaned.
    const generations = join(base, GENERATIONS_DIR)
    if (resolved !== generations && !resolved.startsWith(generations + sep)) return undefined
    return resolved
  } catch {
    return undefined
  }
}

/**
 * Point `current` at one generation.
 *
 * The link is created under a temporary name and `rename`d over `current`, so a
 * reader either sees the previous generation or the new one — never a missing
 * pointer (§8.6).
 *
 * @param rootDir - the plugin's state root.
 * @param generationDir - the absolute generation directory to activate.
 * @returns the link target, relative to `.generated/`.
 */
function activateGeneration(rootDir, generationDir) {
  const base = join(rootDir, GENERATED_ROOT)
  const pointer = join(base, CURRENT_POINTER)
  const target = relative(base, generationDir)
  mkdirSync(base, { recursive: true, mode: 0o700 })

  const temporary = join(base, `.${CURRENT_POINTER}.${process.pid}.${randomUUID()}`)
  removePath(temporary)
  createPointerLink(temporary, target, generationDir)

  try {
    renameSync(temporary, pointer)
  } catch (error) {
    removePath(temporary)
    throw new Error(
      `cannot atomically activate generated presets: renaming the temporary pointer over ${pointer} failed (${error.code ?? 'unknown'}). ` +
        'The previous pointer was preserved. See docs/agents-plugin-plan.md §8.7 for the platform fallback ladder.',
      { cause: error },
    )
  }
  return target
}

/**
 * Create the pointer link, taking the first mechanism §8.7 makes available.
 *
 *   1. a directory symlink (native on POSIX; on Windows it needs Developer Mode
 *      or elevation);
 *   2. a Windows junction, which needs no elevation and can only point at a
 *      directory — exactly this use case.
 *
 * Both are created under a temporary name so the caller can rename them over
 * `current` atomically. The third ladder step (two live roots plus an
 * invalidation marker) is deliberately NOT implemented: it would change the
 * verified roster composition, and it is unreachable while a junction exists on
 * every Windows filesystem this plugin supports. When neither mechanism works
 * this throws instead of degrading silently.
 *
 * @param temporary - the staging path the link is created at.
 * @param target - the link target relative to `.generated/`, for a symlink.
 * @param generationDir - the absolute generation directory, for a junction.
 * @throws {Error} when no link mechanism is available.
 */
function createPointerLink(temporary, target, generationDir) {
  try {
    symlinkSync(target, temporary, 'dir')
    return
  } catch (error) {
    if (!SYMLINK_UNAVAILABLE_CODES.has(error?.code)) throw error
    try {
      // A junction stores an ABSOLUTE target, so it must be handed the resolved
      // generation directory rather than the relative pointer target.
      symlinkSync(generationDir, temporary, 'junction')
      return
    } catch (junctionError) {
      throw new Error(
        `cannot activate generated presets: neither a directory symlink (${String(error.code)}) nor a junction ` +
          `(${String(junctionError?.code ?? 'unknown')}) could be created at ${temporary}. ` +
          'See docs/agents-plugin-plan.md §8.7 for the platform fallback ladder.',
        { cause: junctionError },
      )
    }
  }
}

/**
 * Delete generations this plugin owns, keeping the active one and one rollback.
 *
 * Ownership is proven, never assumed: a directory is removed only when it
 * carries our `complete` marker or still sits under our `.partial-` build
 * prefix. A user directory that happens to live in `generations/` is left
 * exactly as it was (§8.6 step 6, §8.6 startup rule 3).
 *
 * @param generationsDir - the `generations/` directory.
 * @param keep - the generation directories to retain.
 * @param rootDir - the plugin data root, re-read for the LIVE pointer target.
 * @returns the names that were removed.
 */
function pruneGenerations(generationsDir, keep, rootDir) {
  const keepSet = new Set(keep.filter((path) => path !== undefined))
  // Re-read the pointer at prune time: a concurrent Host may have activated a
  // different generation since this compile started, and that one is in use.
  const live = readCurrentGeneration(rootDir)
  if (live !== undefined) keepSet.add(live)
  /** @type {string[]} */
  const removed = []
  let entries
  try {
    entries = readdirSync(generationsDir, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    const path = join(generationsDir, entry.name)
    if (keepSet.has(path)) continue
    const partial = entry.name.startsWith(PARTIAL_PREFIX)
    if (!partial && !isCompleteGeneration(path)) continue
    try {
      removePath(path)
      removed.push(entry.name)
    } catch {
      // Cleanup is opportunistic: a directory that cannot be removed costs disk
      // space, never correctness, so it must not fail the compile.
    }
  }
  return removed
}

/* ------------------------------------------------------------ compilation --- */

/**
 * @typedef {object} CompiledPreset
 * @property {string} id the catalog agent id
 * @property {string} presetId the generated preset directory name
 * @property {string} displayName
 * @property {string} description
 */

/** The preset metadata the roster reads beside a composition. */
function renderPresetMetadata(entry) {
  // JSON strings are valid YAML double-quoted scalars, so this needs no YAML
  // encoder of its own and cannot be tricked by a colon or a leading `-`.
  return `name: ${JSON.stringify(entry.displayName)}\ndescription: ${JSON.stringify(entry.description)}\n`
}

/**
 * @typedef {object} CompilePresetsOptions
 * @property {string} rootDir the plugin's state root (`$DSH_HOME/banbo-agents`)
 * @property {string} templateText the in-package composition template
 * @property {Iterable<object>} definitions merged, validated definitions
 * @property {Set<string>} [builtinPresetIds] preset ids already shipped in the package
 * @property {string} [dshVersion] the target dependency-family version
 * @property {string} [selfVersion] this package's own version
 * @property {object | object[]} [previous] ABI manifest(s) already published
 */

/**
 * @typedef {object} CompilePresetsResult
 * @property {string} generation the generation hash
 * @property {string} generationDir the absolute generation directory
 * @property {boolean} reused whether an existing complete generation was reused
 * @property {string} presetRootDir the directory a roster root must mount
 * @property {object} abi the manifest written into the generation
 */

/**
 * Compile the effective catalog into an activatable generation.
 *
 * @param options - see {@link CompilePresetsOptions}.
 * @returns see {@link CompilePresetsResult}.
 * @throws {CatalogError} when two agents claim one preset id.
 */
export function compilePresets(options) {
  const rootDir = options.rootDir
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('compilePresets requires an absolute rootDir')
  }
  const templateText = options.templateText
  const builtinPresetIds = options.builtinPresetIds ?? new Set()
  const dshVersion = options.dshVersion ?? 'unknown'
  const selfVersion = options.selfVersion ?? '0.0.0'

  /** @type {CompiledPreset[]} */
  const compiled = []
  const claimed = new Map()
  for (const definition of collectDefinitions(options)) {
    if (definition?.main === undefined) continue
    const presetId = definition.main.presetId
    const owner = claimed.get(presetId)
    if (owner !== undefined) {
      throw new CatalogError(
        'duplicate-preset-id',
        `agents "${owner}" and "${definition.id}" both claim preset id "${presetId}"`,
        { field: 'main.presetId' },
      )
    }
    claimed.set(presetId, definition.id)
    if (builtinPresetIds.has(presetId)) continue
    compiled.push({
      id: definition.id,
      presetId,
      displayName: definition.displayName ?? definition.id,
      description: definition.description ?? '',
    })
  }
  compiled.sort(byId)

  const compositions = new Map()
  for (const entry of compiled) {
    compositions.set(entry.presetId, renderComposition(templateText, entry.id))
  }

  // Hash inputs are content only — no host path, no user name — so the same
  // configuration compiles to the same generation on every machine (§8.6).
  const allDefinitions = collectDefinitions(options)
  const agents = computeAbiManifest({
    definitions: allDefinitions,
    previous: options.previous,
    dshVersion,
    selfVersion,
  }).agents
  const generation = `sha256-${sha256(canonical({
    layout: GENERATION_LAYOUT_VERSION,
    dshVersion,
    selfVersion,
    template: sha256(templateText),
    agents,
  }))}`
  const abi = { layout: GENERATION_LAYOUT_VERSION, generation, dshVersion, selfVersion, agents }

  const generationsDir = join(rootDir, GENERATED_ROOT, GENERATIONS_DIR)
  const generationDir = join(generationsDir, generation)
  mkdirSync(generationsDir, { recursive: true, mode: 0o700 })

  const previousGeneration = readCurrentGeneration(rootDir)
  let reused = isCompleteGeneration(generationDir)
  if (!reused && lexists(generationDir)) {
    // A same-named directory WITHOUT our marker is not a generation we built,
    // so it is not trusted. Re-check first: a concurrent Host compiling the
    // same content hash may have completed it since our first look, and a
    // complete generation must never be deleted by a peer (§8.6).
    reused = isCompleteGeneration(generationDir)
    if (!reused) removePath(generationDir)
  }
  if (!reused) {
    buildGeneration({ generationsDir, generation, generationDir, compiled, compositions, abi })
    if (!isCompleteGeneration(generationDir)) {
      throw new Error(`generation ${generation} was written to ${generationDir} without its ${COMPLETE_MARKER} marker`)
    }
  }

  activateGeneration(rootDir, generationDir)
  pruneGenerations(generationsDir, [generationDir, previousGeneration], rootDir)

  return { generation, generationDir, reused, presetRootDir: presetRootDir(rootDir), abi }
}

/** Every definition the caller supplied, in iteration order. */
function collectDefinitions(options) {
  const definitions = options.definitions
  if (definitions === undefined || definitions === null) return []
  if (Array.isArray(definitions)) return definitions
  // A catalog is a `Map<id, definition>`; anything else iterable is spread as
  // values too, so a plain `Set` works without a second code path.
  if (typeof definitions.values === 'function') return [...definitions.values()]
  return [...definitions]
}

/**
 * Write one generation under a partial name, then rename it into place.
 *
 * Two Host processes may compile the same content hash at once. Both stage
 * under a collision-proof name and race one atomic rename; the loser adopts the
 * winner's directory instead of failing, because the name is a hash of the very
 * payload being written, so a completed same-named generation is byte-identical
 * by construction (§8.6).
 */
function buildGeneration(context) {
  const { generationsDir, generation, generationDir, compiled, compositions, abi } = context
  const partial = join(generationsDir, `${PARTIAL_PREFIX}${generation}.${process.pid}.${randomUUID()}`)
  try {
    mkdirSync(join(partial, 'presets'), { recursive: true, mode: 0o700 })
    for (const entry of compiled) {
      const dir = join(partial, 'presets', entry.presetId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'agent.cordis.yml'), compositions.get(entry.presetId), { mode: 0o600 })
      writeFileSync(join(dir, 'preset.yml'), renderPresetMetadata(entry), { mode: 0o600 })
    }
    writeFileSync(join(partial, ABI_MANIFEST), `${JSON.stringify(abi, null, 2)}\n`, { mode: 0o600 })
    // Last, and only once every payload byte is on disk: the marker is what
    // makes the directory activatable at all.
    writeFileSync(
      join(partial, COMPLETE_MARKER),
      `${JSON.stringify({ generation, dshVersion: abi.dshVersion, selfVersion: abi.selfVersion, presets: compiled.length })}\n`,
      { mode: 0o600 },
    )
    try {
      renameSync(partial, generationDir)
    } catch (error) {
      // A peer may have published this exact generation first. Adopting its
      // directory is correct for a content-addressed name; anything else is a
      // real failure and must surface.
      if (!isCompleteGeneration(generationDir)) throw error
    }
  } finally {
    removePath(partial)
  }
}
