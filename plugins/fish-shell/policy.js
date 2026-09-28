/**
 * Per-agent fish policy for DeepSeek Harness: whatever agent preset a session
 * uses (standard, ptc, cordis, minimal, or a third-party preset), its agent
 * must see the host-global `fish` tool and never a `bash` tool inherited from
 * the preset's standing scope.
 *
 * The bundle's patch (`cordis.patch.yml`) disables the host bash executor and
 * host `tool-bash`, mounts the fish executor and the host-global `fish` tool,
 * and NO LONGER changes the preset roster default. Presets keep registering
 * their own `bash`-named tool (standard/minimal do), and the model would see
 * a lying "bash" card that actually executes fish — or, under `minimal`, a
 * real persistent PTY bash. This plugin fixes that at the agent boundary:
 *
 *   - `agent/created` (fired synchronously at the agent publication edge,
 *     before its first turn — the same hook dsh-tool-subagent uses) applies
 *     the policy to the new agent.
 *   - `tools/change` (fired after any preset recompose, e.g. `/preset`)
 *     reconciles every live agent. The reconcile is re-entrancy-guarded: the
 *     policy's own restriction/prompt/persistent registrations and disposals
 *     synchronously fire `tools/change` themselves, and without a guard one
 *     external change cascades into a factorial dispatch storm across agents.
 *     Events arriving mid-round are coalesced into at most ONE catch-up
 *     round, and agents whose preset parent scope is unchanged are skipped
 *     entirely (their installed state — including the persistent fish tool —
 *     is left untouched).
 *   - When the inherited `bash` tool is the PERSISTENT form (the official
 *     `dsh-tool-bash-persistent` signature: parameters hold only `command`
 *     and the output schema is a plain string — the `minimal` preset), the
 *     policy first registers a persistent `fish` tool at the agent scope
 *     (`persistent.js`), which shadows the host-global one-shot fish, so
 *     minimal sessions keep their persistent semantics (cwd, variables,
 *     functions) in fish. On a preset switch the previous persistent fish is
 *     removed BEFORE probing fish visibility: an agent-scope persistent fish
 *     must never count as "inherited fish visible", or a switch into a
 *     deny-fish allowlist preset would wrongly keep bash hidden.
 *   - `tools.restrict({ deny: ['bash'] })` through `agent.ctx` filters the
 *     bash the agent INHERITS from the global and preset-ancestor layers.
 *   - The preset's static `tool:bash` prompt section is not removed by the
 *     restriction, so an empty agent-scoped section with the same name
 *     shadows it (scoped sections shadow ancestor/global ones). Installation
 *     is transactional: a failure (e.g. a third-party agent that registered
 *     its own `tool:bash` section) rolls back everything THIS call created,
 *     so no half-installed restriction leaks.
 *   - Plugin teardown (unload/disable/HMR) strips the policy from every live
 *     agent: the bash restriction, the `tool:bash` shadow, and any
 *     persistent fish registration are removed so nothing outlives the
 *     plugin.
 *
 * The plugin uses the injected `tools` / `systemPrompt` services and
 * `ctx.get('agents')`; `persistent.js` (imported only for the persistent
 * form) brings in `@deepseek-ai/dsh-tools`' `defineTool`, and
 * `@deepseek-ai/dsh-scope`'s `scopeParentOf` identifies the preset standing
 * scope an agent's policy was installed under.
 *
 * @module @banbolee/dsh-fish-shell/policy
 */

import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { registerPersistentFish } from './persistent.js'

export const name = 'fish-preset-policy'
export const inject = ['tools', 'systemPrompt']

const PLUGIN_TAG = '@banbolee/dsh-fish-shell'

/**
 * One agent as this policy reads it: the harness `Agent` viewed through the two
 * members every registration below keys on — its session id (for warnings) and
 * its agent-scoped context (where the restriction/prompt/tool registrations
 * land). The full runtime `Agent` face is structurally assignable to this view.
 * @typedef {{ id?: string, ctx: import('@deepseek-ai/cordis').Context }} PolicyAgent
 */

/**
 * One agent's installed policy: which bash form was detected, the preset parent
 * key it was installed under (the switch/re-entry fast path compares it), and
 * the disposers that must move with `/preset`.
 * @typedef {object} PolicyState
 * @property {'persistent' | 'one-shot'} kind - the bash form this policy swapped out.
 * @property {import('@deepseek-ai/dsh-scope').ScopeKey | undefined} parentKey - the preset parent scope key this state was installed under (`scopeParentOf(agent)`).
 * @property {(() => Promise<void> | undefined) | undefined} persistentFish - the persistent fish tool's disposer, when this state installed one.
 * @property {() => void} restriction - the `deny: ['bash']` restriction disposer.
 * @property {() => void} prompt - the `tool:bash` prompt-shadow disposer.
 */

/** Agents currently being reconciled (guards the synchronous tools/change
 * re-entry that restriction/prompt registration and disposal trigger).
 * @type {WeakSet<PolicyAgent>} */
const installing = new WeakSet()
/** Agents already warned about an invisible fish tool (warn once per agent).
 * @type {WeakSet<PolicyAgent>} */
const warned = new WeakSet()
/** Agents uninstalled via `agent/disposed`: a tools/change fired by the
 * uninstall's own disposals must not re-install a dying agent.
 * @type {WeakSet<PolicyAgent>} */
const removed = new WeakSet()
/** Per-agent policy state, including disposers that must move with /preset.
 * @type {WeakMap<PolicyAgent, PolicyState>} */
const states = new WeakMap()
/** Live agents with policy installed; traversable so plugin teardown can
 * strip every registration (a WeakMap would be unreachable on teardown).
 * @type {Set<PolicyAgent>} */
const liveAgents = new Set()
/** Global reconcile re-entrancy guard: a tools/change arriving while a
 * reconcile round is in flight marks `reconcilePending` instead of starting a
 * nested round; the current round runs exactly one coalesced catch-up round
 * afterwards. */
let reconciling = false
let reconcilePending = false

/**
 * Narrow one unchecked value to a non-null, non-array object: the shape this
 * policy reads duck-typed tool definitions and disposer results through.
 * @param {unknown} value - the value to inspect.
 * @returns {value is Record<string, unknown>} whether it is a plain object record.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Dispose one registration quietly: `undefined` means nothing was installed,
 * a synchronous throw and a rejected async disposer are both warned instead of
 * breaking the policy round that runs the disposal.
 * @param {(() => unknown) | undefined} disposer - the registration's disposer, when there is one.
 * @param {string} label - the registration's name in the warning.
 * @param {PolicyAgent} agent - the agent the registration belongs to.
 */
function disposeQuietly(disposer, label, agent) {
  if (disposer === undefined) return
  try {
    const result = disposer()
    // Async disposers (persistent fish cleanup) are awaited out-of-band so a
    // failing teardown is recorded instead of unhandled; a plain `void`
    // disposer returns a non-thenable and needs no wait.
    if (isPlainObject(result) && typeof result.then === 'function') {
      void Promise.resolve(result).catch((error) => {
        console.warn(`${PLUGIN_TAG}: could not dispose ${label} for agent ${agent.id ?? '(unnamed)'}:`, String(error))
      })
    }
  } catch (error) {
    console.warn(`${PLUGIN_TAG}: could not dispose ${label} for agent ${agent.id ?? '(unnamed)'}:`, String(error))
  }
}

/**
 * Drop every registration one policy state owns.
 * @param {PolicyAgent} agent - the agent the state belongs to.
 * @param {PolicyState} state - the installed state to tear down.
 */
function disposeState(agent, state) {
  disposeQuietly(state.prompt, 'tool:bash prompt shadow', agent)
  disposeQuietly(state.restriction, 'bash restriction', agent)
  disposeQuietly(state.persistentFish, 'persistent fish tool', agent)
}

/**
 * Drop the registrations a preset switch must lift before it probes the target
 * preset's surface (the prompt shadow and the bash restriction only).
 * @param {PolicyAgent} agent - the agent whose transient policy is removed.
 * @param {PolicyState | undefined} state - the previous state, when there is one.
 */
function removeTransientPolicy(agent, state) {
  disposeQuietly(state?.prompt, 'tool:bash prompt shadow', agent)
  disposeQuietly(state?.restriction, 'bash restriction', agent)
}

/**
 * Detect the official persistent-bash tool signature (`dsh-tool-bash-
 * persistent`): a definition whose parameters carry ONLY `command` and whose
 * output schema is a plain string. The one-shot bash tool (command +
 * description + workdir + timeoutMs + run_in_background +
 * sandbox_permissions…) and every other tool shape fall through.
 * @param {import('@deepseek-ai/dsh-tools').ToolDefinition} definition - the tool definition an agent resolves for `bash`.
 * @returns {boolean} true when the agent's bash is the persistent PTY form.
 */
export function isPersistentBashForm(definition) {
  if (!isPlainObject(definition)) return false
  const schema = definition.output?.schema
  if (!isPlainObject(schema) || schema.type !== 'string') return false
  const parameters = definition.parameters
  if (!isPlainObject(parameters)) return false
  // Official persistent bash: parameters is a property map holding ONLY
  // `command` (schemastery shape, no JSON-Schema wrapper).
  const keys = Object.keys(parameters)
  if (keys.length === 1 && keys[0] === 'command') return true
  // Defensive: a JSON-Schema-normalized variant with `properties` holding
  // only `command`.
  const properties = parameters.properties
  return isPlainObject(properties) && Object.keys(properties).length === 1 && Object.hasOwn(properties, 'command')
}

/**
 * Remove every policy-owned registration for an agent.
 * @param {PolicyAgent} agent - the agent whose policy is uninstalled.
 */
export function uninstallFishPolicy(agent) {
  liveAgents.delete(agent)
  removed.add(agent)
  const state = states.get(agent)
  if (state === undefined) return
  states.delete(agent)
  disposeState(agent, state)
}

/**
 * Apply the fish policy to one agent: hide its inherited `bash` tool and
 * shadow the `tool:bash` prompt guidance, leaving only the appropriate `fish`
 * tool. Recomputed on every preset switch (the agent's parent scope key
 * changed); an unchanged preset parent makes the call a no-op so unrelated
 * `tools/change` events cannot churn the restriction or reset the persistent
 * fish. Installation is transactional: nothing is committed to `states`
 * until every registration succeeded, and a failure rolls back only the
 * disposers THIS call created.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the policy plugin's context.
 * @param {PolicyAgent} agent - the live agent (its `ctx` is the agent's scoped context).
 */
export function installFishPolicy(ctx, agent) {
  if (installing.has(agent)) return
  // The agent was uninstalled (agent/disposed): a tools/change fired by that
  // uninstall's own disposals must not re-install a dying agent.
  if (removed.has(agent)) return

  installing.add(agent)
  const previous = states.get(agent)
  const parentKey = scopeParentOf(agent)
  try {
    // Fast path: the agent already has a policy installed under the SAME
    // preset parent scope. Nothing relevant changed for this agent, so an
    // unrelated tools/change (host tools, other agents' registrations) must
    // not dispose and re-register anything — that churn is what turned one
    // external change into a factorial dispatch storm across agents, and it
    // would reset a persistent fish (dropping its PTY) for no reason.
    if (previous !== undefined && previous.parentKey === parentKey) return

    // Preset switch or first install: lift everything this policy owns so the
    // probes below see the target preset's true inherited surface. The old
    // persistent fish is removed BEFORE probing fish visibility — an
    // agent-scope persistent fish would otherwise count as "fish visible" and
    // let a deny-fish allowlist preset pass through with bash still hidden.
    removeTransientPolicy(agent, previous)
    disposeQuietly(previous?.persistentFish, 'persistent fish tool', agent)

    const bash = ctx.tools.get('bash', agent)
    if (bash === undefined) {
      states.delete(agent)
      return
    }

    const wantsPersistent = isPersistentBashForm(bash)
    const fish = ctx.tools.get('fish', agent)
    if (fish === undefined) {
      // The preset deliberately excludes the global fish tool (an allowlist),
      // so there is nothing to swap bash for — leave the preset as authored and
      // warn once per agent instead of mutating it.
      if (!warned.has(agent)) {
        warned.add(agent)
        console.warn(
          `${PLUGIN_TAG}: agent ${agent.id ?? '(unnamed)'} has no visible fish tool `
          + '(its preset allowlist excludes the global fish tool); leaving its inherited bash tool in place',
        )
      }
      states.delete(agent)
      return
    }

    // Transactional install. `persistentFish` is created by THIS call (the
    // previous one, if any, was already removed above as part of the switched-
    // away state), so the failure path below rolls back exactly what this call
    // created and never destroys a registration it reused.
    let persistentFish
    if (wantsPersistent) {
      // The minimal preset's persistent bash is swapped for persistent fish
      // at the agent scope (shadowing the host-global one-shot fish) BEFORE
      // bash is hidden, so minimal sessions keep persistent semantics.
      persistentFish = registerPersistentFish(ctx, agent.ctx)
    }
    /** @type {Array<() => void>} */
    const created = []
    try {
      const restriction = agent.ctx.tools.restrict({ deny: ['bash'] })
      created.push(() => disposeQuietly(restriction, 'bash restriction', agent))
      const prompt = agent.ctx.systemPrompt.section({
        name: 'tool:bash',
        order: agent.ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
        text: '',
      })
      created.push(() => disposeQuietly(prompt, 'tool:bash prompt shadow', agent))
      states.set(agent, {
        kind: wantsPersistent ? 'persistent' : 'one-shot',
        parentKey,
        persistentFish,
        restriction,
        prompt,
      })
    } catch (error) {
      // Roll back in reverse registration order, then drop this call's new
      // persistent fish. The previous state's entries were already removed
      // above, so `states` ends up consistent: no restriction, no shadow, no
      // persistent fish — bash stays visible and the failure is surfaced.
      for (let index = created.length - 1; index >= 0; index -= 1) created[index]?.()
      disposeQuietly(persistentFish, 'persistent fish tool', agent)
      throw error
    }
  } catch (error) {
    states.delete(agent)
    console.warn(`${PLUGIN_TAG}: could not hide bash for agent ${agent.id ?? '(unnamed)'}:`, String(error))
  } finally {
    installing.delete(agent)
  }
}

/**
 * Apply the policy to every live agent (no-op when the agents service is
 * absent). Re-entrant calls (a registration/disposal mid-round fires
 * `tools/change` synchronously) are absorbed into at most ONE coalesced
 * catch-up round, so an external change dispatches a small constant number
 * of times regardless of how many agents are live.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the policy plugin's context (the `agents` service is resolved from it).
 * @param {boolean} [catchUp] - whether this round is the coalesced catch-up (never re-triggers one).
 */
function reconcile(ctx, catchUp = false) {
  if (reconciling) {
    reconcilePending = true
    return
  }
  reconciling = true
  try {
    for (const agent of ctx.get('agents')?.list() ?? []) {
      liveAgents.add(agent)
      try {
        installFishPolicy(ctx, agent)
      } catch (error) {
        console.warn(`${PLUGIN_TAG}: policy reconcile failed for agent ${agent.id ?? '(unnamed)'}:`, String(error))
      }
    }
  } finally {
    reconciling = false
  }
  if (reconcilePending && !catchUp) {
    // One coalesced catch-up round for changes that arrived mid-round (e.g.
    // another plugin's listener mutated the tool surface). The catch-up round
    // itself never re-triggers: every installed agent fast-paths on its
    // parent key, so dispatch count stays bounded.
    reconcilePending = false
    reconcile(ctx, true)
  } else {
    reconcilePending = false
  }
}

/**
 * Cordis plugin entry: install the per-agent fish policy at the agent
 * publication edge and on every tools/change, cover agents that already
 * exist (plugin hot-reload), and strip every live-agent registration on
 * plugin teardown.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 */
export function apply(ctx) {
  // Set while this plugin's teardown runs so the listeners below (still
  // registered — they were created before the teardown effect, which cordis
  // disposes first) cannot re-install a policy being torn down.
  let disposed = false
  // `agent/created` fires synchronously at the agent publication boundary
  // (before the agent's first turn); a synchronous listener error would
  // propagate into the publish path, so every failure is contained here.
  ctx.on('agent/created', ({ agent }) => {
    if (disposed) return
    liveAgents.add(agent)
    try {
      installFishPolicy(ctx, agent)
    } catch (error) {
      console.warn(`${PLUGIN_TAG}: agent/created policy install failed for ${agent.id ?? '(unnamed)'}:`, String(error))
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (disposed) return
    try {
      uninstallFishPolicy(agent)
    } catch (error) {
      console.warn(`${PLUGIN_TAG}: agent/disposed policy cleanup failed for ${agent.id ?? '(unnamed)'}:`, String(error))
    }
  })
  ctx.on('tools/change', () => {
    if (disposed) return
    reconcile(ctx)
  })
  // Plugin-owned teardown (unload/disable/HMR): registered LAST so cordis
  // disposes it FIRST (effects run in reverse registration order) — while
  // this loop's own tools/change events are still delivered, `disposed`
  // above makes the listeners no-ops, so uninstalling cannot re-install.
  ctx.effect(() => () => {
    disposed = true
    for (const agent of [...liveAgents]) {
      try {
        uninstallFishPolicy(agent)
      } catch (error) {
        console.warn(`${PLUGIN_TAG}: policy teardown failed for agent ${agent.id ?? '(unnamed)'}:`, String(error))
      }
    }
    liveAgents.clear()
  }, 'fish preset policy teardown')
  reconcile(ctx)
}
