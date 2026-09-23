/**
 * Per-preset top-level activation gate — docs/agents-plugin-plan.md §9.3/§9.4.
 *
 * The Host preloads every byte this module consumes. The `agent/created`
 * listener is deliberately synchronous: it either installs persona, exact tool
 * restriction and the monotonic delegation / write-scope guards before
 * `agent/session-start`, or throws so the official creation chain rolls the
 * temporary Agent back.
 */

import { AGENT_ID_PATTERN, deriveToolName, hasWriteScope } from './schema.js'
import { readChildIdentity } from './identity.js'
import { writeScopeGuardReason } from './path-policy.js'
import { assertToolSurface, compileAllowlist } from './tool-surface.js'

export const name = 'banbo-main-runtime'
export const inject = ['banboAgents', 'agentPresets', 'tools', 'systemPrompt']

/** One strict config field, generated into each managed preset. */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: '@banbolee/dsh-agents/main-runtime',
    validate(value) {
      const agentId = value?.agentId
      if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) {
        throw new TypeError('banbo-main-runtime config.agentId must match /^[a-z][a-z0-9-]{0,57}$/')
      }
      return { value: { agentId } }
    },
  },
}

/** Synchronous activation failure with stable machine details. */
export class MainActivationError extends Error {
  /** @type {string} */
  code
  /** @type {string | undefined} */
  agentId
  /** @type {string | undefined} */
  presetId
  /** @type {string | undefined} diagnostic only; never authorization. */
  generation

  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'MainActivationError'
    this.code = code
    Object.assign(this, detail)
  }
}

const fail = (service, code, message, detail = {}) => {
  throw new MainActivationError(code, `banbo-agents: ${message}`, {
    generation: service?.generation,
    ...detail,
  })
}

/** Return all live registered names without relying on a private registry view. */
function registeredNames(agent) {
  return new Set(agent.ctx.tools.schemas(agent).map((schema) => schema.name))
}

/** Validate and return one enabled current main definition. */
function requireMain(service, agentId) {
  const policy = service.settings.policy(agentId)
  if (policy.retired === true) {
    fail(service, 'main-retired', `main Agent "${agentId}" was retired; restore its YAML and restart, or create a new Session with another preset`, { agentId })
  }
  if (policy.exists !== true || policy.definition === undefined) {
    fail(service, 'main-missing', `main Agent "${agentId}" is missing from the active catalog; restore its YAML and restart`, { agentId })
  }
  if (policy.definition.main === undefined) {
    fail(service, 'main-form-missing', `Agent "${agentId}" has no main form and cannot own a preset`, { agentId })
  }
  if (policy.effectiveEnabled !== true) {
    fail(service, 'main-disabled', `main Agent "${agentId}" is disabled; set agents.${agentId}.enabled=true (or enable defaults) before creating or resuming this Session`, { agentId })
  }
  return policy.definition
}

/** Require one known inherited tool before handing its name to restrict(). */
function requireRegistered(service, registered, name, agentId) {
  if (registered.has(name)) return name
  fail(
    service,
    'standing-tool-missing',
    `managed preset for "${agentId}" did not register required standing tool "${name}"; complete the bundle restart before using this preset`,
    { agentId },
  )
}

/**
 * Compile the exact top-level surface from current catalog structure.
 *
 * Disabled children remain named and visible by design: settings affect the
 * next execution, and the guard/tool body rejects them with a useful error.
 */
export function buildMainAllowlist(service, agentId, registered) {
  const definition = requireMain(service, agentId)
  const main = definition.main
  const allow = compileAllowlist({
    capabilities: main.tools,
    extraTools: main.extraTools,
    registered,
    // The bundle's own delegation surface is excluded from the ambient grant:
    // those names are not in the capability vocabulary, but they are granted
    // per-child below, and an unauthorised Agent must not even SEE them.
    ownTools: service.delegationTools,
  })

  if (main.maxDepth > 0 && definition.allowedChildren.length > 0) {
    for (const childId of definition.allowedChildren) {
      allow.push(requireRegistered(service, registered, deriveToolName(childId), agentId))
    }
    allow.push(requireRegistered(service, registered, 'delegate_batch', agentId))
  }
  return [...new Set(allow)]
}

/** Resolve a stable `agent_*` ABI name without guessing from labels/personas. */
function recordForTool(service, toolName) {
  return service.abi?.agents?.find((record) => record?.toolName === toolName)
}

/**
 * Runtime second check for only delegation calls.
 *
 * It intentionally leaves ordinary tools alone when settings disable an
 * already-running main Agent (§7.1: no forced termination). Named delegation
 * actions always read current settings and fail closed.
 */
export function delegationGuardReason(service, mainAgentId, execution) {
  const isBatch = execution.name === 'delegate_batch'
  const isNamed = execution.name.startsWith('agent_')
  if (!isBatch && !isNamed) return undefined

  let main
  try {
    main = requireMain(service, mainAgentId)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (main.main.maxDepth <= 0) {
    return `banbo-agents: main Agent "${mainAgentId}" has maxDepth=0 and may not delegate`
  }
  if (isBatch) {
    return main.allowedChildren.length > 0
      ? undefined
      : `banbo-agents: main Agent "${mainAgentId}" has no authorised children for delegate_batch`
  }

  const record = recordForTool(service, execution.name)
  if (record === undefined) {
    return `banbo-agents: delegation tool "${execution.name}" is unknown to the active ABI; complete the bundle restart`
  }
  if (record.retired === true) {
    return `banbo-agents: Agent "${record.id}" was retired because its definition was deleted; restore the YAML and restart`
  }
  if (!main.allowedChildren.includes(record.id)) {
    return `banbo-agents: main Agent "${mainAgentId}" is not authorised to delegate to "${record.id}" under the current catalog`
  }

  const target = service.settings.policy(record.id)
  if (target.retired === true || target.exists !== true || target.definition?.child === undefined) {
    return `banbo-agents: target Agent "${record.id}" is missing, retired, or has no child form; restore its definition and restart`
  }
  if (target.effectiveEnabled !== true) {
    return `banbo-agents: target Agent "${record.id}" is disabled; set agents.${record.id}.enabled=true before delegating`
  }
  return undefined
}

/** Best-effort reverse-order rollback for a synchronous failed installation. */
function rollback(disposers) {
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      disposers[index]()
    } catch {
      // Preserve the activation failure that caused rollback. Cordis still owns
      // the agent scope and will perform final teardown of any stubborn effect.
    }
  }
}

/**
 * Install the activation state into one top-level Agent's own scope.
 * No I/O, promises, model selection or Session mutation occurs here.
 */
export function activateMainAgent(options) {
  const { agent, service, configuredAgentId, composedPreset } = options
  const definition = requireMain(service, configuredAgentId)
  const expectedPreset = definition.main.presetId
  if (composedPreset !== expectedPreset) {
    fail(
      service,
      'preset-mapping-mismatch',
      `preset mapping mismatch: composition reports ${JSON.stringify(composedPreset)} but configured main Agent "${configuredAgentId}" owns ${JSON.stringify(expectedPreset)}; complete the bundle restart`,
      { agentId: configuredAgentId, presetId: composedPreset },
    )
  }

  const persona = service.personas.get(definition.main.persona)
  if (typeof persona !== 'string') {
    fail(
      service,
      'persona-missing',
      `preloaded persona ${JSON.stringify(definition.main.persona)} for main Agent "${configuredAgentId}" is missing; restore it and restart`,
      { agentId: configuredAgentId, presetId: expectedPreset },
    )
  }

  const before = registeredNames(agent)
  // Publish the UNRESTRICTED surface for this preset before narrowing it. This
  // is the only point where the composition's whole registry is observable, and
  // the delegation runtime needs it to compile a child's capabilities: a child's
  // tool surface belongs to the composition, not to the caller's frozen filter
  // (§5.2, §16.5). Best-effort by design — a service without the slot (an older
  // embedder) simply leaves the delegation runtime on its caller-view fallback.
  service.compositionTools?.set(expectedPreset, before)
  const allow = buildMainAllowlist(service, configuredAgentId, before)
  const disposers = []
  try {
    disposers.push(agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: persona,
    }))
    disposers.push(agent.ctx.tools.restrict({ allow }))
    disposers.push(agent.ctx.tools.guard((execution) => delegationGuardReason(service, configuredAgentId, execution)))
    // The path-scoped write guard (§5.2, §16.12). It is registered per agent and
    // reads the definition resolved above — the form this Agent actually runs —
    // so a `writeScope` on `main` confines this Agent's `write`/`edit` to one
    // directory under its session workspace. The child form is scoped where the
    // child is mounted: a delegated child's identity is not observable from the
    // preset scope, so its own activation site owns that registration.
    //
    // Soundness depends on the scoped Agent having NO shell: `exec` would write
    // files without ever calling `write`/`edit`, and no tool-surface guard can
    // see that. Never grant `exec` to a form carrying a `writeScope`.
    disposers.push(agent.ctx.tools.guard((execution) => writeScopeGuardReason(definition.main, execution)))

    const visible = agent.ctx.tools.schemas(agent).map((schema) => schema.name)
    assertToolSurface({ visible, allow })
  } catch (error) {
    rollback(disposers)
    throw error
  }

  return Object.freeze({ allow: Object.freeze([...allow]) })
}

/**
 * The deployment identity line, kept under our OWN section name.
 *
 * The per-agent persona is registered into `deployment:persona-prefix` — the
 * official `applyChildComposition` does exactly the same for a delegated child
 * — and a scoped section SHADOWS the same name from an outer scope. Anything
 * parked in that slot is therefore erased for every banbo agent, which is what
 * happened to the identity line our composition template used to carry in
 * `dsh-persona`'s `prefix`. A distinct name is never shadowed, and registering
 * it in the PRESET scope (rather than per agent) is what makes it reach main
 * agents and delegated children alike: a child joins its parent's preset by
 * scope parentage.
 */
export const IDENTITY_SECTION = 'banbo:identity'

/**
 * Exact identity text. `{{model}}` is resolved per assembly by the harness
 * (`dsh-agent-loop` registers the `model` variable from the agent's options),
 * so one registration serves every agent under the preset.
 */
export const IDENTITY_TEXT = 'You are a coding agent powered by the {{model}} model.'

/**
 * Install the identity section for every agent this preset composes.
 *
 * The order is the persona-prefix position, so the line lands where deployment
 * identity belongs; the distinct name decides the tie against
 * `deployment:persona-prefix`, which puts this line first and the agent's own
 * persona immediately after it.
 *
 * @param ctx - the preset-standing plugin context.
 * @returns the exact Cordis effect disposer.
 */
export function installIdentitySection(ctx) {
  return ctx.systemPrompt.section({
    name: IDENTITY_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: IDENTITY_TEXT,
  })
}

/**
 * Re-install a resumed delegated child's `writeScope` guard (§16.12).
 *
 * A one-shot child never gets a sidecar, so this is a no-op for it — that child
 * is guarded at delegation time, on the `SubagentRun`'s own local Agent. A
 * continuable child always has one, which is what makes this path work after the
 * harness disposes and rebuilds it.
 *
 * A child that cannot be identified, or whose form declares no usable scope, is
 * left alone rather than failing the resume: a bad sidecar must never make a
 * child un-resumable. That is a statement about DATA conditions only — a
 * throwing `tools.guard` is a harness-shape change, and it propagates out of
 * this listener, which vetoes publication on purpose.
 */
function guardResumedChildScope(agent, service) {
  const identity = readChildIdentity(service.rootDir, agent.id)
  if (identity === undefined) return
  const form = service.definitions.get(identity.agentId)?.child
  if (!hasWriteScope(form)) return
  agent.ctx.tools.guard((execution) => writeScopeGuardReason(form, execution))
}

/** Preset-standing plugin entry. */
export default function apply(ctx, config) {
  installIdentitySection(ctx)
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') {
      // §16.12: a delegated child must be guarded on EVERY materialization, not
      // only when the delegation created it. The harness disposes an idle
      // continuable activation and rebuilds the child from its persisted
      // descriptor on the next `send_message`, and that rebuild re-applies only
      // the persona and tool filter — so a guard installed at creation time is
      // gone, leaving a durable child with `write`/`edit` and no scope. A child
      // cannot be identified from its session header, so the sidecar written by
      // the delegation runtime is the sanctioned source (§11.1.1).
      guardResumedChildScope(agent, ctx.banboAgents)
      return
    }
    const composedPreset = ctx.agentPresets.composedPreset(agent.ctx)
    activateMainAgent({
      agent,
      service: ctx.banboAgents,
      configuredAgentId: config.agentId,
      composedPreset,
    })
  })
}

apply.inject = inject
apply.Config = Config
