/**
 * Catalog composition for `@banbolee/dsh-agents`.
 *
 * Three layers, each with one job:
 *
 *   - {@link mergeDefinition} — the §6.3 constrained override. A user file
 *     patches a built-in definition rather than replacing it, but arrays and
 *     `child.model` replace wholesale, so "inherit some fields" never turns
 *     into "append to a list I did not mean to extend".
 *   - {@link validateGraph} — every rule that needs the whole set in view:
 *     id and tool-name uniqueness, dangling or cyclic `allowedChildren`,
 *     preset-id collisions (including ids the deployment already owns), and
 *     the agent/edge ceilings.
 *   - {@link validateAbi} — §11.2. A published shape is a durable contract for
 *     every continuable child's frozen `toolFilter`, so it may be extended but
 *     never narrowed.
 *
 * {@link loadCatalog} wires them together with the file system and the persona
 * loader, returning one detached, validated view of what this deployment runs.
 *
 * @module @banbolee/dsh-agents/catalog
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  CATALOG_LIMITS,
  CatalogError,
  assertWriteScopeEnforceable,
  deriveToolName,
  parseAgentYaml,
  readAgentYamlSource,
  validateAgentDefinition,
} from './schema.js'
import { loadPersonaSet } from './prompt-loader.js'

/** Preset ids the shipped harness already owns; a catalog may never claim one. */
export const RESERVED_PRESET_IDS = Object.freeze(['standard', 'ptc', 'cordis', 'minimal'])

/** Required fields when an override introduces a form the base does not have. */
const REQUIRED_NEW_FORM_FIELDS = Object.freeze({
  main: ['presetId', 'persona', 'tools', 'maxDepth'],
  child: ['model', 'persona', 'guidance', 'tools', 'continuation'],
})

const fail = (code, message, options) => {
  throw new CatalogError(code, message, options)
}

/* ------------------------------------------------------------ §6.3 merge --- */

/**
 * Apply one user override onto a built-in definition (§6.3).
 *
 * Presence semantics: a field the override omits inherits from the base; a
 * field it names replaces the base value outright. Arrays are replaced, never
 * appended, and `child.model` is replaced as a whole object so a partial route
 * cannot silently inherit half of the built-in's provider/model pair.
 *
 * Because a merge can pair one layer's `writeScope` with the other layer's
 * `tools`, every merged form is re-checked for the shell precondition
 * ({@link assertWriteScopeEnforceable}, §5.2/§16.12): validating each file on
 * its own is not enough when the scope and the shell arrive from different
 * layers.
 *
 * @param base - the built-in definition (not mutated).
 * @param override - the user's parsed definition for the same id.
 * @param options - optional `file` label for the override, so a merge-level
 *   rejection names the layer the user has to edit.
 * @returns a new merged definition.
 * @throws {CatalogError} `id-mismatch`, `incomplete-new-form`, or
 *   `write-scope-with-shell` when the merged form would void its own scope.
 */
export function mergeDefinition(base, override, options = {}) {
  if (override.id !== undefined && override.id !== base.id) {
    fail('id-mismatch', `override declares id "${String(override.id)}" but is merging into "${base.id}"`)
  }

  const merged = { ...base }

  for (const field of ['displayName', 'description']) {
    if (override[field] !== undefined) merged[field] = override[field]
  }
  if (override.allowedChildren !== undefined) merged.allowedChildren = [...override.allowedChildren]

  for (const form of ['main', 'child']) {
    const patch = override[form]
    if (patch === undefined) continue

    if (base[form] === undefined) {
      // Introducing a shape the built-in never had: the override must stand on
      // its own, because there is nothing to inherit and a half-specified form
      // would only be caught much later, at child creation.
      const missing = REQUIRED_NEW_FORM_FIELDS[form].filter((field) => patch[field] === undefined)
      if (missing.length > 0) {
        fail(
          'incomplete-new-form',
          `override adds a \`${form}\` form to "${base.id}" but omits: ${missing.join(', ')}`,
          { field: form },
        )
      }
      merged[form] = structuredClone(patch)
      // Nothing to cancel on a form the built-in never had, but a stray `false`
      // must not reach the compiler as a path value.
      if (merged[form].writeScope === false) delete merged[form].writeScope
      assertWriteScopeEnforceable(merged[form], { path: form, file: options?.file })
      continue
    }

    const next = { ...base[form] }
    // `writeScope: false` is the only way a YAML layer can CANCEL an inherited
    // scope. It must be read from the RAW override, before the generic copy:
    // "absent" and "cancelled" both normalise to a form with no `writeScope` at
    // all, so the merged shape alone cannot tell them apart. `null` — what an
    // accidentally-empty `writeScope:` line parses to — deliberately stays an
    // error, so leaving the value blank can never disable the policy.
    if (patch.writeScope === false) delete next.writeScope
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'writeScope' && value === false) continue
      next[key] = value === undefined ? undefined : structuredClone(value)
      if (value === undefined) delete next[key]
    }
    assertWriteScopeEnforceable(next, { path: form, file: options?.file })
    merged[form] = next
  }

  return merged
}

/* --------------------------------------------------------- graph validation --- */

/**
 * Validate every cross-definition rule.
 *
 * @param definitions - all definitions, built-in and user, already merged.
 * @param options - `reservedPresetIds` the deployment owns.
 * @throws {CatalogError} on the first violation.
 */
export function validateGraph(definitions, options = {}) {
  const reserved = new Set(options.reservedPresetIds ?? RESERVED_PRESET_IDS)

  if (definitions.length > CATALOG_LIMITS.maxAgentCount) {
    fail(
      'limit-exceeded',
      `catalog has ${definitions.length} agents, over the maxAgentCount ceiling of ${CATALOG_LIMITS.maxAgentCount}`,
      { field: 'maxAgentCount' },
    )
  }

  const byId = new Map()
  const byToolName = new Map()
  const byPresetId = new Map()
  let edges = 0

  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      fail('duplicate-id', `agent id "${definition.id}" is declared more than once`, { field: definition.id })
    }
    byId.set(definition.id, definition)

    const toolName = deriveToolName(definition.id)
    if (byToolName.has(toolName)) {
      fail('duplicate-tool-name', `tool name "${toolName}" is produced by both "${byToolName.get(toolName)}" and "${definition.id}"`, { field: toolName })
    }
    byToolName.set(toolName, definition.id)

    if (definition.main !== undefined) {
      const { presetId } = definition.main
      if (reserved.has(presetId)) {
        fail('reserved-preset-id', `preset id "${presetId}" is owned by the deployment and cannot be redefined`, { field: presetId })
      }
      if (byPresetId.has(presetId)) {
        fail('duplicate-preset-id', `preset id "${presetId}" is claimed by both "${byPresetId.get(presetId)}" and "${definition.id}"`, { field: presetId })
      }
      byPresetId.set(presetId, definition.id)
    }
  }

  for (const definition of definitions) {
    edges += definition.allowedChildren.length
    for (const childId of definition.allowedChildren) {
      const target = byId.get(childId)
      if (target === undefined) {
        fail('dangling-child', `agent "${definition.id}" authorises unknown child "${childId}"`, { field: childId })
      }
      if (target.child === undefined) {
        fail('child-without-child-form', `agent "${definition.id}" authorises "${childId}", which has no \`child\` form`, { field: childId })
      }
    }
  }

  if (edges > CATALOG_LIMITS.maxGraphEdges) {
    fail(
      'limit-exceeded',
      `catalog has ${edges} delegation edges, over the maxGraphEdges ceiling of ${CATALOG_LIMITS.maxGraphEdges}`,
      { field: 'maxGraphEdges' },
    )
  }

  assertAcyclic(byId)
}

/**
 * Reject any cycle in the delegation graph.
 *
 * The numeric depth cap would stop runaway recursion on its own, but an A ↔ B
 * pair still produces pointless round trips that are hard to explain to a user,
 * so the graph is required to be a DAG outright.
 */
function assertAcyclic(byId) {
  const state = new Map()
  const stack = []

  const visit = (id) => {
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'open') {
      const start = stack.indexOf(id)
      const path = [...stack.slice(start), id]
      fail('cycle', `delegation graph contains a cycle: ${path.join(' → ')}`, { field: id })
    }
    state.set(id, 'open')
    stack.push(id)
    for (const childId of byId.get(id).allowedChildren) visit(childId)
    stack.pop()
    state.set(id, 'done')
  }

  for (const id of byId.keys()) visit(id)
}

/* ------------------------------------------------------------ §11.2 ABI --- */

/**
 * Protect a previously published ABI shape (§11.2).
 *
 * Every agent whose tool name has been published keeps it, keeps its forms, and
 * keeps its continuation mode, because a frozen child `toolFilter` may name
 * that tool and a resumable child may depend on that mode. Extension is always
 * allowed; narrowing never is.
 *
 * @param definitions - the current, merged definitions.
 * @param previous - the previous generation's ABI manifest, or undefined.
 * @param options - `builtinIds`: the ids the installed package itself supplies.
 * @throws {CatalogError} on the first narrowing change.
 */
export function validateAbi(definitions, previous, options = {}) {
  const published = previous?.agents
  if (!Array.isArray(published) || published.length === 0) return

  const builtinIds = options.builtinIds
  const currentById = new Map(definitions.map((definition) => [definition.id, definition]))

  for (const record of published) {
    const current = currentById.get(record.id)

    if (record.retired === true && current === undefined) {
      // Still retired. The shell is a durable record: it stays in the manifest
      // so historical descriptors keep resolving, and it is never dropped.
      continue
    }

    if (current === undefined) {
      // A user definition file that has gone missing is retired, not rejected:
      // §6.3 makes deleting the file an explicit deletion whose consequence is
      // a `RetiredToolShell`, and the ABI manifest is what carries that shell
      // forward. A package-supplied id is different — nobody
      // can delete a built-in on purpose, so its absence means the install is
      // inconsistent and must not be papered over.
      if (builtinIds?.has(record.id) === true) {
        fail(
          'abi-form-removed',
          `built-in agent "${record.id}" is published but absent from the installed package; reinstall the bundle or restore its catalog file`,
          { field: record.id },
        )
      }
      continue
    }

    // A revived id (its definition file came back) runs the SAME narrowing
    // checks as any other published agent. §12.1 makes restoring the file the
    // documented recovery path, so revival must not fail — but the restored
    // definition may not drop a published form, rename the tool, or switch
    // continuation, because historical descriptors still name those.
    const toolName = deriveToolName(current.id)
    if (record.toolName !== undefined && toolName !== record.toolName) {
      fail('abi-tool-name-changed', `agent "${record.id}" changed its tool name from "${record.toolName}" to "${toolName}"`, { field: record.id })
    }

    if (record.hasMain === true) {
      if (current.main === undefined) {
        fail('abi-form-removed', `agent "${record.id}" dropped its published \`main\` form`, { field: 'main' })
      }
      if (record.presetId !== undefined && current.main.presetId !== record.presetId) {
        fail('abi-preset-id-changed', `agent "${record.id}" changed its preset id from "${record.presetId}" to "${current.main.presetId}"`, { field: record.id })
      }
    }

    if (record.hasChild === true) {
      if (current.child === undefined) {
        fail('abi-form-removed', `agent "${record.id}" dropped its published \`child\` form`, { field: 'child' })
      }
      if (record.childContinuation !== undefined && current.child.continuation !== record.childContinuation) {
        fail(
          'abi-continuation-changed',
          `agent "${record.id}" changed continuation from "${record.childContinuation}" to "${current.child.continuation}"; existing sessions would misread whether their child is resumable`,
          { field: 'child.continuation' },
        )
      }
    }
  }
}

/* --------------------------------------------------------------- loading --- */

/** List `*.yaml` files directly inside a directory, sorted for stable ordering. */
function listYamlFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // An absent directory is an empty layer, not an error: the user agents/
    // directory does not exist until the user authors something.
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/** Load and validate every definition in one directory layer. */
function loadLayer(dir) {
  const loaded = []
  for (const path of listYamlFiles(dir)) {
    const source = readAgentYamlSource(path)
    const raw = parseAgentYaml(source, { file: path })
    loaded.push({ file: path, definition: validateAgentDefinition(raw, { file: path, source }) })
  }
  return loaded
}

/** Enforce the whole-directory byte ceiling before reading its members. */
function assertDirectoryBudget(dir) {
  let total = 0
  for (const path of listYamlFiles(dir)) {
    let size
    try {
      size = statSync(path).size
    } catch {
      continue
    }
    total += size
  }
  if (total > CATALOG_LIMITS.maxAgentsDirBytes) {
    fail(
      'limit-exceeded',
      `${dir} holds ${total} bytes of definitions, over the maxAgentsDirBytes ceiling of ${CATALOG_LIMITS.maxAgentsDirBytes}`,
      { field: 'maxAgentsDirBytes' },
    )
  }
}

/**
 * Load, merge and validate the effective catalog for one deployment.
 *
 * Returns a detached view: nothing in the result aliases a file or a mutable
 * internal, so a later edit on disk cannot change a running Host.
 *
 * Personas resolve through an ordered search path — the user root first, then
 * the package root — so a built-in definition can name a persona that ships in
 * the package while the user still overrides it by placing a file at the same
 * relative path under their own data root (§5.3).
 *
 * @param options - `rootDir` (plugin data root), `builtinDir` (package catalog/),
 *   optional `builtinRootDir`, `reservedPresetIds` and a previous ABI `previous`.
 * @returns `{ definitions, builtinIds, personas, totalPersonaBytes }`.
 * @throws {CatalogError} on the first violation across every layer.
 */
export function loadCatalog(options) {
  const { rootDir, builtinDir } = options
  const agentsDir = join(rootDir, 'agents')
  const builtinAgentsDir = builtinDir ?? null
  const builtinRootDir = options.builtinRootDir ?? (builtinDir === undefined ? undefined : join(builtinDir, '..'))

  if (builtinAgentsDir !== null) assertDirectoryBudget(builtinAgentsDir)
  assertDirectoryBudget(agentsDir)

  const builtin = builtinAgentsDir === null ? [] : loadLayer(builtinAgentsDir)
  const user = loadLayer(agentsDir)

  const byId = new Map(builtin.map(({ definition }) => [definition.id, definition]))
  for (const { definition, file } of user) {
    const base = byId.get(definition.id)
    // The override's own file label travels into the merge so a rejected merged
    // form names the layer the user actually has to edit.
    byId.set(definition.id, base === undefined ? definition : mergeDefinition(base, definition, { file }))
  }

  const definitions = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
  validateGraph(definitions, { reservedPresetIds: options.reservedPresetIds })
  if (options.previous !== undefined) {
    validateAbi(definitions, options.previous, { builtinIds: new Set(builtin.map(({ definition }) => definition.id)) })
  }

  const refs = new Set()
  for (const definition of definitions) {
    if (definition.main !== undefined) refs.add(definition.main.persona)
    if (definition.child !== undefined) refs.add(definition.child.persona)
  }
  const roots = builtinRootDir === undefined ? [rootDir] : [rootDir, builtinRootDir]
  const { personas, totalBytes } = loadPersonaSet(roots, [...refs])

  return {
    definitions: new Map(definitions.map((definition) => [definition.id, definition])),
    builtinIds: new Set(builtin.map(({ definition }) => definition.id)),
    personas,
    totalPersonaBytes: totalBytes,
  }
}

/**
 * Read one generation's ABI manifest JSON.
 *
 * Only a genuinely ABSENT file resolves `undefined`, which is the legitimate
 * "nothing has ever been published" state. A manifest that exists but cannot be
 * read or parsed means the ACTIVE generation is broken; returning `undefined`
 * there would silently disable the published-ABI protection of §11.2 and let a
 * narrowing catalog activate, so it fails loud instead.
 *
 * @param path - absolute path to the generation's `abi.json`.
 * @returns the parsed manifest, or `undefined` when the file does not exist.
 * @throws {CatalogError} `abi-unreadable` or `abi-corrupt`.
 */
export function readAbiManifest(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    fail('abi-unreadable', `cannot read the published ABI manifest: ${String(error?.message ?? error)}`, {
      file: path,
      field: 'abi.json',
    })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail('abi-corrupt', `the published ABI manifest is not valid JSON: ${String(error?.message ?? error)}`, {
      file: path,
      field: 'abi.json',
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('abi-corrupt', 'the published ABI manifest must be a JSON object', { file: path, field: 'abi.json' })
  }
  return parsed
}
