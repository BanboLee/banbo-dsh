/**
 * Agent definition schema, YAML parsing boundary, and catalog ceilings for
 * `@banbolee/dsh-agents`.
 *
 * This module is pure: it reads bytes and returns validated, detached values.
 * It performs no I/O beyond the two explicit file helpers, holds no state, and
 * knows nothing about Cordis, DSH services, or the runtime.
 *
 * @module @banbolee/dsh-agents/schema
 */

import { readFileSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { parseDocument } from 'yaml'

/* ------------------------------------------------------------- typedefs --- */

/**
 * One main-agent form: the preset it mounts, its persona, its ordinary tool
 * surface, the absolute depth cap for the whole tree below it, the optional
 * path scope for its write/edit tools, and the per-root-session budget.
 * @typedef {object} MainProfile
 * @property {string} presetId
 * @property {string} persona
 * @property {string[]} tools
 * @property {string[]} [extraTools]
 * @property {string|false} [writeScope] relative directory `write`/`edit` are confined to; `false` cancels an inherited scope
 * @property {number} maxDepth
 * @property {Record<string, number>} budget
 */

/**
 * One child-agent form: the route used only when delegated to, its persona and
 * usage guidance, its allowlist, the optional path scope for its write/edit
 * tools, and whether it may keep a resumable session.
 * @typedef {object} ChildProfile
 * @property {{ default?: true, provider?: string, model?: string, reasoningEffort?: string }} model
 * @property {string} persona
 * @property {string} guidance
 * @property {string[]} tools
 * @property {string[]} [extraTools]
 * @property {string|false} [writeScope] relative directory `write`/`edit` are confined to; `false` cancels an inherited scope
 * @property {'one-shot' | 'optional'} continuation
 */

/**
 * One validated agent definition. A form's presence is what makes that running
 * shape legal; there is deliberately no separate `identity` field.
 * @typedef {object} AgentDefinition
 * @property {string} id
 * @property {string} displayName
 * @property {string} description
 * @property {string[]} allowedChildren
 * @property {MainProfile} [main]
 * @property {ChildProfile} [child]
 */

/* ------------------------------------------------------------- ceilings --- */

/**
 * Resource ceilings (docs/agents-plugin-plan.md §4.4.1).
 *
 * These are separate from the semantic rules in §4.4 on purpose: a catalog can
 * be semantically perfect and still be large enough to stall Host startup. Each
 * number is derived in the plan; changing one requires re-deriving it there
 * rather than tuning it here.
 */
export const CATALOG_LIMITS = Object.freeze({
  maxAgentCount: 128,
  maxYamlBytes: 256 * 1024,
  maxAgentsDirBytes: 4 * 1024 * 1024,
  maxPersonaTotalBytes: 1024 * 1024,
  maxAllowedChildren: 64,
  maxExtraTools: 64,
  maxGraphEdges: 1024,
  maxDisplayNameBytes: 128,
  maxDescriptionBytes: 512,
  maxGuidanceBytes: 2048,
})

/** The closed set of ordinary tool capabilities a definition may request. */
export const TOOL_CAPABILITIES = Object.freeze([
  'read', 'search', 'web', 'exec', 'write', 'edit', 'skill',
  'todo', 'jobs', 'ask-user', 'goal', 'present', 'agent-control',
])

/**
 * The concrete shell tool names the `exec` capability can grant, in §5.2's
 * preference order (fish first, else bash, else pwsh).
 *
 * It lives here, next to the validation that needs it, because the `writeScope`
 * precondition below must know what a shell IS; `tool-surface.js` builds its
 * `exec` surface from this same array, so the granted surface and the
 * precondition check can never drift apart.
 */
export const SHELL_TOOL_NAMES = Object.freeze(['fish', 'bash', 'pwsh'])

/**
 * The single shared denylist of official general-purpose delegation entry
 * points (§5.2). The catalog validator, the preset template, and `extraTools`
 * validation all read this one array — a second copy anywhere is a defect.
 */
export const FORBIDDEN_DELEGATION_TOOLS = Object.freeze([
  'subagent', 'subagent_fork', 'workflow', 'ralph',
])

/** Names that may never appear in `extraTools` regardless of the denylist. */
const RESERVED_EXTRA_TOOLS = Object.freeze(['run_code', 'delegate_batch'])

/** Per-field budget defaults, clamps and integer bounds (§4.4 rule 6). */
const BUDGET_FIELDS = Object.freeze({
  maxConcurrentChildren: { min: 1, max: 32, default: 6 },
  maxBatchWidth: { min: 1, max: 6, default: 4 },
  // 30 minutes, raised from 15 after a real session: a full-file review of a
  // 1184-line module (plus its spec and supporting modules) ran the 15-minute
  // foreground deadline to exhaustion with NO output at all — the child was
  // still reading and had not written a word — so the whole run was wasted and
  // had to be redone in the background. The background deadline was already 30
  // minutes, so the foreground path gets the same room for the shipped `review`
  // agent's normal workload.
  foregroundDeadlineMs: { min: 60_000, max: 3_600_000, default: 1_800_000 },
  backgroundDeadlineMs: { min: 60_000, max: 7_200_000, default: 1_800_000 },
  batchDeadlineMs: { min: 60_000, max: 1_800_000, default: 600_000 },
  drainGraceMs: { min: 1_000, max: 300_000, default: 30_000 },
})

/** Recognised keys per object level; anything else is a hard error (§6.1.1). */
const KNOWN_KEYS = Object.freeze({
  '': ['id', 'displayName', 'description', 'allowedChildren', 'main', 'child'],
  main: ['presetId', 'persona', 'tools', 'extraTools', 'writeScope', 'maxDepth', 'budget'],
  child: ['model', 'persona', 'guidance', 'tools', 'extraTools', 'writeScope', 'continuation'],
  model: ['default', 'provider', 'model', 'reasoningEffort'],
  budget: Object.keys(BUDGET_FIELDS),
})

const ID_PATTERN = /^[a-z][a-z0-9-]{0,57}$/

/**
 * The one agent-id grammar, exported so callers that must reject an id before
 * a definition exists (the preset compiler, the delegation tool-name mapper)
 * validate against the same expression instead of a second, drifting copy.
 * It is deliberately a strict subset of the roster's own `PRESET_ID`
 * (`/^[a-z0-9][a-z0-9-]*$/`), so every valid agent id is also a usable preset
 * directory name.
 */
export const AGENT_ID_PATTERN = ID_PATTERN

/* ----------------------------------------------------------------- error --- */

/**
 * One catalog failure, carrying the machine code, source location and the
 * field path a user needs to fix it. Every rejection in this module is one of
 * these — never a bare `Error`, and never a silent truncation.
 */
export class CatalogError extends Error {
  /**
   * @param code - stable machine code (`unknown-field`, `limit-exceeded`, …).
   * @param message - human-facing description; must name the offending value.
   * @param options - source location and offending field path.
   */
  constructor(code, message, options = {}) {
    const where = options.file === undefined ? '' : `${options.file}${options.line === undefined ? '' : `:${options.line}`}`
    super(where === '' ? message : `${where}: ${message}`)
    this.name = 'CatalogError'
    this.code = code
    this.file = options.file
    this.line = options.line
    this.field = options.field
  }
}

const fail = (code, message, options) => {
  throw new CatalogError(code, message, options)
}

/* -------------------------------------------------------------- helpers --- */

/** Byte length of one UTF-8 string, the unit every text ceiling is stated in. */
const byteLength = (value) => Buffer.byteLength(value, 'utf8')

/** Whether a value is a plain record (not an array, not null). */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Derive the stable model-facing tool name for one agent id (§4.4 rule 2).
 * Underscores are illegal in an id, so mapping `-` to `_` is injective and two
 * ids can never encode to the same tool name.
 * @param id - the validated agent id.
 * @returns the `agent_<id>` tool name.
 */
export function deriveToolName(id) {
  return `agent_${id.replaceAll('-', '_')}`
}

/** Locate the source line of a top-level key inside a YAML document. */
function lineOfKey(source, key) {
  const lines = source.split('\n')
  const pattern = new RegExp(`^\\s*('?"?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?"?)\\s*:`)
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1
  }
  return undefined
}

/**
 * Find the first `<<` merge key anywhere in a parsed document.
 *
 * `merge: false` (the YAML 1.2 default) makes `<<` an ordinary key rather than
 * performing a merge, so it survives parsing and is caught here — which is what
 * lets the error name the construct the user actually wrote instead of
 * reporting a generic unknown field next to a working `*alias`.
 */
function findMergeKey(value, path = '') {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findMergeKey(entry, path)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const [key, entry] of Object.entries(value)) {
    const here = path === '' ? key : `${path}.${key}`
    if (key === '<<') return here
    const found = findMergeKey(entry, here)
    if (found !== undefined) return found
  }
  return undefined
}

/* ----------------------------------------------------------- YAML parse --- */

/**
 * Parse one agent YAML document under the §6.1.1 boundary.
 *
 * The options are a security boundary, not style: YAML 1.2 core scalars only,
 * no merge keys, duplicate keys rejected, alias expansion bounded, and no
 * custom or YAML 1.1 tags. A parsed value is therefore always JSON-shaped.
 *
 * @param source - the file's decoded text.
 * @param options - `file` for diagnostics; `source` text for line lookup.
 * @returns the parsed plain value.
 * @throws {CatalogError} `yaml-parse`, `duplicate-key` or `unsupported-merge-key`.
 */
export function parseAgentYaml(source, options = {}) {
  const file = options?.file
  const doc = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    maxAliasCount: 100,
    customTags: [],
    resolveKnownTags: false,
  })

  const syntaxError = doc.errors[0]
  if (syntaxError !== undefined) {
    const line = syntaxError.linePos?.[0]?.line
    const duplicate = syntaxError.code === 'DUPLICATE_KEY'
    fail(duplicate ? 'duplicate-key' : 'yaml-parse', String(syntaxError.message), { file, line })
  }

  // An explicit tag the core schema does not resolve (`!!js/function`,
  // `!!timestamp`, `!!binary`, …) is only a WARNING in this library: the value
  // silently degrades to a plain string. The value is therefore never executed
  // and never becomes a non-JSON scalar — but a silent no-op is exactly the
  // failure mode §6.1.1 exists to prevent, so it is promoted to an error here.
  const unresolved = doc.warnings.find((warning) => warning.code === 'TAG_RESOLVE_FAILED')
  if (unresolved !== undefined) {
    const line = unresolved.linePos?.[0]?.line
    const tag = /tag:yaml\.org,2002:([^\s]+)/.exec(String(unresolved.message))?.[1]
    fail(
      'unsupported-tag',
      `unsupported YAML tag${tag === undefined ? '' : ` "!!${tag}"`}; only YAML 1.2 core scalars are accepted`,
      { file, line },
    )
  }

  // `toJS` is where alias expansion actually happens, and where the
  // `maxAliasCount` budget is enforced: the library throws a bare
  // ReferenceError from inside the resolver rather than recording a document
  // error, so it is translated here into a catalog failure.
  let value
  try {
    value = doc.toJS()
  } catch (error) {
    fail(
      'yaml-parse',
      `alias expansion refused: ${String(error?.message ?? error)} (maxAliasCount ${100})`,
      { file },
    )
  }

  const mergePath = findMergeKey(value)
  if (mergePath !== undefined) {
    const key = mergePath.split('.').pop()
    fail(
      'unsupported-merge-key',
      `不支持 YAML 合并键 \`<<\`（${mergePath}）；修复：把要复用的字段直接写全，或用 \`*别名\` 做取值复用`,
      { file, line: lineOfKey(source, key === '<<' ? '<<' : key), field: mergePath },
    )
  }

  if (value === null || value === undefined) {
    fail('empty-document', 'agent definition is empty', { file })
  }
  return value
}

/**
 * Read and parse one agent YAML file, checking its size BEFORE parsing.
 *
 * The order is load-bearing (§4.4.1): parsing first would expose the parser
 * itself as the attack surface the byte ceiling exists to remove.
 *
 * @param path - absolute path to the YAML file.
 * @param options - `file` label for diagnostics (defaults to `path`).
 * @returns the parsed plain value.
 * @throws {CatalogError} `unreadable-file` or `limit-exceeded` before parsing.
 */
export function loadAgentYamlFile(path, options = {}) {
  const file = options?.file ?? path
  return parseAgentYaml(readAgentYamlSource(path, { file }), { file })
}

/**
 * Read one agent YAML file as text, checking its size BEFORE the read.
 *
 * Split out from {@link loadAgentYamlFile} because definition validation wants
 * the raw text too — it derives line numbers from it for diagnostics.
 *
 * @param path - absolute path to the YAML file.
 * @param options - `file` label for diagnostics (defaults to `path`).
 * @returns the decoded UTF-8 source.
 * @throws {CatalogError} `unreadable-file` or `limit-exceeded`.
 */
export function readAgentYamlSource(path, options = {}) {
  const file = options?.file ?? path
  let size
  try {
    size = statSync(path).size
  } catch (error) {
    fail('unreadable-file', `cannot read agent definition: ${String(error?.message ?? error)}`, { file })
  }
  if (size > CATALOG_LIMITS.maxYamlBytes) {
    fail(
      'limit-exceeded',
      `file is ${size} bytes, over the maxYamlBytes ceiling of ${CATALOG_LIMITS.maxYamlBytes}`,
      { file, field: 'maxYamlBytes' },
    )
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail('unreadable-file', `cannot read agent definition: ${String(error?.message ?? error)}`, { file })
  }
}
/* ------------------------------------------------------ field validation --- */

/**
 * Reject unknown keys at one object level, with `<<` reported specially.
 *
 * `source` is optional and used only to attach a line number: the lookup takes
 * the first `key:` occurrence in the document, which is exact for top-level
 * keys and a best-effort hint for nested ones. Diagnostics are worth that.
 */
function assertKnownKeys(value, level, ctx) {
  if (!isRecord(value)) return
  const known = KNOWN_KEYS[level]
  for (const key of Object.keys(value)) {
    const path = level === '' ? key : `${level}.${key}`
    const line = ctx.source === undefined ? undefined : lineOfKey(ctx.source, key)
    if (key === '<<') {
      fail('unsupported-merge-key', `不支持 YAML 合并键 \`<<\`（${path}）`, { file: ctx.file, line, field: path })
    }
    if (!known.includes(key)) {
      fail('unknown-field', `unknown field "${key}"`, { file: ctx.file, line, field: path })
    }
  }
}

/** Reject `null` anywhere: it is not an implicit delete (§6.3). */
function assertNoNulls(value, path, file) {
  if (value === null) fail('null-not-allowed', `null is not an implicit delete (at ${path})`, { file, field: path })
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNulls(entry, `${path}[${index}]`, file))
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) assertNoNulls(entry, path === '' ? key : `${path}.${key}`, file)
  }
}

/** Require a non-empty string, reporting the field path on failure. */
function requireString(value, field, file) {
  if (typeof value !== 'string' || value === '') {
    fail('missing-field', `${field} must be a non-empty string`, { file, field })
  }
  return value
}

/** Enforce one UTF-8 byte ceiling on an optional string field. */
function checkBytes(value, field, limitName, file) {
  if (typeof value !== 'string') return
  const limit = CATALOG_LIMITS[limitName]
  if (byteLength(value) > limit) {
    fail('limit-exceeded', `${field} is ${byteLength(value)} bytes, over the ${limitName} ceiling of ${limit}`, { file, field: limitName })
  }
}

/** Validate `tools` / `extraTools` for one form. */
function validateTools(form, path, file) {
  const tools = form.tools
  if (!Array.isArray(tools)) fail('missing-field', `${path}.tools must be an array`, { file, field: `${path}.tools` })
  tools.forEach((capability, index) => {
    if (!TOOL_CAPABILITIES.includes(capability)) {
      fail(
        'unknown-tool-capability',
        `unknown tool capability "${String(capability)}"; known: ${TOOL_CAPABILITIES.join(', ')}`,
        { file, field: `${path}.tools[${index}]` },
      )
    }
  })

  const extra = form.extraTools
  if (extra === undefined) return
  if (!Array.isArray(extra)) fail('missing-field', `${path}.extraTools must be an array`, { file, field: `${path}.extraTools` })
  if (extra.length > CATALOG_LIMITS.maxExtraTools) {
    fail('limit-exceeded', `${path}.extraTools has ${extra.length} entries, over maxExtraTools ${CATALOG_LIMITS.maxExtraTools}`, { file, field: 'maxExtraTools' })
  }
  extra.forEach((name, index) => {
    if (typeof name !== 'string' || name === '') {
      fail('missing-field', `${path}.extraTools[${index}] must be a non-empty string`, { file, field: `${path}.extraTools[${index}]` })
    }
    if (FORBIDDEN_DELEGATION_TOOLS.includes(name)) {
      fail('forbidden-extra-tool', `extraTools may not grant the official delegation entry point "${name}"`, { file, field: `${path}.extraTools[${index}]` })
    }
    if (RESERVED_EXTRA_TOOLS.includes(name) || name.startsWith('agent_')) {
      fail('reserved-extra-tool', `"${name}" is a reserved or derived tool name and cannot be granted via extraTools`, { file, field: `${path}.extraTools[${index}]` })
    }
  })
}

/**
 * Validate one optional `writeScope` and return its canonical relative form.
 *
 * The field confines the `write` / `edit` tools of ONE mounted form to one
 * directory under the session workspace (docs/agents-plugin-plan.md §5.2,
 * §16.12). Validation is deliberately fail-closed and lexical: this module has
 * no workspace and no filesystem, so it can only prove the declared value is a
 * plain relative path. Containment against the live workspace — including the
 * symlink defence — belongs to `path-policy.js`, which runs at execution time.
 *
 * Rejected here: a non-string or empty value, a NUL byte, any backslash (a
 * Windows separator would make the POSIX resolution in `path-policy.js`
 * disagree with the filesystem), a POSIX or Windows absolute path, and any
 * value whose normalised form is empty, `.`, or escapes upward through `..`.
 *
 * Presence is decided by the call sites, which omit the field entirely when it
 * is absent — that is why there is deliberately no `undefined` early return
 * here: silently mapping an unexpected `undefined` to "no scope" would disable
 * the policy instead of failing closed.
 *
 * `false` is the one accepted non-path value: it CANCELS a scope the layer would
 * otherwise inherit. It is spelled `false` rather than `null` on purpose —
 * `null` is what an accidentally-empty `writeScope:` line parses to, and leaving
 * the value blank must never silently disable the policy.
 *
 * @param value - the raw `main.writeScope` / `child.writeScope`.
 * @param field - the field path for diagnostics (`main.writeScope`, …).
 * @param file - the source file label for diagnostics.
 * @returns the canonical relative path, or `false` for an explicit cancel.
 * @throws {CatalogError} `missing-field` or `bad-write-scope`.
 */
function validateWriteScope(value, field, file) {
  if (value === false) return false
  if (typeof value !== 'string' || value === '') {
    fail('missing-field', `${field} must be a non-empty string, or false to cancel an inherited scope`, { file, field })
  }
  const reject = (reason) => fail('bad-write-scope', `${field} ${reason} (got ${JSON.stringify(value)})`, { file, field })
  if (value.includes('\0')) reject('must not contain a NUL byte')
  if (value.includes('\\')) reject('must use "/" separators, not "\\"')
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) reject('must be a relative path, not an absolute one')
  const normalised = posix.normalize(value).replace(/\/+$/, '')
  if (normalised === '' || normalised === '.') reject('must name a directory below the workspace root')
  if (normalised === '..' || normalised.startsWith('../')) reject('must not escape the workspace root with ".."')
  return normalised
}

/**
 * The `writeScope` field to spread into a normalised form.
 *
 * A cancel is carried through normalisation as `false` rather than dropped,
 * because the merge is the thing that must honour it and `loadCatalog` validates
 * each layer BEFORE merging — dropping it here would erase the user's intent
 * before anything could act on it. Everything downstream treats `false` as "no
 * policy": the guard ignores a non-string scope, and both registration sites
 * test for a usable path rather than mere presence.
 *
 * @param value - the raw field.
 * @param field - the dotted field name used in errors.
 * @param file - the definition file, when known.
 * @returns `{}` when the field is absent, else `{ writeScope }`.
 */
function writeScopeField(value, field, file) {
  if (value === undefined) return {}
  return { writeScope: validateWriteScope(value, field, file) }
}

/**
 * Whether a form actually confines its writes.
 *
 * The single predicate both registration sites use, so "declares a scope",
 * "declares a cancel" and "declares nothing" cannot drift apart between them.
 *
 * @param form - a `MainProfile` / `ChildProfile`, or anything shaped like one.
 * @returns true only for a usable relative directory.
 */
export function hasWriteScope(form) {
  const scope = form?.writeScope
  return typeof scope === 'string' && scope !== ''
}

/**
 * Reject a form whose own `writeScope` a shell would silently void.
 *
 * `writeScope` is enforced by `path-policy.js` on the `write` / `edit` TOOL
 * CALLS, so it is sound only while the form has no shell: `echo x > /etc/y`
 * never calls `write`, and no tool-surface guard can see it. The combination is
 * therefore a hard startup error rather than a documented warning, and it is
 * judged on the RESOLVED tool surface — a user override may add the shell while
 * the built-in definition carries the scope, which is why `mergeDefinition`
 * re-checks the form it produced instead of trusting either layer alone.
 *
 * Two shapes can grant a shell: the `exec` capability in `tools` (the only
 * shell reachable through the closed `TOOL_CAPABILITIES` set, whose concrete
 * names `resolveCapability` picks from {@link SHELL_TOOL_NAMES}), and a
 * concrete shell name in `extraTools`, which `compileAllowlist` grants verbatim
 * once the live registry has it.
 *
 * @param form - a raw or merged `main` / `child` form.
 * @param options - `path` (`main` / `child`) and `file` for diagnostics.
 * @throws {CatalogError} `write-scope-with-shell`.
 */
export function assertWriteScopeEnforceable(form, options = {}) {
  // The same predicate both registration sites use, so "declares a scope",
  // "declares a cancel" and "declares nothing" cannot be judged differently here
  // than they are at the guard.
  if (!hasWriteScope(form)) return
  const path = options?.path === undefined || options.path === '' ? '' : `${options.path}.`
  const reason = 'a shell can write anywhere without calling "write" or "edit"'
  if (Array.isArray(form.tools) && form.tools.includes('exec')) {
    fail(
      'write-scope-with-shell',
      `banbo-agents: ${path}writeScope is unenforceable while ${path}tools grants the shell capability "exec"; ${reason}`,
      { file: options?.file, field: `${path}tools` },
    )
  }
  const shell = (Array.isArray(form.extraTools) ? form.extraTools : []).find((name) => SHELL_TOOL_NAMES.includes(name))
  if (shell !== undefined) {
    fail(
      'write-scope-with-shell',
      `banbo-agents: ${path}writeScope is unenforceable while ${path}extraTools grants the shell tool ${JSON.stringify(shell)}; ${reason}`,
      { file: options?.file, field: `${path}extraTools` },
    )
  }
}

/** Validate a `model` object: either the inherit sentinel or a whole route. */
function validateModel(model, path, file) {
  if (!isRecord(model)) fail('bad-model', `${path} must be an object`, { file, field: path })
  if (model.default === true) {
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      if (model[key] !== undefined) {
        fail('bad-model', `${path} cannot combine \`default: true\` with "${key}"`, { file, field: `${path}.${key}` })
      }
    }
    return { default: true }
  }
  if (model.default !== undefined) {
    fail('bad-model', `${path}.default must be exactly \`true\` when present`, { file, field: `${path}.default` })
  }
  if (typeof model.provider !== 'string' || model.provider === '') {
    fail('bad-model', `${path} must give a non-empty provider alongside model`, { file, field: `${path}.provider` })
  }
  if (typeof model.model !== 'string' || model.model === '') {
    fail('bad-model', `${path} must give a non-empty model alongside provider`, { file, field: `${path}.model` })
  }
  const resolved = { provider: model.provider, model: model.model }
  if (model.reasoningEffort !== undefined) {
    if (typeof model.reasoningEffort !== 'string' || model.reasoningEffort === '') {
      fail('bad-model', `${path}.reasoningEffort must be a non-empty string when present`, { file, field: `${path}.reasoningEffort` })
    }
    resolved.reasoningEffort = model.reasoningEffort
  }
  return resolved
}

/**
 * Resolve one form's `budget` against the documented defaults and clamps.
 *
 * Every value must be a safe integer inside its field's inclusive range; the
 * `maxConcurrentChildren` ceiling exists for guard fidelity (a width budget of
 * 10000 is no guard at all), not for performance.
 *
 * @param budget - the optional partial budget object.
 * @param ctx - file/source context, so an unknown key reports its own line.
 * @returns the fully resolved budget.
 * @throws {CatalogError} `bad-budget` or `unknown-field` naming the offending field.
 */
export function validateBudget(budget, ctx = {}) {
  if (budget !== undefined && !isRecord(budget)) {
    fail('bad-budget', `budget must be a mapping of known fields, got ${Array.isArray(budget) ? 'an array' : typeof budget}`, {
      file: ctx.file,
      field: 'main.budget',
    })
  }
  // A misspelled budget field must never fall back to the default: this object
  // exists to cap concurrency and bound every delegation, so silently keeping
  // `maxConcurrentChildren: 6` while the user believes they raised it removes
  // the guard without saying so (§6.1.1, §13).
  assertKnownKeys(budget, 'budget', ctx)

  /** @type {Record<string, number>} */
  const resolved = {}
  for (const [field, spec] of Object.entries(BUDGET_FIELDS)) {
    const value = budget?.[field]
    if (value === undefined) {
      resolved[field] = spec.default
      continue
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
      fail('bad-budget', `${field} must be a safe integer in [${spec.min}, ${spec.max}], got ${String(value)}`, { file: ctx.file, field })
    }
    resolved[field] = value
  }
  return resolved
}

/* ------------------------------------------------------ definition check --- */

/**
 * Validate one parsed definition and return a normalised, detached copy.
 *
 * Only the semantic rules that apply to a SINGLE definition live here; the
 * cross-definition rules (graph, id/tool-name collisions, preset-id
 * uniqueness, the agent-count and edge ceilings) belong to the catalog
 * validator, which is the only place that can see every definition at once.
 *
 * @param raw - the parsed YAML value.
 * @param options - `file` and (optionally) the raw `source` text for line hints.
 * @returns the normalised definition.
 * @throws {CatalogError} on the first violation.
 */
export function validateAgentDefinition(raw, options = {}) {
  const file = options?.file
  const ctx = { file, source: options?.source }
  if (!isRecord(raw)) fail('bad-definition', 'agent definition must be a mapping', { file })

  assertKnownKeys(raw, '', ctx)
  assertNoNulls(raw, '', file)

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    fail('bad-id', `id must match ${ID_PATTERN} (got ${JSON.stringify(raw.id)})`, { file, field: 'id' })
  }
  const id = raw.id
  const displayName = requireString(raw.displayName, 'displayName', file)
  const description = requireString(raw.description, 'description', file)
  checkBytes(displayName, 'displayName', 'maxDisplayNameBytes', file)
  checkBytes(description, 'description', 'maxDescriptionBytes', file)

  if (raw.main === undefined && raw.child === undefined) {
    fail('missing-form', `agent "${id}" must declare at least one of \`main\` / \`child\``, { file, field: 'main' })
  }

  if (raw.allowedChildren !== undefined && !Array.isArray(raw.allowedChildren)) {
    fail('missing-field', 'allowedChildren must be an array', { file, field: 'allowedChildren' })
  }
  const allowedChildren = raw.allowedChildren ?? []
  if (allowedChildren.length > CATALOG_LIMITS.maxAllowedChildren) {
    fail('limit-exceeded', `allowedChildren has ${allowedChildren.length} entries, over maxAllowedChildren ${CATALOG_LIMITS.maxAllowedChildren}`, { file, field: 'maxAllowedChildren' })
  }
  allowedChildren.forEach((child, index) => {
    if (typeof child !== 'string' || !ID_PATTERN.test(child)) {
      fail('bad-child-ref', `allowedChildren[${index}] must be a valid agent id`, { file, field: `allowedChildren[${index}]` })
    }
  })

  /** @type {AgentDefinition} */
  const definition = { id, displayName, description, allowedChildren: [...allowedChildren] }

  if (raw.main !== undefined) {
    const main = raw.main
    assertKnownKeys(main, 'main', ctx)
    const presetId = requireString(main.presetId, 'main.presetId', file)
    if (!ID_PATTERN.test(presetId)) {
      fail('bad-id', `main.presetId must match ${ID_PATTERN}`, { file, field: 'main.presetId' })
    }
    const persona = requireString(main.persona, 'main.persona', file)
    const maxDepth = main.maxDepth
    if (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      fail('bad-depth', `main.maxDepth must be a non-negative safe integer, got ${String(maxDepth)}`, { file, field: 'main.maxDepth' })
    }
    validateTools(main, 'main', file)
    assertWriteScopeEnforceable(main, { path: 'main', file })
    definition.main = {
      presetId,
      persona,
      tools: [...main.tools],
      ...main.extraTools === undefined ? {} : { extraTools: [...main.extraTools] },
      // A cancel (`false`) normalises to "no field at all", which is what the
      // guard and `assertWriteScopeEnforceable` both read as "unrestricted".
      // The merge consults the RAW override before this point, so it can still
      // tell a cancel from an inheritance.
      ...writeScopeField(main.writeScope, 'main.writeScope', file),
      maxDepth,
      budget: validateBudget(main.budget, ctx),
    }
  }

  if (raw.child !== undefined) {
    const child = raw.child
    assertKnownKeys(child, 'child', ctx)
    const persona = requireString(child.persona, 'child.persona', file)
    const guidance = requireString(child.guidance, 'child.guidance', file)
    checkBytes(guidance, 'child.guidance', 'maxGuidanceBytes', file)
    if (child.continuation !== 'one-shot' && child.continuation !== 'optional') {
      fail('bad-continuation', `child.continuation must be "one-shot" or "optional", got ${JSON.stringify(child.continuation)}`, { file, field: 'child.continuation' })
    }
    assertKnownKeys(child.model, 'model', ctx)
    validateTools(child, 'child', file)
    assertWriteScopeEnforceable(child, { path: 'child', file })
    definition.child = {
      model: validateModel(child.model, 'child.model', file),
      persona,
      guidance,
      tools: [...child.tools],
      ...child.extraTools === undefined ? {} : { extraTools: [...child.extraTools] },
      ...writeScopeField(child.writeScope, 'child.writeScope', file),
      continuation: child.continuation,
    }
  }

  return definition
}
