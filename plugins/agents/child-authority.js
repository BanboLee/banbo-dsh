/**
 * The durable record of a delegated child's composition authority —
 * docs/agents-plugin-plan.md §5.2/§11.1.1/§16.12.
 *
 * Why a record and not just the in-memory handoff
 * -----------------------------------------------
 * 0.2.1 removed `persona` and `toolFilter` from `SubagentStartRequest`, and the
 * official manager's `subagent/descriptor` no longer carries either (verified in
 * `@deepseek-ai/dsh-subagent@0.2.1-rc.2`: `snapshotSubagentDescriptor` in the
 * local-child path passes only mode/provider/label/agentOptions). The harness
 * therefore restores a cold continuable child with NEITHER its persona section
 * nor its capability restriction, and a resumed child that had `write`/`edit`
 * would come back with the full preset surface.
 *
 * This bundle must not let that happen: a child's tool surface is its
 * authorization (§5.2), and "the harness forgot" is not an authorization grant.
 *
 * Where it lives
 * --------------
 * The child's OWN Session log, through the public plugin-record API 0.2.1
 * introduced (`appendPluginRecord` / `pluginRecordOf`). That is strictly better
 * than a sidecar file for this fact:
 *
 *   - the record travels with the session through fork, resume and format
 *     migration, so a cold child can always read its own authority;
 *   - it is `ignorable`, so a reader that does not know the type (an older
 *     harness, a different plugin) skips it instead of refusing the log;
 *   - it is written in the child's creation window, where the child's own
 *     context is available — no cross-process sidecar coordination.
 *
 * Fail-closed rules, which are the whole point of this module:
 *
 *   - **absent record → the child is NOT composed by this bundle.** A resumed
 *     child whose record is missing cannot be distinguished from a child that
 *     was never delegated, so no restriction is invented for it. This does not
 *     widen anything: the child is then running whatever the harness restored,
 *     which is the pre-existing behaviour, and a banbo child always writes the
 *     record at creation.
 *   - **malformed record → treated as absent, never as "no restriction".** A
 *     corrupt payload must not be read as "allow everything": the reader
 *     validates every field and returns `undefined` on any deviation, and the
 *     caller then applies the STRICT empty allowlist rather than skipping the
 *     restriction. `emptyComposition()` is what the caller uses in that case.
 *   - **a record whose agent no longer exists → same as malformed.** The
 *     definition is re-read from the current catalog; if it is gone the child is
 *     restricted to nothing rather than left open.
 *
 * @module @banbolee/dsh-agents/child-authority
 */

/** Record type, under this package's own namespace (the 0.2.1 grammar allows `plugin:<lowercase/segments>`). */
export const CHILD_AUTHORITY_RECORD = 'plugin:banbolee.dsh-agents/child-authority'

/** Record format version; a mismatch is treated as an unreadable record. */
export const CHILD_AUTHORITY_VERSION = 1

/**
 * @typedef {object} ChildAuthority
 * @property {number} version record format version
 * @property {string} agentId the AgentDefinition this child runs
 * @property {string} mainAgentId the owning main Agent
 * @property {string} persona the resolved persona text (not a file name)
 * @property {readonly string[]} allow the child's capability allowlist
 */

/**
 * Build the payload written into a child's session log.
 *
 * The payload is a PLAIN object on purpose. The official `appendPluginRecord`
 * snapshots its argument and rejects anything it cannot losslessly re-serialize —
 * and a frozen object (or a frozen array inside one) is exactly that: the
 * snapshot walks the value and refuses it. The record is immutable once committed
 * anyway (`deepFreeze` runs on the stored copy), so the freeze here would add
 * nothing but a failure.
 *
 * @param {object} input `agentId`, `mainAgentId`, `persona`, `toolFilter`.
 * @returns {ChildAuthority} the JSON-serializable payload.
 */
export function childAuthority(input) {
  // Validate BEFORE the record reaches the log. An `undefined` field would make
  // the official serializer reject the whole record with a generic
  // "non-JSON-serializable" error that says nothing about WHICH binding is
  // missing — and `mainAgentId` in particular is the value the resume-time check
  // compares against the sidecar, so it must never be silently absent.
  for (const field of ['agentId', 'mainAgentId']) {
    if (typeof input?.[field] !== 'string' || input[field] === '') {
      throw new Error(
        `banbo-agents: cannot build a child authority record without ${field}; `
        + 'it is the value a cold resume binds this child to, so it must be known at creation time',
      )
    }
  }
  if (typeof input.persona !== 'string') {
    throw new Error('banbo-agents: cannot build a child authority record without a persona string')
  }
  return {
    version: CHILD_AUTHORITY_VERSION,
    agentId: input.agentId,
    mainAgentId: input.mainAgentId,
    persona: input.persona,
    allow: [...input.toolFilter.allow],
  }
}

/**
 * The strict composition a caller applies when a record cannot be trusted.
 *
 * This is deliberately NOT "leave the child alone": an unreadable authority must
 * narrow the child's surface to nothing, because the alternative is a durable
 * child running with whatever tools the harness happened to restore. The persona
 * is empty too — the child keeps its preset prompt and gains no banbo role.
 *
 * @param {string} agentId the definition id this child claimed, for diagnostics.
 * @returns {{ agentId: string, persona: string, toolFilter: { allow: readonly string[] }, untrusted: true }} the strict composition.
 */
export function emptyComposition(agentId) {
  return Object.freeze({
    agentId,
    persona: '',
    toolFilter: Object.freeze({ allow: Object.freeze([]) }),
    untrusted: true,
  })
}

/** Whether a value is a non-empty string. */
const filled = (value) => typeof value === 'string' && value !== ''

/**
 * Validate one persisted payload strictly.
 *
 * Every field is checked: a record that survived a format migration, a hand edit,
 * or an older build of this plugin must either match this version exactly or be
 * rejected. Partial acceptance is how an authorization record becomes an
 * authorization HOLE, so nothing here is lenient.
 *
 * @param {unknown} value the record's `data` as restored.
 * @returns {ChildAuthority | undefined} the validated authority, or `undefined`.
 */
export function parseChildAuthority(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  const keys = Object.keys(record)
  if (keys.length !== 5) return undefined
  for (const key of ['version', 'agentId', 'mainAgentId', 'persona', 'allow']) {
    if (!keys.includes(key)) return undefined
  }
  if (record.version !== CHILD_AUTHORITY_VERSION) return undefined
  if (!filled(record.agentId) || !filled(record.mainAgentId)) return undefined
  if (typeof record.persona !== 'string') return undefined
  if (!Array.isArray(record.allow)) return undefined
  const allow = record.allow
  if (allow.length === 0) return undefined
  for (const name of allow) {
    if (!filled(name)) return undefined
  }
  if (new Set(allow).size !== allow.length) return undefined
  return Object.freeze({
    version: CHILD_AUTHORITY_VERSION,
    agentId: record.agentId,
    mainAgentId: record.mainAgentId,
    persona: record.persona,
    allow: Object.freeze([...allow]),
  })
}

/**
 * Append one child's authority to its own session log.
 *
 * A failure here is NOT swallowed. The record is the only durable copy of the
 * child's authorization, so a child that starts without it would come back from a
 * cold resume with the harness-restored surface — the exact widening this module
 * exists to prevent. Throwing vetoes the child's publication (the `agent/created`
 * listener runs before the child's first model request), which is the fail-closed
 * direction.
 *
 * @param {object} session the child's Session (has `appendPluginRecord` via the module function).
 * @param {ChildAuthority} authority the payload to persist.
 * @param {Function} appendPluginRecord the official `appendPluginRecord` from `@deepseek-ai/dsh-session`.
 * @throws {Error} when the record cannot be committed.
 */
export function writeChildAuthority(session, authority, appendPluginRecord) {
  try {
    appendPluginRecord(session, CHILD_AUTHORITY_RECORD, authority)
  } catch (error) {
    throw new Error(
      `banbo-agents: cannot persist the composition authority of child "${String(session?.id)}" `
      + `(${String(error?.message ?? error)}); refusing to publish a child whose authorization would not survive a cold resume`,
    )
  }
}

/**
 * Read one child's authority from its own session log.
 *
 * `state` distinguishes the three outcomes the caller must treat differently:
 *
 *   - `absent` — no record of this type. Either a child that was never delegated
 *     by this bundle, or a log written before this record existed. The caller
 *     decides, using the sidecar identity as the independent "is this a banbo
 *     child" signal;
 *   - `invalid` — a record of this type exists but does not validate. The caller
 *     MUST apply {@link emptyComposition} rather than skipping the restriction;
 *   - `valid` — the authority to re-apply.
 *
 * @param {object} session the child's Session (`snapshotEvents()`).
 * @param {Function} pluginRecordOf the official `pluginRecordOf` from `@deepseek-ai/dsh-session`.
 * @returns {{ state: 'absent' | 'invalid' | 'valid', authority?: ChildAuthority }} the read result.
 */
export function readChildAuthority(session, pluginRecordOf) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    // An unreadable log is not "no record": the caller must fail closed.
    return { state: 'invalid' }
  }
  for (const event of events) {
    let record
    try {
      record = pluginRecordOf(event)
    } catch {
      continue
    }
    if (record === undefined || record.type !== CHILD_AUTHORITY_RECORD) continue
    const authority = parseChildAuthority(record.data)
    return authority === undefined ? { state: 'invalid' } : { state: 'valid', authority }
  }
  return { state: 'absent' }
}
