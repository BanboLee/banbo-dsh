/**
 * The capability → runtime tool-name compiler — docs/agents-plugin-plan.md §5.2.
 *
 * A definition never names a harness tool. It grants a capability (`exec`,
 * `agent-control`), and this module turns that into the concrete tool names the
 * live harness actually registered. Two properties matter, and both are load
 * bearing:
 *
 *   - **narrowing is explicit, widening is impossible.** The table below is the
 *     whole surface a capability can reach. A tool the harness adds tomorrow is
 *     not granted until a human adds its name here, so a harness upgrade cannot
 *     silently widen an agent's reach.
 *   - **absence is loud.** A capability whose names are not in the live registry
 *     throws instead of quietly producing a smaller allowlist (§5.2: "缺失就回滚，
 *     不静默忽略"). The one exception is deliberate and platform-shaped: `exec`
 *     resolves to whichever shell the TARGET PROFILE actually registers, and
 *     §5.2 fixes that order — fish first, else bash, else pwsh — so a profile
 *     that replaces the official shell rows (dsh-tui swaps bash/pwsh for the
 *     fish-shell tool) still assembles. Exactly one shell is granted.
 *
 * @module @banbolee/dsh-agents/tool-surface
 */

import { FORBIDDEN_DELEGATION_TOOLS, SHELL_TOOL_NAMES } from './schema.js'

/**
 * The single shared denylist of real runtime tool names, derived from the
 * catalog validator's denylist plus the two names that exist only in the
 * harness's own registry.
 *
 * `FORBIDDEN_DELEGATION_TOOLS` names the general-purpose creation entry points
 * (`subagent`, `subagent_fork`, `workflow`, `ralph`); `delegate_batch` is ours
 * and must never be reachable through `extraTools`, exactly like `run_code`,
 * which is a transport name the plan keeps out of every filter.
 */
export const FORBIDDEN_RUNTIME_TOOLS = Object.freeze([
  ...FORBIDDEN_DELEGATION_TOOLS,
  'delegate_batch',
  'run_code',
])

/**
 * @typedef {object} CapabilitySurface
 * @property {string[]} [all] names that must every one be visible
 * @property {string[]} [prefer] ordered alternatives of which the FIRST visible
 *   one is granted; none visible is a failure
 * @property {string[]} [optional] names granted when the registry has them
 */

/**
 * The complete capability table, keyed and ordered exactly like
 * `TOOL_CAPABILITIES` (a unit test locks that correspondence).
 *
 * `todo` and `jobs` are spelled separately because they are separately
 * grantable: `dsh-tool-todo` owns `todo_write` and `dsh-tool-jobs` owns the
 * three `job_*` tools, and §5.2 grants them independently.
 *
 * @type {Readonly<Record<string, CapabilitySurface>>}
 */
export const CAPABILITY_TOOLS = Object.freeze({
  read: Object.freeze({ all: Object.freeze(['read']), optional: Object.freeze(['read_image']) }),
  search: Object.freeze({ all: Object.freeze(['grep', 'glob']) }),
  web: Object.freeze({ all: Object.freeze(['web_search', 'web_fetch']) }),
  // §5.2: the shell the target profile actually registers — fish first (dsh-tui
  // replaces the official bash/pwsh rows with the fish-shell tool), else bash
  // (POSIX Web), else pwsh (Windows). Exactly one is granted, so a profile that
  // happens to register several shells does not silently widen the surface. The
  // order lives in `SHELL_TOOL_NAMES` (schema.js) because the `writeScope`
  // precondition check must recognise the very same shells (§16.12).
  exec: Object.freeze({ prefer: SHELL_TOOL_NAMES }),
  write: Object.freeze({ all: Object.freeze(['write']) }),
  edit: Object.freeze({ all: Object.freeze(['edit']) }),
  skill: Object.freeze({ all: Object.freeze(['skill']) }),
  todo: Object.freeze({ all: Object.freeze(['todo_write']) }),
  jobs: Object.freeze({ all: Object.freeze(['job_list', 'job_output', 'job_kill']) }),
  'ask-user': Object.freeze({ all: Object.freeze(['ask_user_question']) }),
  goal: Object.freeze({ all: Object.freeze(['create_goal', 'get_goal', 'update_goal']) }),
  present: Object.freeze({ all: Object.freeze(['present']) }),
  'agent-control': Object.freeze({ all: Object.freeze(['list_agents', 'send_message', 'interrupt_agent']) }),
})

/**
 * One tool-surface failure, carrying the machine-readable half so callers can
 * report a fixable path instead of a prose blob.
 */
export class ToolSurfaceError extends Error {
  /** @type {string} the machine code. */
  code
  /** @type {string | undefined} the capability that could not be satisfied. */
  capability
  /** @type {string[] | undefined} names the caller needs and does not have. */
  missing
  /** @type {string[] | undefined} names that stayed visible but are not allowed. */
  unexpected
  /** @type {string[] | undefined} the offending `extraTools` entries. */
  extraTools

  /**
   * @param code - the machine code.
   * @param message - the user-facing message.
   * @param detail - `capability`, `missing`, `unexpected`, `extraTools`.
   */
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ToolSurfaceError'
    this.code = code
    Object.assign(this, detail)
  }
}

/** Coerce the caller's registry view into a `Set` of names, once. */
function toNameSet(registered) {
  return registered instanceof Set ? registered : new Set(registered)
}

/**
 * Resolve one capability against the live registry.
 *
 * @param capability - a `TOOL_CAPABILITIES` member.
 * @param registered - the live runtime tool names.
 * @returns the granted names, in table order.
 * @throws {ToolSurfaceError} `unknown-capability`, or `capability-unavailable`
 *   when a required name (or every alternative) is missing.
 */
export function resolveCapability(capability, registered) {
  const surface = CAPABILITY_TOOLS[capability]
  if (surface === undefined) {
    throw new ToolSurfaceError('unknown-capability', `unknown capability ${JSON.stringify(capability)}`, { capability })
  }
  const names = toNameSet(registered)

  const missing = (surface.all ?? []).filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new ToolSurfaceError(
      'capability-unavailable',
      `capability ${JSON.stringify(capability)} needs ${missing.join(', ')}, which this composition does not register`,
      { capability, missing },
    )
  }

  const alternatives = surface.prefer ?? []
  const chosen = alternatives.find((name) => names.has(name))
  if (alternatives.length > 0 && chosen === undefined) {
    throw new ToolSurfaceError(
      'capability-unavailable',
      `capability ${JSON.stringify(capability)} needs one of ${alternatives.join(', ')}, none of which this composition registers`,
      { capability, missing: [...alternatives] },
    )
  }

  return [
    ...(surface.all ?? []),
    ...(chosen === undefined ? [] : [chosen]),
    ...(surface.optional ?? []).filter((name) => names.has(name)),
  ]
}

/**
 * Compile a definition's capability list plus `extraTools` into one allowlist.
 *
 * Order is capability declaration order, then `extraTools` in the order given,
 * with duplicates removed — a deterministic list so a tool filter is stable
 * across restarts and comparable in tests.
 *
 * @param options - `capabilities`, optional `extraTools`, `registered`.
 * @returns the allowlist.
 * @throws {ToolSurfaceError} on an unavailable capability, an `extraTools` name
 *   the registry does not have, or an `extraTools` name that is forbidden.
 */
export function compileAllowlist(options) {
  const registered = toNameSet(options.registered)
  const allow = []
  const seen = new Set()
  for (const capability of options.capabilities ?? []) {
    for (const name of resolveCapability(capability, registered)) {
      if (seen.has(name)) continue
      seen.add(name)
      allow.push(name)
    }
  }
  for (const name of options.extraTools ?? []) {
    if (FORBIDDEN_RUNTIME_TOOLS.includes(name)) {
      throw new ToolSurfaceError(
        'forbidden-extra-tool',
        `extraTools entry ${JSON.stringify(name)} is a forbidden delegation entry point and can never be granted`,
        { extraTools: [name] },
      )
    }
    if (!registered.has(name)) {
      throw new ToolSurfaceError(
        'unregistered-extra-tool',
        `extraTools entry ${JSON.stringify(name)} is not a registered tool in this composition; install the plugin that provides it and restart`,
        { extraTools: [name] },
      )
    }
    if (seen.has(name)) continue
    seen.add(name)
    allow.push(name)
  }
  return allow
}

/**
 * Prove that a restriction actually took effect (§9.3 step 5).
 *
 * `tools.restrict()` is the enforcement; this is the synchronous self-check
 * that the enforcement produced the set the definition asked for. Both failure
 * directions matter: a tool that stayed visible is a widened surface, and an
 * allowed tool that never materialised means the definition cannot do its job
 * and must fail before the first model request rather than mid-task.
 *
 * @param options - `visible` (what the agent can see now) and `allow`.
 * @throws {ToolSurfaceError} `tool-surface-mismatch`.
 */
export function assertToolSurface(options) {
  const visible = toNameSet(options.visible)
  const allow = new Set(options.allow)
  const unexpected = [...visible].filter((name) => !allow.has(name)).sort()
  const missing = [...allow].filter((name) => !visible.has(name)).sort()
  if (unexpected.length === 0 && missing.length === 0) return
  const parts = []
  if (unexpected.length > 0) parts.push(`still visible but not allowed: ${unexpected.join(', ')}`)
  if (missing.length > 0) parts.push(`allowed but not visible: ${missing.join(', ')}`)
  throw new ToolSurfaceError('tool-surface-mismatch', `tool surface self-check failed — ${parts.join('; ')}`, {
    missing,
    unexpected,
  })
}
