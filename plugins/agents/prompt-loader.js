/**
 * Persona loading for `@banbolee/dsh-agents` (docs/agents-plugin-plan.md §6.2).
 *
 * A persona is user-authored Markdown that becomes part of every system prompt
 * for the agents referencing it, so this module owns four boundaries:
 *
 *   - **Containment** — a reference resolves inside `<root>/prompts/` after
 *     canonicalisation. The check runs on the realpath, so a symlink pointing
 *     out of the directory is refused even though the link itself lives inside.
 *   - **Decoding** — strict UTF-8. `readFileSync(…, 'utf8')` would substitute
 *     U+FFFD for malformed bytes, silently shipping a corrupted persona; a
 *     fatal decoder turns that into a startup failure instead.
 *   - **Size** — 64 KiB per file and 1 MiB across the whole set. One ceiling
 *     cannot cover the other: many small files still assemble into every
 *     prompt. Both ceilings measure the **normalised** text, because that is
 *     what stays resident and reaches the model; a file already over the
 *     ceiling on disk is refused before it is decoded.
 *   - **Normalisation** — exactly one trailing newline, preserving interior
 *     blank lines, so prompt assembly is byte-stable across editors.
 *
 * The returned snapshot is frozen and detached: personas are read once at Host
 * init and never re-read at runtime, so a later edit cannot change a live
 * agent's prompt.
 *
 * **Two-layer resolution (mirrors definitions).** A built-in definition names a
 * persona that ships inside the package, while a user may override it by
 * dropping a file at the same relative path under their own data root. Both
 * cases are "the reference `prompts/x.md`", so the caller passes an ordered
 * search path — user root first, package root second — and the first root that
 * has the file wins. A reference that escapes or is absolute fails immediately
 * rather than falling through, because no later root can make it correct.
 *
 * @module @banbolee/dsh-agents/prompt-loader
 */

import { Buffer } from 'node:buffer'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { CATALOG_LIMITS } from './schema.js'

/** Per-file ceiling, re-exported from the single ceiling table. */
export const PERSONA_FILE_LIMIT = 64 * 1024

/** The directory under the plugin data root that persona references resolve in. */
const PROMPTS_DIR = 'prompts'

/** Strict decoder: malformed bytes raise instead of becoming U+FFFD. */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** One persona failure, carrying the machine code and offending field. */
export class PromptError extends Error {
  /**
   * @param code - stable machine code (`outside-prompts`, `not-utf8`, …).
   * @param message - human-facing description naming the offending value.
   * @param options - source reference and offending field path.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'PromptError'
    this.code = code
    this.ref = options.ref
    this.field = options.field
  }
}

/** Normalise a decoded persona body to exactly one trailing newline. */
function normalise(body) {
  return `${body.replace(/[\r\n]+$/, '')}\n`
}

/**
 * Resolve one persona reference against a single root.
 *
 * Returns `undefined` when this root simply does not have the file, so the
 * caller can fall through to the next root. Anything that indicates a broken or
 * hostile reference — an absolute path, an escape from `prompts/`, a malformed
 * ref — throws instead, because those are mistakes the next root cannot fix.
 */
function resolveInRoot(rootDir, ref) {
  const promptsDir = join(rootDir, PROMPTS_DIR)
  const joined = resolve(rootDir, ref)
  const joinedRel = relative(promptsDir, joined)
  if (joinedRel === '' || joinedRel.startsWith('..') || isAbsolute(joinedRel)) {
    throw new PromptError('outside-prompts', `persona reference "${ref}" does not resolve under prompts/`, { ref })
  }

  let real
  try {
    real = realpathSync(joined)
  } catch {
    // Absent in this root; the caller decides whether another root supplies it.
    return undefined
  }
  let realPrompts
  try {
    realPrompts = realpathSync(promptsDir)
  } catch {
    return undefined
  }
  const realRel = relative(realPrompts, real)
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
    throw new PromptError('outside-prompts', `persona reference "${ref}" escapes prompts/ through a symlink`, { ref })
  }

  return { path: joined, realPath: real }
}

/** Normalise the roots argument: a single root, or an ordered search path. */
function resolveInside(roots, ref) {
  if (typeof ref !== 'string' || ref === '') {
    throw new PromptError('bad-ref', 'persona reference must be a non-empty string', { ref: String(ref) })
  }
  if (isAbsolute(ref)) {
    throw new PromptError('absolute-path', `persona reference must be relative, got "${ref}"`, { ref })
  }
  const rootList = Array.isArray(roots) ? roots : [roots]
  for (const rootDir of rootList) {
    const found = resolveInRoot(rootDir, ref)
    if (found !== undefined) return found
  }
  throw new PromptError('unreadable-file', `cannot read persona "${ref}": not found in ${rootList.length} root(s)`, { ref })
}

/**
 * Read one persona file into a frozen, detached snapshot.
 *
 * @param roots - the plugin data root, or an ordered search path of roots
 *   (user layer first, package layer second).
 * @param ref - the persona reference from a definition, relative to a root.
 * @returns a frozen `{ ref, text, bytes }` snapshot.
 * @throws {PromptError} on containment, decoding, size, or read failure.
 */
export function loadPersona(roots, ref) {
  const { realPath } = resolveInside(roots, ref)

  let stat
  try {
    stat = statSync(realPath)
  } catch (error) {
    throw new PromptError('unreadable-file', `cannot read persona "${ref}": ${String(error?.message ?? error)}`, { ref })
  }
  if (!stat.isFile()) {
    throw new PromptError('not-a-file', `persona "${ref}" is not a regular file`, { ref })
  }
  if (stat.size > PERSONA_FILE_LIMIT) {
    // Cheap pre-check: refuse before decoding anything that is already over the
    // ceiling on disk, so a huge file never reaches the decoder.
    throw new PromptError(
      'limit-exceeded',
      `persona "${ref}" is ${stat.size} bytes, over the personaFileBytes ceiling of ${PERSONA_FILE_LIMIT}`,
      { ref, field: 'personaFileBytes' },
    )
  }

  let buffer
  try {
    buffer = readFileSync(realPath)
  } catch (error) {
    throw new PromptError('unreadable-file', `cannot read persona "${ref}": ${String(error?.message ?? error)}`, { ref })
  }

  let decoded
  try {
    decoded = UTF8.decode(buffer)
  } catch (error) {
    throw new PromptError('not-utf8', `persona "${ref}" is not valid UTF-8: ${String(error?.message ?? error)}`, { ref })
  }

  const text = normalise(decoded)
  const bytes = Buffer.byteLength(text, 'utf8')
  // The authoritative measurement is the normalised text, not the file: that is
  // what is held resident and assembled into every prompt, and trailing-newline
  // normalisation can move the count by a byte in either direction.
  if (bytes > PERSONA_FILE_LIMIT) {
    throw new PromptError(
      'limit-exceeded',
      `persona "${ref}" is ${bytes} bytes after normalisation, over the personaFileBytes ceiling of ${PERSONA_FILE_LIMIT}`,
      { ref, field: 'personaFileBytes' },
    )
  }

  return Object.freeze({ ref, text, bytes })
}

/**
 * Load a whole set of persona references under the shared total ceiling.
 *
 * Repeated references resolve to one snapshot and are counted once, so a
 * definition reused across forms cannot inflate the budget.
 *
 * @param roots - the plugin data root, or an ordered search path of roots.
 * @param refs - the persona references to load.
 * @returns `{ personas, totalBytes }` where `personas` maps ref → text.
 * @throws {PromptError} on the first per-file failure, or when the total exceeds the ceiling.
 */
export function loadPersonaSet(roots, refs) {
  /** @type {Map<string, string>} */
  const personas = new Map()
  let totalBytes = 0

  for (const ref of refs) {
    if (personas.has(ref)) continue
    const persona = loadPersona(roots, ref)
    totalBytes += persona.bytes
    if (totalBytes > CATALOG_LIMITS.maxPersonaTotalBytes) {
      throw new PromptError(
        'limit-exceeded',
        `personas total ${totalBytes} bytes, over the maxPersonaTotalBytes ceiling of ${CATALOG_LIMITS.maxPersonaTotalBytes}`,
        { ref, field: 'maxPersonaTotalBytes' },
      )
    }
    personas.set(ref, persona.text)
  }

  return { personas, totalBytes }
}
