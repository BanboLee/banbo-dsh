/**
 * `terminalTools` policy for the L2 interactive terminal surface of
 * `@banbolee/dsh-fish-shell` — the D6 switch, `'allow' | 'deny'`.
 *
 * The bundle's patch appends a `fish-terminal-group` insert row that mounts
 * the official `@deepseek-ai/dsh-terminal` registry, the official
 * `@deepseek-ai/dsh-terminal-bash` backend driven with fish argv
 * (`--no-config -i -C <prompt setup>`), and the official
 * `@deepseek-ai/dsh-tool-terminal`, whose six `terminal_*` tools register
 * into the HOST tool registry (the group isolates `terminals`, not `tools`).
 * This module is the only entry the plugin itself adds for L2: a per-agent
 * switch that can take those six tools away again.
 *
 *   - `terminalTools: 'allow'` (the default, matching every other tool in the
 *     deployment) does nothing at all — `apply` returns before registering a
 *     single listener, so an allowed mount has zero runtime footprint.
 *   - `terminalTools: 'deny'` restricts the six tools for every live agent at
 *     the `agent/created` publication edge and on every `tools/change`. The
 *     official `tools.restrict` is the only enforcement point, and it REJECTS
 *     names that are not registered at that moment, so an attempt made before
 *     the terminal tools exist fails and is retried on the next
 *     `tools/change` (the registry announces every registration and scoped
 *     restriction through that event).
 *
 * Every `apply()` call owns its ENTIRE state — its own live-agent set, its own
 * per-agent disposers, its own reconcile flags, and its own
 * installing/warned/removed bookkeeping. Two mounts sharing one context (two
 * bundle rows) or two profiles living in one process therefore cannot dedupe
 * into, lift, or orphan each other's restrictions: each mount installs its own
 * restriction and that mount alone lifts it on teardown, so no restriction
 * outlives the mount that owns it.
 *
 * The governed names are the EXPLICIT six-name enumeration measured on a real
 * profile (`TERMINAL_TOOL_NAMES`); a `terminal_*` wildcard is deliberately not
 * used, so an upstream seventh tool cannot silently pass the policy — the
 * contract test compares this constant with the bundled
 * `@deepseek-ai/dsh-tool-terminal` surface instead.
 *
 * Boundaries: this policy registers no tool, wraps/replaces no host object,
 * monkey-patches nothing, and offers no privilege-escalation entry point. It
 * only narrows an agent's tool surface through the public
 * `agent.ctx.tools.restrict({ deny })` API. The interactive sessions
 * themselves inherit the host's confinement (a `workspace-write` profile is
 * fenced by the host sandbox).
 *
 * @module @banbolee/dsh-fish-shell/terminal-tools
 */

/** Cordis plugin name (the patch row id is `fish-terminal-tools`). */
export const name = 'fish-terminal-tools-policy'
/** Required service: the tool registry the six names are restricted in. */
export const inject = ['tools']

/**
 * The six `terminal_*` tools mounted by the bundle's `fish-terminal-group`,
 * enumerated explicitly (never a `terminal_*` pattern): `terminal_open`,
 * `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`,
 * `terminal_list`.
 */
export const TERMINAL_TOOL_NAMES = Object.freeze([
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
])

/**
 * Plugin configuration schema: one switch. A plain object implementing the
 * standard-schema interface (no external validator): an absent
 * `terminalTools` defaults to `allow`; any value other than `allow`/`deny` is
 * rejected at mount time.
 */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: '@banbolee/dsh-fish-shell/terminal-tools',
    /**
     * Normalize one mount's raw configuration.
     * @param {unknown} value
     */
    validate(value) {
      const mode = /** @type {{ terminalTools?: unknown }} */ (value ?? {}).terminalTools ?? 'allow'
      if (mode !== 'allow' && mode !== 'deny') {
        throw new TypeError("banbo-fish-terminal-tools config.terminalTools must be 'allow' or 'deny'")
      }
      return { value: { terminalTools: mode } }
    },
  },
}

const PLUGIN_TAG = '@banbolee/dsh-fish-shell'

/**
 * One agent as this policy reads it: the harness `Agent` viewed through the
 * two members it keys on — its session id (for warnings) and its agent-scoped
 * context (where the restriction lands). The full runtime `Agent` face is
 * structurally assignable to this view.
 * @typedef {{ id?: string, ctx: import('@deepseek-ai/cordis').Context }} PolicyAgent
 */

/**
 * Mount one `deny` policy on `ctx`, owning every piece of state it needs.
 * Nothing in here is shared with another mount of this module.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context this mount lives on.
 */
function mountDenyPolicy(ctx) {
  /** Agents this mount is currently restricting (guards the synchronous
   * `tools/change` re-entry that `tools.restrict` itself fires).
   * @type {WeakSet<PolicyAgent>} */
  const installing = new WeakSet()
  /** Agents this mount already warned about a failed restriction (warn once
   * per agent per mount).
   * @type {WeakSet<PolicyAgent>} */
  const warned = new WeakSet()
  /** Agents this mount saw disposed: a `tools/change` fired by the uninstall's
   * own disposer must not re-restrict a dying agent.
   * @type {WeakSet<PolicyAgent>} */
  const removed = new WeakSet()
  /** The exact restriction disposer THIS mount installed per agent.
   * @type {WeakMap<PolicyAgent, () => void>} */
  const restrictions = new WeakMap()
  /** This mount's agents with a restriction installed; traversable so its own
   * teardown lifts exactly its own restrictions (a WeakMap would be
   * unreachable).
   * @type {Set<PolicyAgent>} */
  const liveAgents = new Set()
  /** This mount's reconcile re-entrancy guard: a `tools/change` arriving while
   * a reconcile round is in flight marks `reconcilePending` instead of starting
   * a nested round; the round in flight runs exactly one coalesced catch-up
   * round afterwards. */
  let reconciling = false
  let reconcilePending = false
  /** Set while THIS mount's teardown runs so its own listeners (still
   * registered — they were created before the teardown effect, which cordis
   * disposes first) cannot re-install a restriction being lifted. */
  let disposed = false

  /**
   * Deny the six terminal tools for one agent, once. A failure (the tools are
   * not registered in this profile yet, so `tools.restrict` rejects the unknown
   * names) is warned once per agent and retried on the next `tools/change`.
   * @param {PolicyAgent} agent - the live agent (its `ctx` is the agent's scoped context).
   */
  const install = (agent) => {
    if (installing.has(agent) || removed.has(agent)) return
    if (restrictions.has(agent)) return
    installing.add(agent)
    try {
      // A fresh array: the frozen constant stays the policy's single source of
      // names, and the toolbox never receives the shared instance.
      const restriction = agent.ctx.tools.restrict({ deny: [...TERMINAL_TOOL_NAMES] })
      restrictions.set(agent, restriction)
    } catch (error) {
      if (!warned.has(agent)) {
        warned.add(agent)
        console.warn(
          `${PLUGIN_TAG}: could not deny the terminal tools for agent ${agent.id ?? '(unnamed)'} yet `
          + '(they are not registered in this profile so far); retrying on the next tools/change:',
          String(error),
        )
      }
    } finally {
      installing.delete(agent)
    }
  }

  /**
   * Lift one agent's restriction, if THIS mount installed one. The exact
   * disposer is removed from the state BEFORE it runs: lifting a restriction
   * synchronously fires `tools/change` as well.
   * @param {PolicyAgent} agent - the agent whose restriction is lifted.
   * @param {string} label - the operation name in the warning.
   */
  const lift = (agent, label) => {
    const restriction = restrictions.get(agent)
    if (restriction === undefined) return
    restrictions.delete(agent)
    try {
      restriction()
    } catch (error) {
      console.warn(`${PLUGIN_TAG}: could not ${label} terminal tools for agent ${agent.id ?? '(unnamed)'}:`, String(error))
    }
  }

  /**
   * Ensure every live agent carries this mount's restriction (no-op when the
   * `agents` service is absent). Nested calls (the restriction's own
   * `tools/change`) are absorbed into at most ONE coalesced catch-up round, so
   * the dispatch count stays bounded regardless of how many agents are live.
   * @param {boolean} [catchUp] - whether this round is the coalesced catch-up (never re-triggers one).
   */
  const reconcile = (catchUp = false) => {
    if (reconciling) {
      reconcilePending = true
      return
    }
    reconciling = true
    try {
      for (const agent of ctx.get('agents')?.list() ?? []) {
        liveAgents.add(agent)
        install(agent)
      }
    } finally {
      reconciling = false
    }
    if (reconcilePending && !catchUp) {
      reconcilePending = false
      reconcile(true)
    } else {
      reconcilePending = false
    }
  }

  // `agent/created` fires synchronously at the agent publication boundary
  // (before the agent's first turn); a synchronous listener error would
  // propagate into the publish path, but `install` contains its own failures.
  ctx.on('agent/created', ({ agent }) => {
    if (disposed) return
    liveAgents.add(agent)
    install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (disposed) return
    removed.add(agent)
    liveAgents.delete(agent)
    lift(agent, 'lift the restriction on the')
  })
  ctx.on('tools/change', () => {
    if (disposed) return
    reconcile()
  })
  // Plugin-owned teardown (unload/disable/HMR): registered LAST so cordis
  // disposes it FIRST (effects run in reverse registration order) — while this
  // loop lifts THIS mount's restrictions, `disposed` above makes its listeners
  // no-ops, so lifting cannot re-install.
  ctx.effect(() => () => {
    disposed = true
    for (const agent of [...liveAgents]) lift(agent, 'lift the restriction on the')
    liveAgents.clear()
  }, 'fish terminal-tools policy teardown')
  reconcile()
}

/**
 * Cordis plugin entry. With `terminalTools: 'deny'` the six `terminal_*` tools
 * are taken away from every live agent — at the `agent/created` publication
 * edge, on every `tools/change`, and for agents that already exist (plugin
 * hot-reload) — and every restriction this mount installed is lifted on its
 * teardown. With the default `allow` nothing is registered and the function
 * returns.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {{ terminalTools?: 'allow' | 'deny' }} [config] - validated plugin config.
 */
export function apply(ctx, config) {
  if (config?.terminalTools !== 'deny') return
  mountDenyPolicy(ctx)
}
