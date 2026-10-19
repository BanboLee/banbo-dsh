/**
 * Per-preset top-level activation gate — docs/agents-plugin-plan.md §9.3/§9.4.
 *
 * The Host preloads every byte this module consumes. The `agent/created`
 * listener is deliberately synchronous: it either installs persona, exact tool
 * restriction and the monotonic delegation / write-scope guards before
 * `agent/session-start`, or throws so the official creation chain rolls the
 * temporary Agent back.
 */

import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'

import { AGENT_ID_PATTERN, deriveToolName, hasWriteScope } from './schema.js'
import {
  childAuthority,
  emptyComposition,
  readChildAuthority,
  writeChildAuthority,
} from './child-authority.js'
import { takeChildComposition } from './child-composition.js'
import { readChildIdentity, readChildIdentityState } from './identity.js'
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

/**
 * Apply one delegated child's composition in its creation window — on EVERY
 * materialization, cold resumes included.
 *
 * Two sources, in this order:
 *
 *   1. **the in-memory handoff** (`child-composition.js`) for a child this
 *      process is creating right now. This is the only window in which the
 *      persona and restriction can be applied before the child's first model
 *      request, and the official manager no longer does it for us (0.2.1 dropped
 *      `persona`/`toolFilter` from the start request AND from the descriptor).
 *   2. **the child's own session log** (`child-authority.js`) for a child being
 *      rebuilt from persisted state. The record is written here, in window (1),
 *      so it is always present for a banbo child.
 *
 * Fail-closed rules, which are why this is one function rather than two paths:
 *
 *   - a child whose identity sidecar exists (i.e. a banbo continuable child) but
 *     whose authority record is `invalid` gets {@link emptyComposition}: no
 *     persona and an EMPTY allowlist. A corrupt record must never read as "no
 *     restriction";
 *   - a child with NO record and NO sidecar is not this bundle's child and is
 *     left untouched — inventing a restriction there would break ordinary
 *     subagents;
 *   - a `writeScope` form is guarded here too, so a resumed child regains its
 *     path policy along with its surface.
 *
 * @param agent - the agent being announced.
 * @param service - the published catalog service.
 * @param sessionTools - the official `@deepseek-ai/dsh-session` helpers.
 * @returns whether this bundle composed the child.
 */
function composeDelegatedChild(agent, service, sessionTools, configuredMainAgentId) {
  const parked = takeChildComposition(agent.id)
  if (parked !== undefined) {
    // A FRESH child. The definition is re-read from the CURRENT catalog: a child
    // whose definition has been deleted or disabled between preparation and
    // materialization must not be published with a surface nothing authorises.
    const definition = service.definitions.get(parked.agentId)
    const policy = service.settings?.policy?.(parked.agentId)
    const authorised = definition !== undefined
      && policy?.exists === true
      && policy?.retired !== true
      && policy?.effectiveEnabled === true
    if (!authorised) {
      // Fail closed: an empty surface and no persona. The child was authorised a
      // moment ago under a definition that no longer exists, so the only safe
      // composition is the narrowest one.
      applyComposition(agent, emptyComposition(parked.agentId), undefined)
      return true
    }
    // Persist BEFORE restricting: the record is what a later cold resume reads,
    // and a child must never be published with an authority that would not
    // survive its own restart. `mainAgentId` is the OWNING main, from the caller
    // identity the delegation resolved — not the child definition's id.
    writeChildAuthority(
      agent.session,
      childAuthority({
        agentId: parked.agentId,
        mainAgentId: parked.mainAgentId,
        persona: parked.persona,
        toolFilter: parked.toolFilter,
      }),
      sessionTools.appendPluginRecord,
    )
    applyComposition(agent, { persona: parked.persona, toolFilter: parked.toolFilter }, definition.child)
    return true
  }

  // Not created by this process: a cold materialization, or a child that is not
  // ours at all.
  //
  // OWNERSHIP is decided by TWO independent facts, and BOTH are required to call
  // a child "not ours":
  //
  //   - the durable authority record in the child's own log;
  //   - the durable identity sidecar the delegation runtime wrote.
  //
  // A missing record with a PRESENT sidecar is a known banbo child whose
  // authority was lost (an older build, a truncated log, a migration) — that must
  // fail CLOSED, not fall through to "third-party child, leave it alone". Only
  // when the sidecar is genuinely ABSENT is the child not this bundle's, and only
  // then is it left untouched.
  //
  // The sidecar read is TRI-STATE for exactly this reason: a corrupt or
  // unreadable sidecar means a record exists that cannot be trusted, which is
  // "known child, fail closed" — never "absent, leave it alone". Collapsing those
  // into one `undefined` is how a damaged sidecar becomes an unrestricted child.
  const sidecar = readChildIdentityState(service.rootDir, agent.id)
  const identity = sidecar.state === 'valid' ? sidecar.identity : undefined
  const read = readChildAuthority(agent.session, sessionTools.pluginRecordOf)

  if (read.state === 'absent' && sidecar.state === 'absent') {
    // Neither fact exists: a subagent this bundle never created (or one whose
    // data is entirely gone). Restricting it would change another plugin's
    // behaviour, so it is left as authored.
    return false
  }

  if (read.state === 'absent') {
    // The sidecar EXISTS (valid or invalid) but there is no authority record: the
    // authorisation cannot be reconstructed, so the surface narrows to nothing.
    const agentId = identity?.agentId ?? 'unknown'
    applyComposition(agent, emptyComposition(agentId), service.definitions.get(agentId)?.child)
    return true
  }

  if (read.state === 'invalid') {
    // A record of this type exists but does not validate. Never "no restriction".
    const agentId = identity?.agentId ?? 'unknown'
    applyComposition(agent, emptyComposition(agentId), service.definitions.get(agentId)?.child)
    return true
  }

  // `valid`: the record must be BOUND to the durable identity and to the live
  // main before its allowlist may be applied. Each check below is an independent
  // way a record could have been transplanted, replayed, or left behind by a
  // different release:
  //
  //   1. a sidecar must exist (a valid record with no identity is unbound);
  //   2. `authority.agentId` must equal `sidecar.agentId` — otherwise the record
  //      belongs to a different child definition;
  //   3. `authority.mainAgentId` must equal `sidecar.mainAgentId` — otherwise the
  //      record was written under a different owning main;
  //   4. that same main must be the CONFIGURED main of this process — otherwise a
  //      record from another deployment would be honoured;
  //   5. the definition must still exist and be enabled.
  //
  // Any failure is `emptyComposition`: the narrowest surface, not the recorded one.
  const authority = read.authority
  // The reliable source of "which main owns this preset" is the ROW config that
  // mounted this runtime, not a field on the shared catalog service (which is
  // one object serving every preset).
  const configuredMain = configuredMainAgentId
  const definition = identity === undefined ? undefined : service.definitions.get(identity.agentId)
  const policy = identity === undefined ? undefined : service.settings?.policy?.(identity.agentId)
  const bound = identity !== undefined
    && authority.agentId === identity.agentId
    && authority.mainAgentId === identity.mainAgentId
    && identity.mainAgentId === configuredMain
    && definition !== undefined
    && policy?.exists === true
    && policy?.retired !== true
    && policy?.effectiveEnabled === true

  if (!bound) {
    const agentId = identity?.agentId ?? authority.agentId
    applyComposition(agent, emptyComposition(agentId), service.definitions.get(agentId)?.child)
    return true
  }

  applyComposition(agent, { persona: authority.persona, toolFilter: { allow: authority.allow } }, definition.child)
  return true
}

/**
 * Install one composition on an agent's own context: persona section, exact tool
 * restriction, and the write-scope guard for a form that declares one.
 *
 * Kept separate so the fresh-creation path and the cold-resume path cannot drift
 * apart: a restriction applied on one and forgotten on the other is exactly the
 * widening this file exists to prevent.
 *
 * @param agent - the agent to compose.
 * @param composition - `persona` text and `toolFilter.allow`.
 * @param form - the definition's `child` form, for the write-scope decision.
 */
function applyComposition(agent, composition, form) {
  agent.ctx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: composition.persona,
  })
  agent.ctx.tools.restrict(composition.toolFilter)
  if (hasWriteScope(form)) agent.ctx.tools.guard((execution) => writeScopeGuardReason(form, execution))
}

/** Preset-standing plugin entry. */
export default function apply(ctx, config) {
  installIdentitySection(ctx)
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') {
      // §16.12: a delegated child must be composed on EVERY materialization, not
      // only when the delegation created it. The harness disposes an idle
      // continuable activation and rebuilds the child from its persisted
      // descriptor on the next `send_message` — and in 0.2.1 that descriptor no
      // longer carries the persona or the tool filter at all, so a cold child
      // would otherwise come back with the preset's full surface.
      //
      // `composeDelegatedChild` owns both directions and the fail-closed rule
      // between them: the in-memory handoff for a fresh child (it writes the
      // durable record as it applies the composition), the child's own session
      // log for a resumed one, and an EMPTY surface when the record exists but
      // cannot be trusted.
      if (composeDelegatedChild(agent, ctx.banboAgents, { appendPluginRecord, pluginRecordOf }, config.agentId)) return
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
