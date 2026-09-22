/**
 * Plugin-side child identity store for `@banbolee/dsh-agents`.
 *
 * A continuable child's business identity (which AgentDefinition it is, and
 * which root session owns it) cannot live in the Session log: `Session.append`
 * offers no way to mark a plugin-authored event type `ignorable`, and
 * persistence refuses to interpret a log containing an unmarked unknown type
 * (see `tests/gates/gate-a-target.spec.ts` probe A4). It therefore lives in a
 * sidecar: one immutable file per child under `<dshHome>/banbo-agents/.children/`.
 *
 * Design constraints, each of which shapes the code below:
 *   - **No locks, no read-modify-write.** A child id is reserved before the
 *     child exists, so every write targets a fresh file. Two processes creating
 *     children concurrently touch different paths and cannot conflict.
 *   - **Atomic visibility.** A reader must never observe a half-written record,
 *     so content lands in a sibling temp file and is renamed into place.
 *   - **Reads never throw.** Missing, unreadable, corrupt, future-versioned, or
 *     unexpected content all resolve to `undefined` — the fail-closed "identity
 *     unknown" outcome — because an exception here would abort session
 *     recovery rather than merely withhold delegation.
 *
 * @module @banbolee/dsh-agents/identity
 */

import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Directory under the plugin's data root holding one file per child. */
const CHILDREN_DIR = '.children'

/**
 * Current record format version. Bumping this is a compatibility decision:
 * older readers treat a newer record as "identity unknown" rather than
 * guessing, so a version bump silently withholds delegation for children
 * created by the newer writer.
 */
export const CHILD_IDENTITY_VERSION = 1

/** Keys a version-1 record may carry; anything else is a malformed record. */
const V1_KEYS = Object.freeze(['version', 'agentId', 'mainAgentId', 'presetId', 'rootSessionId', 'generation'])

/** Directory and file modes for the sidecar tree. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Codes meaning this filesystem cannot hard-link, so the rename fallback applies. */
const LINK_UNAVAILABLE_CODES = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EACCES', 'EXDEV'])

/** One identity failure, carrying the machine code and the offending field. */
export class IdentityError extends Error {
  /**
   * @param code - stable machine code (`bad-identity`, `bad-child-id`, …).
   * @param message - human-facing description naming the offending value.
   * @param options - the offending field path, when one applies.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    this.field = options.field
  }
}

/**
 * Whether a value can be used as a sidecar file name.
 *
 * The child id becomes a path segment, so this is a containment boundary
 * rather than a style rule: a separator, a relative segment, or an empty string
 * would place the record outside the directory the plugin owns.
 */
function isSafeChildId(childId) {
  return typeof childId === 'string' && childId !== '' && childId !== '.' && childId !== '..' && !childId.includes('/') && !childId.includes('\\')
}

/**
 * Absolute path of one child's identity record.
 * @param rootDir - the plugin data root (the directory holding `agents/`, `prompts/`, …).
 * @param childId - the durable child session id.
 * @returns the record path; the child id is assumed already validated.
 */
export function childIdentityPath(rootDir, childId) {
  return join(rootDir, CHILDREN_DIR, `${childId}.json`)
}

/** Reject a malformed identity before anything reaches disk. */
function assertWritableIdentity(identity) {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw new IdentityError('bad-identity', 'child identity must be an object')
  }
  for (const key of Object.keys(identity)) {
    if (!V1_KEYS.includes(key)) {
      throw new IdentityError('unknown-field', `child identity carries unknown field "${key}"`, { field: key })
    }
  }
  for (const field of ['agentId', 'mainAgentId', 'presetId', 'rootSessionId', 'generation']) {
    const value = identity[field]
    if (typeof value !== 'string' || value === '') {
      throw new IdentityError('bad-identity', `child identity field "${field}" must be a non-empty string`, { field })
    }
  }
  if (identity.version !== CHILD_IDENTITY_VERSION) {
    throw new IdentityError(
      'bad-identity',
      `child identity version must be ${CHILD_IDENTITY_VERSION}, got ${String(identity.version)}`,
      { field: 'version' },
    )
  }
}

/**
 * Persist one child's identity atomically, without ever replacing a record that
 * already exists.
 *
 * Content is staged in a sibling temp file and published with `link`, which is
 * the atomic create-if-absent primitive: it fails with `EEXIST` instead of
 * overwriting. That is what makes the reserved-child-id rule enforced by the
 * store rather than merely assumed — a caller that reuses an id (or a retry
 * that races) gets a loud `already-exists` instead of silently replacing
 * another child's authoritative record. Rewriting the byte-identical record is
 * still accepted so an idempotent retry stays safe.
 *
 * Platforms without hard links fall back to a checked rename, which keeps the
 * refusal semantics even though the check-then-act window is not atomic.
 *
 * @param rootDir - the plugin data root.
 * @param childId - the durable child session id reserved for this child.
 * @param identity - the validated-on-write identity record.
 * @throws {IdentityError} on a bad child id, a malformed identity, an id that
 *   already carries a different record, or an I/O failure.
 */
export function writeChildIdentity(rootDir, childId, identity) {
  if (!isSafeChildId(childId)) {
    throw new IdentityError('bad-child-id', `"${String(childId)}" is not a usable child id`)
  }
  assertWritableIdentity(identity)

  const target = childIdentityPath(rootDir, childId)
  const payload = `${JSON.stringify(identity)}\n`
  // Unique per attempt: two writers for one id must never share a staging path.
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(join(rootDir, CHILDREN_DIR), { recursive: true, mode: DIR_MODE })
    writeFileSync(temp, payload, { mode: FILE_MODE })
  } catch (error) {
    discard(temp)
    throw new IdentityError('write-failed', `cannot persist child identity: ${String(error?.message ?? error)}`)
  }

  try {
    publishIdentity(temp, target, payload, childId)
  } catch (error) {
    if (error instanceof IdentityError) throw error
    throw new IdentityError('write-failed', `cannot persist child identity: ${String(error?.message ?? error)}`)
  } finally {
    discard(temp)
  }
}

/** Atomically create `target` from `temp`, refusing to replace a different record. */
function publishIdentity(temp, target, payload, childId) {
  try {
    linkSync(temp, target)
    return
  } catch (error) {
    if (error?.code === 'EEXIST') {
      acceptIdenticalOrFail(target, payload, childId)
      return
    }
    if (!LINK_UNAVAILABLE_CODES.has(error?.code)) throw error
  }
  // No hard links on this filesystem: refuse an existing target explicitly
  // rather than letting a rename replace it.
  if (existsSync(target)) {
    acceptIdenticalOrFail(target, payload, childId)
    return
  }
  renameSync(temp, target)
}

/**
 * Accept an existing record only when it is byte-identical to what this attempt
 * wrote (an idempotent retry); otherwise the child id is already taken.
 */
function acceptIdenticalOrFail(target, payload, childId) {
  let existing
  try {
    existing = readFileSync(target, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === payload) return
  throw new IdentityError(
    'already-exists',
    `child identity for "${childId}" already exists and differs; refusing to overwrite another child's record`,
    { field: 'childId' },
  )
}

/** Remove a staging file, never masking the original failure. */
function discard(path) {
  try {
    rmSync(path, { force: true })
  } catch {}
}

/**
 * Roll back an identity whose continuable child never published.
 *
 * This is intentionally not a GC API: after `startContinuable()` succeeds the
 * record is permanent and callers must never remove it. The only valid caller
 * is the provisioning failure path while it still owns the reserved child id,
 * and even then the record is removed only when it still holds EXACTLY the
 * payload this attempt wrote — a record someone else published is left alone.
 *
 * @param rootDir - the plugin data root.
 * @param childId - the durable child session id reserved for this child.
 * @param identity - the record this attempt wrote, when the caller has it.
 * @returns `true` when a record existed and was removed, otherwise `false`.
 */
export function rollbackChildIdentity(rootDir, childId, identity) {
  if (!isSafeChildId(childId)) {
    throw new IdentityError('bad-child-id', `"${String(childId)}" is not a usable child id`)
  }
  const target = childIdentityPath(rootDir, childId)
  if (identity !== undefined) {
    let existing
    try {
      existing = readFileSync(target, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw new IdentityError('rollback-failed', `cannot roll back unpublished child identity: ${String(error?.message ?? error)}`)
    }
    if (existing !== `${JSON.stringify(identity)}\n`) return false
  }
  try {
    rmSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new IdentityError('rollback-failed', `cannot roll back unpublished child identity: ${String(error?.message ?? error)}`)
  }
}

/** Parse one record strictly: exact key set, exact version, all strings non-empty. */
function parseIdentity(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  for (const key of Object.keys(value)) {
    if (!V1_KEYS.includes(key)) return undefined
  }
  if (value.version !== CHILD_IDENTITY_VERSION) return undefined
  for (const field of ['agentId', 'mainAgentId', 'presetId', 'rootSessionId', 'generation']) {
    if (typeof value[field] !== 'string' || value[field] === '') return undefined
  }
  return {
    version: CHILD_IDENTITY_VERSION,
    agentId: value.agentId,
    mainAgentId: value.mainAgentId,
    presetId: value.presetId,
    rootSessionId: value.rootSessionId,
    generation: value.generation,
  }
}

/**
 * Read one child's identity, degrading every failure to `undefined`.
 *
 * `undefined` is the single "identity unknown" outcome the delegation runtime
 * consumes: it means "do not authorize further delegation from this child",
 * never "throw and abort recovery".
 *
 * @param rootDir - the plugin data root.
 * @param childId - the durable child session id.
 * @returns the identity, or `undefined` when it cannot be established.
 */
export function readChildIdentity(rootDir, childId) {
  if (!isSafeChildId(childId)) return undefined
  let text
  try {
    text = readFileSync(childIdentityPath(rootDir, childId), 'utf8')
  } catch {
    return undefined
  }
  return parseIdentity(text)
}
