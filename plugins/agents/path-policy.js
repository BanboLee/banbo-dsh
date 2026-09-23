/**
 * Path-scoped write policy — docs/agents-plugin-plan.md §5.2, §16.12.
 *
 * A definition's optional `writeScope` confines its `write` and `edit` tools to
 * one directory below the session workspace. The Planner Agent is the first
 * user: it must be able to write its own plan files under
 * `<workspace>/.banbo-dsh/plans/` and nothing else.
 *
 * Three limits are load-bearing and are stated here because they are the whole
 * reason this is a guard rather than a sandbox:
 *
 *   - **only `write` / `edit` are constrained.** Every other tool — `read`,
 *     `search`, `web`, `present` — is untouched, and read access is never
 *     restricted. A `writeScope` is a write-path policy, not a filesystem jail;
 *   - **it is sound only while the scoped form has no shell.** `exec` would
 *     bypass it completely: `echo x > /etc/y` never calls `write`, so the guard
 *     never sees it. The shipped Planner has no `exec` capability in either
 *     form; adding one silently voids this policy. Never grant `exec` to a
 *     `writeScope`-carrying form without replacing this mechanism;
 *   - **it is not a sandbox.** It does not confine the process, the network, or
 *     any third-party tool reached through `extraTools` (§5.2).
 *
 * The check is lexical first and then real-path based: the target must resolve
 * inside the scope (which also rejects `..` escapes and absolute paths), and the
 * nearest EXISTING ancestor of the target must have a real path inside the real
 * scope, so a symlink placed inside the scope cannot be used to write outside
 * it. Every unresolvable or ambiguous case denies.
 *
 * @module @banbolee/dsh-agents/path-policy
 */

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, posix, resolve, sep, win32 } from 'node:path'

/**
 * The only tools this policy constrains. Every other tool name is returned as
 * allowed without inspection, so a harness tool added later is unaffected until
 * it is named here on purpose.
 */
export const WRITE_TOOLS = Object.freeze(['write', 'edit'])

/** Every denial this module produces starts with this prefix (§13). */
const PREFIX = 'banbo-agents: '

/**
 * Longest path fragment echoed back into a denial, in UTF-16 code units.
 *
 * A denial is shown to the model and to the user, while `file_path` is
 * caller-controlled: unbounded, a single call with a megabyte-long path would
 * put a megabyte into the transcript. The bound applies to the ECHO only —
 * every check below still runs against the full, untruncated value, so a path
 * whose meaning lives past the bound can never be allowed by truncation.
 */
const MAX_ECHO = 200

/** Bound one echoed path with a trailing ellipsis; never used for a decision. */
const echo = (value) => (value.length <= MAX_ECHO ? value : `${value.slice(0, MAX_ECHO)}…`)

/**
 * Real path of the nearest existing ancestor of `target`.
 *
 * A target that does not exist yet is the normal case — `dsh-fs-local` creates
 * missing parent directories itself — so a missing leaf is not an error. The
 * walk stops at the first path that resolves, which is the deepest component an
 * attacker could have replaced with a symlink. `ENOENT` / `ENOTDIR` mean "not
 * there yet, go up"; anything else (`EACCES`, `ELOOP`, …) propagates and denies.
 *
 * @param target - an absolute path.
 * @returns the real path of `target` or of its nearest existing ancestor.
 * @throws when no ancestor resolves, or a resolution fails for another reason.
 */
function realpathOfNearestAncestor(target) {
  let current = target
  for (;;) {
    try {
      return realpathSync(current)
    } catch (error) {
      const code = error?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

/**
 * Decide one tool execution against one mounted form's `writeScope`.
 *
 * The shape mirrors `delegationGuardReason`: a synchronous monotonic guard
 * returning a denial reason, or `undefined` to leave the call allowed.
 *
 * @param definition - the mounted form (`MainProfile` or `ChildProfile`) of the
 *   Agent executing the call. Pass the form the executing agent actually runs
 *   as; the two forms may declare different scopes.
 * @param execution - the frozen `ToolExecution` the guard receives.
 * @returns a one-sentence denial naming the allowed directory, or `undefined`.
 */
export function writeScopeGuardReason(definition, execution) {
  const tool = execution?.name
  if (!WRITE_TOOLS.includes(tool)) return undefined
  const scope = definition?.writeScope
  if (scope === undefined) return undefined

  /**
   * The one denial constructor. Every refusal in this function goes through it,
   * so each message is a single sentence that starts with `PREFIX`, names the
   * tool, and ends with the directory this Agent may write under. Both echoed
   * paths — the offending `file_path` and the declared scope — are bounded by
   * {@link echo}.
   */
  const refuse = (detail) =>
    `${PREFIX}"${tool}" refused ${detail}; this Agent may only write under "${echo(scope)}" relative to the session workspace`

  const filePath = execution?.arguments?.file_path
  if (typeof filePath !== 'string' || filePath === '') {
    return refuse('because file_path is missing or is not a non-empty string')
  }
  if (filePath.includes('\0') || filePath.includes('\\')) {
    return refuse(`for "${echo(filePath)}", which is not a plain relative path`)
  }
  if (isAbsolute(filePath) || win32.isAbsolute(filePath)) {
    return refuse(`for the absolute path "${echo(filePath)}"`)
  }
  const normalised = posix.normalize(filePath)
  if (normalised === '..' || normalised.startsWith('../')) {
    return refuse(`for "${echo(filePath)}", which escapes the session workspace`)
  }

  const workspace = execution?.agent?.session?.header?.cwd
  if (typeof workspace !== 'string' || workspace === '') {
    return refuse('because the session has no workspace directory to resolve it against')
  }
  const scopeRoot = resolve(workspace, scope)
  const target = resolve(workspace, normalised)
  if (target !== scopeRoot && !target.startsWith(scopeRoot + sep)) {
    return refuse(`for "${echo(filePath)}", which is outside the write scope`)
  }

  // Lexical containment alone is not enough: `plans/link/file.md` is inside the
  // scope as a string, while `link` may be a symlink to anywhere. Resolve the
  // nearest existing ancestor of both sides and re-check containment on the real
  // paths. Any error here denies — an unprovable path is not an allowed one.
  let realWorkspace
  let realScope
  let realTarget
  try {
    realWorkspace = realpathSync(workspace)
    realScope = realpathOfNearestAncestor(scopeRoot)
    realTarget = realpathOfNearestAncestor(target)
  } catch {
    return refuse(`for "${echo(filePath)}", whose real path could not be resolved`)
  }
  // The scope ROOT must itself live inside the workspace. Without this, a
  // `.banbo-dsh` symlink pointing at `/etc` would make `/etc` the authoritative
  // scope and silently widen the policy to the whole target directory.
  if (realScope !== realWorkspace && !realScope.startsWith(realWorkspace + sep)) {
    return refuse(`for "${echo(filePath)}", because the write scope "${echo(scope)}" itself resolves outside the session workspace`)
  }
  if (realTarget !== realScope && !realTarget.startsWith(realScope + sep)) {
    return refuse(`for "${echo(filePath)}", whose real path lies outside the write scope through a symlink`)
  }
  return undefined
}
