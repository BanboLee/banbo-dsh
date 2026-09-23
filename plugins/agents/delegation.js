/**
 * Named-agent delegation runtime — docs/agents-plugin-plan.md §10/§11.1.1.
 *
 * This module keeps policy preparation synchronous and detached from lifecycle
 * ownership. `prepareDelegation()` answers whether one exact live caller may
 * create one target now and builds the immutable persona/tool/model snapshot.
 * Later layers own budgets, SubagentRun holders, deadlines, jobs and batch.
 */

import { randomUUID } from 'node:crypto'

import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildDepth } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RootBudgetRegistry } from './budget.js'
import { DEADLINE_REACHED, raceWithDeadline } from './deadline.js'
import { HolderRegistry } from './holder-registry.js'
import {
  CHILD_IDENTITY_VERSION,
  readChildIdentity,
  rollbackChildIdentity,
  writeChildIdentity,
} from './identity.js'
import { AGENT_ID_PATTERN, deriveToolName, hasWriteScope } from './schema.js'
import { writeScopeGuardReason } from './path-policy.js'
import { compileAllowlist } from './tool-surface.js'

/** Stable in-process provider installed by the official base composition. */
export const DELEGATION_PROVIDER = 'spawn'
export const name = 'banbo-delegation'
export const inject = ['banboAgents', 'subagents', 'jobs', 'tools', 'agentPresets']

export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: '@banbolee/dsh-agents/delegation',
    validate(value) {
      const agentId = value?.agentId
      if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) {
        throw new TypeError('banbo-delegation config.agentId must match /^[a-z][a-z0-9-]{0,57}$/')
      }
      return { value: { agentId } }
    },
  },
}

/** Policy/identity failure with stable fields. */
export class DelegationError extends Error {
  /** @type {string} */
  code
  /** @type {string | undefined} */
  agentId
  /** @type {string | undefined} */
  targetAgentId
  /** @type {string | undefined} diagnostic only; never authorization. */
  generation

  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'DelegationError'
    this.code = code
    Object.assign(this, detail)
  }
}

const REJECTION_REASONS = Object.freeze({
  'target-disabled': 'disabled',
  'caller-disabled': 'disabled',
  'main-disabled': 'disabled',
  'edge-unauthorised': 'edge-denied',
  'depth-exceeded': 'depth',
  'concurrency-exceeded': 'budget',
  retired: 'retired',
  'target-retired': 'retired',
  'batch-target-retired': 'retired',
  'identity-unknown': 'identity-missing',
  'identity-version-unsupported': 'identity-missing',
  'caller-identity-stale': 'identity-missing',
})

/** Map only the six documented denial classes; unrelated faults are not mislabeled. */
export function rejectionReason(error) {
  return REJECTION_REASONS[error?.code]
}

const runtimeNow = (runtime) => runtime.now?.() ?? Date.now()

function logInfo(runtime, event, fields) {
  runtime.logger?.info?.(`banbo-agents: ${event}`, fields)
}

function logRejected(runtime, agentId, error) {
  const reason = rejectionReason(error)
  if (reason === undefined) return
  logInfo(runtime, 'delegation/rejected', { agentId, reason })
}

function observationMap(runtime) {
  if (runtime.observations === undefined) runtime.observations = new Map()
  return runtime.observations
}

function logDelegationStart(runtime, prepared, childId, mode, background) {
  const fields = {
    rootSessionId: prepared.callerIdentity.rootSessionId,
    childId,
    agentId: prepared.targetAgentId,
    mode,
    depth: prepared.childDepth,
    background,
  }
  observationMap(runtime).set(childId, { ...fields, startedAt: runtimeNow(runtime) })
  logInfo(runtime, 'delegation/start', fields)
}

function logDelegationEnd(runtime, childId, stopReason, outcome) {
  const observation = observationMap(runtime).get(childId)
  if (observation === undefined) return false
  observationMap(runtime).delete(childId)
  const { startedAt, ...fields } = observation
  logInfo(runtime, 'delegation/end', {
    ...fields,
    stopReason,
    durationMs: Math.max(0, runtimeNow(runtime) - startedAt),
    outcome,
  })
  return true
}

const fail = (service, code, message, detail = {}) => {
  throw new DelegationError(code, `banbo-agents: ${message}`, {
    generation: service?.generation,
    ...detail,
  })
}

/** Read one ABI record by id without deriving authority from its tool name. */
function abiRecord(service, agentId) {
  return service.abi?.agents?.find((record) => record?.id === agentId)
}

/** Validate the current top-level mapping shared by roots and children. */
function requireCurrentMain(service, configuredMainAgentId, presetId) {
  const policy = service.settings.policy(configuredMainAgentId)
  const main = policy.definition?.main
  if (policy.retired === true || policy.exists !== true || main === undefined) {
    fail(
      service,
      'main-mapping-missing',
      `cannot resolve active main Agent "${configuredMainAgentId}" for preset ${JSON.stringify(presetId)}; restore its YAML and complete the restart`,
      { agentId: configuredMainAgentId },
    )
  }
  if (policy.effectiveEnabled !== true) {
    fail(service, 'main-disabled', `main Agent "${configuredMainAgentId}" is disabled under current settings`, {
      agentId: configuredMainAgentId,
    })
  }
  if (main.presetId !== presetId) {
    fail(
      service,
      'preset-mapping-mismatch',
      `preset ${JSON.stringify(presetId)} no longer maps to main Agent "${configuredMainAgentId}" (current presetId: ${JSON.stringify(main.presetId)}); complete the bundle restart`,
      { agentId: configuredMainAgentId },
    )
  }
  return policy.definition
}

/** Validate a child identity against current structural/settings policy. */
function requireCurrentCaller(service, identity, configuredMainAgentId, composedPreset) {
  if (identity.version !== CHILD_IDENTITY_VERSION) {
    fail(service, 'identity-version-unsupported', `cannot confirm child Agent identity: unsupported version ${String(identity.version)}`, {
      agentId: identity.agentId,
    })
  }
  if (identity.mainAgentId !== configuredMainAgentId || identity.presetId !== composedPreset) {
    fail(
      service,
      'identity-mapping-mismatch',
      `child identity does not match the live preset/main mapping (identity preset=${JSON.stringify(identity.presetId)}, main=${JSON.stringify(identity.mainAgentId)}); restore the matching YAML and complete the restart`,
      { agentId: identity.agentId },
    )
  }
  requireCurrentMain(service, configuredMainAgentId, composedPreset)

  const policy = service.settings.policy(identity.agentId)
  if (policy.retired === true || policy.exists !== true || policy.definition?.child === undefined) {
    fail(
      service,
      'caller-identity-stale',
      `cannot confirm child Agent identity for "${identity.agentId}" under the active catalog; delegation is disabled for this child. Restore its YAML and restart, or create a new child`,
      { agentId: identity.agentId },
    )
  }
  if (policy.effectiveEnabled !== true) {
    fail(service, 'caller-disabled', `child Agent "${identity.agentId}" is disabled under current settings and may not delegate`, {
      agentId: identity.agentId,
    })
  }
  return identity
}

/**
 * Resolve a caller's business identity without labels, personas or tool-set
 * heuristics. Root identity comes from the configured standing preset; child
 * identity comes only from the exact live map or durable sidecar.
 */
export function resolveCallerIdentity(options) {
  const {
    parent,
    service,
    configuredMainAgentId,
    composedPreset,
    liveIdentities,
  } = options

  if (parent.session.header.origin !== 'subagent') {
    requireCurrentMain(service, configuredMainAgentId, composedPreset)
    return Object.freeze({
      version: CHILD_IDENTITY_VERSION,
      agentId: configuredMainAgentId,
      mainAgentId: configuredMainAgentId,
      presetId: composedPreset,
      rootSessionId: parent.id,
      generation: service.generation,
    })
  }

  const identity = liveIdentities.get(parent.id) ?? readChildIdentity(service.rootDir, parent.id)
  if (identity === undefined) {
    fail(
      service,
      'identity-unknown',
      `cannot confirm child Agent identity for session "${parent.id}"; delegation is disabled. Restore its sidecar/YAML and restart, or create a new child`,
    )
  }
  return Object.freeze(requireCurrentCaller(
    service,
    identity,
    configuredMainAgentId,
    composedPreset,
  ))
}

/** Require one known standing tool before freezing it into a child descriptor. */
function requireRegistered(service, registered, name, targetAgentId) {
  if (registered.has(name)) return name
  fail(
    service,
    'standing-tool-missing',
    `managed preset did not register required standing tool "${name}" while preparing Agent "${targetAgentId}"; complete the bundle restart`,
    { targetAgentId },
  )
}

/** Validate the target definition/settings/ABI contract. */
function requireTarget(service, targetAgentId) {
  const published = abiRecord(service, targetAgentId)
  if (published?.retired === true) {
    fail(service, 'target-retired', `target Agent "${targetAgentId}" was retired because its definition was deleted`, { targetAgentId })
  }
  const policy = service.settings.policy(targetAgentId)
  if (policy.exists !== true || policy.definition === undefined) {
    fail(service, 'target-unknown', `target Agent "${targetAgentId}" is not in the active catalog`, { targetAgentId })
  }
  if (policy.definition.child === undefined) {
    fail(service, 'target-main-only', `target Agent "${targetAgentId}" has no child form and cannot be delegated to`, { targetAgentId })
  }
  if (policy.effectiveEnabled !== true) {
    fail(service, 'target-disabled', `target Agent "${targetAgentId}" is disabled under current settings`, { targetAgentId })
  }
  return { definition: policy.definition, model: policy.model }
}

/** Convert current child model policy to an AgentOptions override. */
function agentOptionsFor(model) {
  if (model === undefined || model.default === true) return undefined
  return {
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
  }
}

/**
 * Authorize one direct edge and freeze its child composition/request facts.
 * `resolveChildDepth` remains the sole depth algorithm and final cap check.
 */
export function prepareDelegation(options) {
  const {
    parent,
    targetAgentId,
    service,
    configuredMainAgentId,
    composedPreset,
    liveIdentities,
    registered,
  } = options

  const callerIdentity = resolveCallerIdentity({
    parent,
    service,
    configuredMainAgentId,
    composedPreset,
    liveIdentities,
  })
  const mainDefinition = requireCurrentMain(service, callerIdentity.mainAgentId, callerIdentity.presetId)
  const callerPolicy = service.settings.policy(callerIdentity.agentId)
  const callerDefinition = callerPolicy.definition
  if (callerDefinition === undefined || !callerDefinition.allowedChildren.includes(targetAgentId)) {
    fail(
      service,
      'edge-unauthorised',
      `Agent "${callerIdentity.agentId}" is not authorised by current allowedChildren to delegate to "${targetAgentId}"`,
      { agentId: callerIdentity.agentId, targetAgentId },
    )
  }

  const { definition: target, model } = requireTarget(service, targetAgentId)
  let childDepth
  try {
    childDepth = resolveChildDepth(parent, mainDefinition.main.maxDepth)
  } catch (error) {
    fail(
      service,
      'depth-exceeded',
      `delegating from Agent "${callerIdentity.agentId}" to "${targetAgentId}" exceeds the main preset absolute depth cap ${mainDefinition.main.maxDepth}: ${String(error?.message ?? error)}`,
      { agentId: callerIdentity.agentId, targetAgentId },
    )
  }
  const remainingDepth = mainDefinition.main.maxDepth - childDepth
  const allow = compileAllowlist({
    capabilities: target.child.tools,
    extraTools: target.child.extraTools,
    registered,
  })
  if (remainingDepth > 0 && target.allowedChildren.length > 0) {
    for (const childId of target.allowedChildren) {
      allow.push(requireRegistered(service, registered, deriveToolName(childId), targetAgentId))
    }
    allow.push(requireRegistered(service, registered, 'delegate_batch', targetAgentId))
  }

  const persona = service.personas.get(target.child.persona)
  if (typeof persona !== 'string') {
    fail(service, 'target-persona-missing', `preloaded persona ${JSON.stringify(target.child.persona)} for target Agent "${targetAgentId}" is missing`, {
      targetAgentId,
    })
  }

  return Object.freeze({
    callerIdentity,
    targetAgentId,
    targetDefinition: target,
    childDepth,
    remainingDepth,
    maxDepth: mainDefinition.main.maxDepth,
    persona,
    toolFilter: Object.freeze({ allow: Object.freeze([...new Set(allow)]) }),
    agentOptions: agentOptionsFor(model),
  })
}

/**
 * Build the public official one-shot request from prepared immutable policy.
 *
 * The label is display-only (§11.1.1): it carries the target's `displayName`
 * for the subagent list, falling back to the raw id, and is never parsed for
 * identity.
 */
export function buildDelegationRequest(prepared, options) {
  return Object.freeze({
    label: `${prepared.targetDefinition.displayName ?? prepared.targetAgentId}: ${options.description}`,
    prompt: Object.freeze([{ type: 'text', text: options.prompt }]),
    parent: options.parent,
    signal: options.signal,
    maxDepth: prepared.maxDepth,
    toolFilter: prepared.toolFilter,
    persona: prepared.persona,
    ...(prepared.agentOptions === undefined ? {} : { agentOptions: prepared.agentOptions }),
  })
}

/**
 * Deadline plumbing. `runtime.delay` is the tests' injectable fake clock; in
 * production it is `undefined`, so `raceWithDeadline` arms an `unref`ed timer
 * and disarms it the moment the race settles.
 */
export { DEADLINE_REACHED } from './deadline.js'

/** Flatten only model-authored text blocks for tool/job output. */
function outputText(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Construct the plugin identity shared by sidecars and the one-shot live map. */
function childIdentity(prepared, service) {
  return Object.freeze({
    version: CHILD_IDENTITY_VERSION,
    agentId: prepared.targetAgentId,
    mainAgentId: prepared.callerIdentity.mainAgentId,
    presetId: prepared.callerIdentity.presetId,
    rootSessionId: prepared.callerIdentity.rootSessionId,
    generation: service.generation,
  })
}

/** Read the owning main budget fixed in this process's startup catalog. */
function mainBudget(service, mainAgentId) {
  const main = service.definitions.get(mainAgentId)?.main
  if (main === undefined) {
    fail(service, 'main-budget-missing', `main Agent "${mainAgentId}" has no active budget; restore its definition and restart`, { agentId: mainAgentId })
  }
  return main.budget
}

/** Promise resolving once one caller cancellation is requested. */
function abortPromise(signal) {
  if (signal.aborted) return Promise.resolve({ kind: 'cancel', reason: signal.reason })
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ kind: 'cancel', reason: signal.reason }), { once: true })
  })
}

/** Map an official terminal result to the canonical foreground return. */
function foregroundResult(prepared, childId, result) {
  const text = outputText(result.output)
  if (result.stopReason === 'completed') {
    return {
      kind: 'foreground',
      agentId: prepared.targetAgentId,
      childId,
      status: text === '' ? 'empty' : 'completed',
      result: text,
      stopReason: result.stopReason,
    }
  }
  return {
    kind: 'foreground',
    agentId: prepared.targetAgentId,
    childId,
    status: 'failed',
    result: text,
    stopReason: result.stopReason,
    error: result.diagnostic ?? result.stopReason,
  }
}

/** Map one official result to the jobs terminal contract. */
function backgroundOutcome(result) {
  if (result.stopReason === 'completed') {
    return { status: 'completed', output: outputText(result.output) }
  }
  if (result.stopReason === 'aborted' && result.diagnostic === undefined) return { status: 'killed' }
  return {
    status: 'failed',
    detail: result.diagnostic === undefined
      ? result.stopReason
      : `${result.stopReason}; diagnostic: ${result.diagnostic}`,
  }
}

/**
 * Cancel one holder and give disposal one bounded grace. A holder that misses
 * grace stays in the registry; its identity cleanup remains attached to the
 * eventual settlement instead of being claimed early.
 */
async function cancelAndDrain(runtime, holder, graceMs, reason) {
  holder.cancel(reason)
  const settlement = holder.settle()
  const outcome = await raceWithDeadline(graceMs, runtime.delay, [
    settlement.then(() => 'settled', () => 'deferred'),
  ])
  return outcome === DEADLINE_REACHED ? 'deferred' : outcome
}

/**
 * Attach live-map cleanup to the real settlement boundary exactly once.
 *
 * The observation entry is NOT dropped here: `logDelegationEnd` reads it to
 * build the end record, and this settlement can resolve before that call. Each
 * path's own `finally` drops it instead, which also covers a rejected
 * `SubagentRun.result` — the case that used to leak one entry per
 * infrastructure fault (§11.1.1 rule 3).
 */
function cleanupOneShotOnSettlement(runtime, holder, childId, lease) {
  const settlement = holder.settle()
  settlement.then(() => {
    runtime.liveIdentities.delete(childId)
  }, () => {})
  settlement.finally(() => {
    lease.release()
  }).catch(() => {})
  return settlement
}

/**
 * Enforce a scoped child form's `writeScope` on the CHILD's own tool layer
 * (§16.12).
 *
 * This covers the ONE-SHOT child, which never gets a sidecar and so cannot be
 * re-identified later. A continuable child is covered by the `agent/created`
 * listener in `main-runtime`, which reinstalls the guard on every
 * materialization — including the rebuild that follows an idle continuable
 * activation being disposed. Registering here as well is harmless (two guards,
 * same rule) and keeps the one-shot path fail-closed even if that listener never
 * sees the child.
 *
 * A child's definition cannot be recovered from its session header — the header
 * carries the CALLER's preset, not the child's agent id — so it comes from the
 * `prepared` record this delegation already holds. Identity is never guessed
 * from a label, a persona or a tool set (§11.1.1).
 *
 * Call it only where a throw unwinds correctly: never after publication outside
 * the owning try, and never inside a catch that means "creation failed".
 */
function guardChildWriteScope(prepared, child) {
  const form = prepared.targetDefinition.child
  if (child === undefined || !hasWriteScope(form)) return
  child.ctx.tools.guard((execution) => writeScopeGuardReason(form, execution))
}

/** Start one published one-shot run inside an already-owned holder. */
async function startOneShot(runtime, prepared, options, holder, lease) {
  const request = buildDelegationRequest(prepared, {
    parent: options.parent,
    prompt: options.prompt,
    description: options.description,
    signal: holder.signal,
  })
  let run
  try {
    holder.beginStart()
    run = await runtime.subagents.start(DELEGATION_PROVIDER, request)
  } catch (error) {
    holder.failStart(error)
    await holder.settle()
    lease.release()
    throw error
  }
  // Installed AFTER the run is published but OUTSIDE the try above, and that
  // placement is load-bearing in both directions. Inside the try it would take
  // the "creation failed" path, whose `settle()` disposes a holder that never
  // attached and therefore leaks the live child. After `holder.attach` it would
  // be worse still: `failStart` throws once a run is attached, so the cleanup
  // below could never run. A throw here is a harness-shape change rather than a
  // data condition, and the run is already live, so it must be disposed by hand
  // — the holder cannot do it.
  try {
    guardChildWriteScope(prepared, run.localAgent)
  } catch (error) {
    // `failStart` first: the holder is still start-pending, and only that (or
    // `attach`) resolves its publication — without it `settle()` waits forever.
    // It is legal here precisely because the run was never attached.
    holder.failStart(error)
    try {
      // Unbounded on purpose, and unlike the deadline paths: `dispose()` cancels
      // first (abort + machine.cancel + whenIdle), so it settles unless the
      // child ignores cancellation entirely. The holder and the slot are
      // released below either way, and this path only runs when installing the
      // guard throws, which is a harness-shape change rather than a data
      // condition.
      await run.dispose()
    } catch {
      // The run is already live; a failing dispose must not mask the original
      // guard error, and the holder cannot retry it (it never attached).
    }
    runtime.liveIdentities.delete(run.id)
    await holder.settle()
    lease.release()
    throw error
  }
  holder.attach(run)
  runtime.liveIdentities.set(run.id, childIdentity(prepared, runtime.service))
  logDelegationStart(runtime, prepared, run.id, 'one-shot', options.runInBackground === true)
  return run
}

/** Foreground one-shot with mandatory deadline and bounded cleanup. */
async function runForeground(runtime, prepared, options, holder, lease, budget) {
  const run = await startOneShot(runtime, prepared, options, holder, lease)
  try {
    const terminal = await raceWithDeadline(budget.foregroundDeadlineMs, runtime.delay, [
      holder.result.then((result) => ({ kind: 'result', result })),
      abortPromise(options.signal),
    ])

    if (terminal === DEADLINE_REACHED || terminal.kind !== 'result') {
      const settled = await cancelAndDrain(
        runtime,
        holder,
        budget.drainGraceMs,
        terminal === DEADLINE_REACHED ? 'foreground-deadline' : 'caller-cancelled',
      )
      if (settled === 'settled') {
        runtime.liveIdentities.delete(run.id)
        lease.release()
      } else {
        // The deadline terminal releases width capacity even when physical
        // cleanup must stay registry-owned; otherwise one hung provider could
        // permanently exhaust every root slot.
        lease.release()
        cleanupOneShotOnSettlement(runtime, holder, run.id, lease)
      }
      const status = settled === 'settled' ? 'cancel_requested' : 'cleanup_deferred'
      logDelegationEnd(runtime, run.id, 'aborted', status)
      return {
        kind: 'foreground',
        agentId: prepared.targetAgentId,
        childId: run.id,
        status,
        result: '',
      }
    }

    const settlement = cleanupOneShotOnSettlement(runtime, holder, run.id, lease)
    await settlement
    const result = foregroundResult(prepared, run.id, terminal.result)
    logDelegationEnd(runtime, run.id, terminal.result.stopReason, result.status)
    return result
  } finally {
    // The official `SubagentRun.result` may reject on an infrastructure fault
    // the seam cannot express as a stop reason. That rejection would otherwise
    // short-circuit every cleanup step above and leak the official run, the
    // holder, the live identity and the concurrency lease. This call is
    // idempotent, so the normal and deadline terminals are unaffected. The
    // observation entry is dropped here too: the normal paths already removed
    // it through `logDelegationEnd`, and the rejection path has no other owner.
    cleanupOneShotOnSettlement(runtime, holder, run.id, lease)
    observationMap(runtime).delete(run.id)
  }
}

/** Background one-shot producer body owned by the official jobs registry. */
async function runBackground(runtime, prepared, options, holder, lease, budget) {
  let run
  try {
    run = await startOneShot(runtime, prepared, options, holder, lease)
  } catch (error) {
    // `startOneShot` already settled the holder and released the lease before
    // rethrowing, so there is nothing published to clean up here.
    return { status: 'failed', detail: String(error?.message ?? error) }
  }
  try {
    const terminal = await raceWithDeadline(budget.backgroundDeadlineMs, runtime.delay, [
      holder.result.then((result) => ({ kind: 'result', result })),
    ])
    if (terminal !== DEADLINE_REACHED && terminal.kind === 'result') {
      const settlement = cleanupOneShotOnSettlement(runtime, holder, run.id, lease)
      await settlement
      const outcome = backgroundOutcome(terminal.result)
      logDelegationEnd(
        runtime,
        run.id,
        terminal.result.stopReason,
        terminal.result.stopReason === 'completed'
          ? (outputText(terminal.result.output) === '' ? 'empty' : 'completed')
          : 'failed',
      )
      return outcome
    }

    const settled = await cancelAndDrain(runtime, holder, budget.drainGraceMs, 'background-deadline')
    if (settled === 'settled') {
      runtime.liveIdentities.delete(run.id)
      lease.release()
      logDelegationEnd(runtime, run.id, 'aborted', 'cancel_requested')
      return { status: 'killed', detail: 'background deadline reached; cancel requested' }
    }
    lease.release()
    cleanupOneShotOnSettlement(runtime, holder, run.id, lease)
    logDelegationEnd(runtime, run.id, 'aborted', 'cleanup_deferred')
    return { status: 'failed', detail: 'background deadline reached; cleanup deferred to HolderRegistry' }
  } catch (error) {
    return { status: 'failed', detail: String(error?.message ?? error) }
  } finally {
    // Same rejection path as the foreground case: the job must still settle its
    // holder, drop the live identity and release its slot. The observation entry
    // has no other owner once the end-log path is skipped.
    cleanupOneShotOnSettlement(runtime, holder, run.id, lease)
    observationMap(runtime).delete(run.id)
  }
}

/** Create one continuable child after atomically provisioning its sidecar. */
async function startContinuable(runtime, prepared, options, lease) {
  const childId = runtime.createChildId()
  const identity = childIdentity(prepared, runtime.service)
  writeChildIdentity(runtime.service.rootDir, childId, identity)
  const base = buildDelegationRequest(prepared, {
    parent: options.parent,
    prompt: options.prompt,
    description: options.description,
    signal: options.signal,
  })
  try {
    const started = await runtime.subagents.startContinuable({
      provider: DELEGATION_PROVIDER,
      label: base.label,
      childId,
      request: {
        prompt: base.prompt,
        parent: base.parent,
        maxDepth: base.maxDepth,
        toolFilter: base.toolFilter,
        persona: base.persona,
        ...(base.agentOptions === undefined ? {} : { agentOptions: base.agentOptions }),
      },
      signal: options.signal,
    })
    runtime.continuableLeases.set(started.childId, lease)
    // No `guardChildWriteScope` here. A continuable child is guarded by the
    // `agent/created` listener in `main-runtime`, which runs during the child's
    // own registration — earlier than this line, and again on every later
    // materialization. Registering here instead would sit inside the catch that
    // means "creation failed", so a throw would delete a LIVE child's sidecar
    // and release its lease while the child kept running unguarded.
    logDelegationStart(runtime, prepared, started.childId, 'continuable', true)
    return {
      kind: 'continuable',
      agentId: prepared.targetAgentId,
      childId: started.childId,
      status: 'started',
    }
  } catch (error) {
    rollbackChildIdentity(runtime.service.rootDir, childId, identity)
    lease.release()
    throw error
  }
}

/** Release the initial continuable round when its `subagent/end` arrives. */
export function releaseContinuableLease(runtime, childId) {
  const lease = runtime.continuableLeases.get(childId)
  if (lease === undefined) return false
  runtime.continuableLeases.delete(childId)
  return lease.release()
}

/**
 * Execute one named delegation under current policy. This function owns all
 * preflight order: visibility/jobs → authorization/depth → atomic budget →
 * sidecar/holder → official start.
 */
async function delegateOneImpl(runtime, options) {
  const toolName = deriveToolName(options.targetAgentId)
  if (runtime.isToolVisible(options.parent, toolName) !== true) {
    fail(runtime.service, 'tool-not-visible', `caller cannot see delegation tool "${toolName}" under its frozen tool filter`, {
      targetAgentId: options.targetAgentId,
    })
  }

  const prepared = prepareDelegation({
    parent: options.parent,
    targetAgentId: options.targetAgentId,
    service: runtime.service,
    configuredMainAgentId: runtime.configuredMainAgentId,
    composedPreset: runtime.composedPreset,
    liveIdentities: runtime.liveIdentities,
    registered: runtime.registered,
  })
  const continuation = prepared.targetDefinition.child.continuation
  const backgroundOneShot = options.runInBackground === true && continuation === 'one-shot'
  if (backgroundOneShot && runtime.jobs === undefined) {
    fail(runtime.service, 'jobs-unavailable', `background one-shot delegation to "${options.targetAgentId}" requires the jobs service before any child can start`, {
      targetAgentId: options.targetAgentId,
    })
  }

  const budget = mainBudget(runtime.service, prepared.callerIdentity.mainAgentId)
  const lease = runtime.budgets.acquire(
    prepared.callerIdentity.rootSessionId,
    1,
    budget.maxConcurrentChildren,
  )

  if (options.runInBackground === true && continuation === 'optional') {
    return startContinuable(runtime, prepared, options, lease)
  }

  // Same display-only label shape as `buildDelegationRequest`, so the subagent
  // list and the background-jobs panel never disagree on casing. The id is
  // still the identity; this string is never parsed for one (§11.1.1).
  const label = `${prepared.targetDefinition.displayName ?? prepared.targetAgentId}: ${options.description}`
  const holder = runtime.holders.reserve(label)
  if (!backgroundOneShot) return runForeground(runtime, prepared, options, holder, lease, budget)

  let starterCalled = false
  try {
    const jobId = runtime.jobs.start({
      kind: 'subagent',
      label,
      owner: options.parent,
      run: () => {
        starterCalled = true
        return {
          cancel: (reason) => holder.cancel(reason ?? 'job-cancelled'),
          done: runBackground(runtime, prepared, options, holder, lease, budget),
        }
      },
    })
    return { kind: 'background', agentId: prepared.targetAgentId, jobId, status: 'started' }
  } catch (error) {
    if (!starterCalled) {
      holder.failStart(error)
      await holder.settle()
      lease.release()
    }
    throw error
  }
}

/** Public single-delegation boundary with privacy-safe rejection telemetry. */
export async function delegateOne(runtime, options) {
  try {
    return await delegateOneImpl(runtime, options)
  } catch (error) {
    logRejected(runtime, options.targetAgentId, error)
    throw error
  }
}

/** Validate batch shape/definition facts before any budget or child start. */
function validateBatchContract(runtime, options, budget) {
  const tasks = options.tasks
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > budget.maxBatchWidth) {
    throw new DelegationError(
      'bad-batch-width',
      `banbo-agents: delegate_batch tasks must contain 1..${budget.maxBatchWidth} items (maxBatchWidth)`,
    )
  }
  if (options.deadlineMs !== undefined && (
    typeof options.deadlineMs !== 'number'
    || !Number.isSafeInteger(options.deadlineMs)
    || options.deadlineMs < 60_000
    || options.deadlineMs > 1_800_000
  )) {
    throw new DelegationError(
      'bad-batch-deadline',
      'banbo-agents: delegate_batch deadlineMs must be a safe integer in the accepted range [60000, 1800000] milliseconds',
    )
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    if (typeof task !== 'object' || task === null || Array.isArray(task)) {
      throw new DelegationError('bad-batch-item', `banbo-agents: delegate_batch tasks[${index}] must be an object`)
    }
    for (const field of ['agentId', 'prompt', 'description']) {
      if (typeof task[field] !== 'string' || task[field] === '') {
        throw new DelegationError('bad-batch-item', `banbo-agents: delegate_batch tasks[${index}].${field} must be a non-empty string`)
      }
    }
    const record = abiRecord(runtime.service, task.agentId)
    const definition = runtime.service.definitions.get(task.agentId)
    if (record?.retired === true) {
      throw new DelegationError('batch-target-retired', `banbo-agents: delegate_batch target "${task.agentId}" is retired because its definition was deleted; restore its YAML and restart, or pick another Agent`, {
        targetAgentId: task.agentId,
      })
    }
    if (definition?.child === undefined) {
      throw new DelegationError('batch-target-invalid', `banbo-agents: delegate_batch target "${task.agentId}" does not exist or has no child form; pick an Agent that has a child form`, {
        targetAgentId: task.agentId,
      })
    }
    // No `continuation` check here. Batch executes EVERY item through
    // `startOneShot`, so a target's `continuation` never applies to this
    // execution mode: an `optional` Agent runs exactly as it does on a
    // foreground single call. The removed `batch-target-continuable` guard was
    // over-broad — it rejected the AGENT, not an execution mode.
  }
}

/** Convert one batch terminal result without merging across items. */
function batchItemFromResult(agentId, result) {
  const text = outputText(result.output)
  if (result.stopReason === 'completed') {
    return text === ''
      ? { agentId, status: 'empty', stopReason: result.stopReason }
      : { agentId, status: 'completed', result: text, stopReason: result.stopReason }
  }
  return {
    agentId,
    status: 'failed',
    ...(text === '' ? {} : { result: text }),
    stopReason: result.stopReason,
    error: result.diagnostic ?? result.stopReason,
  }
}

/** Start and wait for one batch item; every failure materializes into its slot. */
async function runBatchItem(runtime, options, task, item, noOpLease) {
  let prepared
  try {
    prepared = prepareDelegation({
      parent: options.parent,
      targetAgentId: task.agentId,
      service: runtime.service,
      configuredMainAgentId: runtime.configuredMainAgentId,
      composedPreset: runtime.composedPreset,
      liveIdentities: runtime.liveIdentities,
      registered: runtime.registered,
    })
  } catch (error) {
    logRejected(runtime, task.agentId, error)
    item.final = { agentId: task.agentId, status: 'failed', error: String(error?.message ?? error) }
    return item.final
  }

  const holder = runtime.holders.reserve(`${prepared.targetDefinition.displayName ?? task.agentId}: ${task.description}`)
  item.holder = holder
  try {
    const run = await startOneShot(runtime, prepared, {
      parent: options.parent,
      prompt: task.prompt,
      description: task.description,
      runInBackground: false,
      signal: options.signal,
    }, holder, noOpLease)
    item.runId = run.id
    try {
      if (item.closed === true) {
        await holder.settle()
        runtime.liveIdentities.delete(run.id)
        logDelegationEnd(runtime, run.id, 'aborted', item.final?.status ?? 'cleanup_deferred')
        return item.final
      }
      // Observe the official promise directly so a result resolved before the
      // boundary cannot be hidden behind Holder's forwarding microtask.
      const result = await run.result
      item.terminal = batchItemFromResult(task.agentId, result)
      await holder.settle()
      runtime.liveIdentities.delete(run.id)
      logDelegationEnd(runtime, run.id, result.stopReason, item.terminal.status)
      if (item.closed !== true) item.final = item.terminal
      return item.final
    } finally {
      // A rejected `run.result` (infrastructure fault) must not leave the holder
      // retained or the live identity behind. Idempotent on every other path.
      // The observation entry is dropped here because the rejection path never
      // reaches `logDelegationEnd`.
      cleanupOneShotOnSettlement(runtime, holder, run.id, noOpLease)
      observationMap(runtime).delete(run.id)
    }
  } catch (error) {
    if (item.closed === true) return item.final
    item.final = { agentId: task.agentId, status: 'failed', error: String(error?.message ?? error) }
    return item.final
  }
}

/** Top-level batch truth table, deliberately explicit. */
function aggregateBatch(items, cancelled) {
  if (cancelled) return 'cancelled'
  if (items.some((item) => item.status === 'failed')) return 'partial_failed'
  if (items.some((item) => item.status === 'cancel_requested' || item.status === 'cleanup_deferred')) return 'partial_timeout'
  return 'completed'
}

/**
 * Execute a foreground barrier over one-shot children only.
 * Contract failures reject before any start; authorization failures materialize
 * per item; one atomic lease reserves the full width before the first start.
 */
export async function delegateBatch(runtime, options) {
  if (runtime.isToolVisible(options.parent, 'delegate_batch') !== true) {
    fail(runtime.service, 'tool-not-visible', 'caller cannot see delegate_batch under its frozen tool filter')
  }
  const callerIdentity = resolveCallerIdentity({
    parent: options.parent,
    service: runtime.service,
    configuredMainAgentId: runtime.configuredMainAgentId,
    composedPreset: runtime.composedPreset,
    liveIdentities: runtime.liveIdentities,
  })
  const budget = mainBudget(runtime.service, callerIdentity.mainAgentId)
  validateBatchContract(runtime, options, budget)
  const deadlineMs = options.deadlineMs ?? budget.batchDeadlineMs
  const batchLease = runtime.budgets.acquire(
    callerIdentity.rootSessionId,
    options.tasks.length,
    budget.maxConcurrentChildren,
  )
  const noOpLease = Object.freeze({ release: () => false })
  const items = options.tasks.map((task) => ({
    task,
    holder: undefined,
    runId: undefined,
    terminal: undefined,
    final: undefined,
    closed: false,
  }))
  const operations = items.map((item) => runBatchItem(runtime, options, item.task, item, noOpLease))

  const all = Promise.allSettled(operations).then(() => ({ kind: 'all' }))
  const parentCancelled = abortPromise(options.signal)
  let boundary = await raceWithDeadline(deadlineMs, runtime.delay, [all, parentCancelled])
  // Parent cancellation owns the top-level status even when it becomes visible
  // in the same checkpoint as the deadline.
  if (options.signal.aborted) boundary = { kind: 'cancel', reason: options.signal.reason }
  const boundaryKind = boundary === DEADLINE_REACHED ? 'deadline' : boundary.kind

  if (boundaryKind !== 'all') {
    // A run.result and the boundary timer may resolve in the same microtask
    // checkpoint. Let result continuations materialize their exact terminal
    // before deciding which holders are unfinished; this preserves completed
    // items without waiting for any still-pending sibling.
    await Promise.resolve()
    const completed = items.filter((item) => item.terminal !== undefined && item.final === undefined)
    for (const item of completed) item.final = item.terminal
    const unfinished = items.filter((item) => item.final === undefined && item.terminal === undefined)
    for (const item of unfinished) {
      item.closed = true
      item.holder?.cancel(boundaryKind === 'cancel' ? 'parent-cancelled' : 'batch-deadline')
    }
    const settlements = unfinished.map((item) => item.holder?.settle() ?? Promise.resolve())
    const settled = new Set()
    settlements.forEach((promise, index) => {
      Promise.resolve(promise).then(() => settled.add(index), () => {})
    })
    await raceWithDeadline(budget.drainGraceMs, runtime.delay, [Promise.allSettled(settlements)])
    await Promise.resolve()

    unfinished.forEach((item, index) => {
      const didSettle = settled.has(index)
      if (didSettle && item.runId !== undefined) runtime.liveIdentities.delete(item.runId)
      item.final = {
        agentId: item.task.agentId,
        status: didSettle ? 'cancel_requested' : 'cleanup_deferred',
        error: 'this child did not return a result before the batch boundary; cancellation was requested',
      }
      if (item.runId !== undefined) logDelegationEnd(runtime, item.runId, 'aborted', item.final.status)
    })
  }

  batchLease.release()
  const results = items.map((item) => item.final ?? ({
    agentId: item.task.agentId,
    status: 'failed',
    error: 'batch item ended without a terminal result',
  }))
  const status = aggregateBatch(results, boundary.kind === 'cancel')
  logInfo(runtime, 'batch/settled', {
    rootSessionId: callerIdentity.rootSessionId,
    itemCount: options.tasks.length,
    status,
    deadlineMs,
  })
  return { status, deadlineMs, items: results }
}

/** Maximum tool-policy deadline plus the largest supported cleanup grace. */
const NAMED_TOOL_TIMEOUT_MS = 7_200_000 + 300_000 + 1_000
const BATCH_TOOL_TIMEOUT_MS = 1_800_000 + 300_000 + 1_000

const textOutput = {
  schema: { type: /** @type {'json'} */ ('json') },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  },
}

/** Build one current per-call view without copying mutable policy state. */
function runtimeForCall(ctx, shared, configuredMainAgentId, parent) {
  const composedPreset = ctx.agentPresets.composedPreset(parent.ctx)
  return {
    service: ctx.banboAgents,
    subagents: ctx.subagents,
    jobs: ctx.jobs,
    budgets: shared.budgets,
    holders: shared.holders,
    liveIdentities: shared.liveIdentities,
    continuableLeases: shared.continuableLeases,
    observations: shared.observations,
    logger: shared.logger,
    now: shared.now,
    configuredMainAgentId,
    composedPreset,
    registered: compositionToolNames(ctx, parent, composedPreset),
    isToolVisible: (caller, toolName) => ctx.tools.get(toolName, caller) !== undefined,
    createChildId: () => SessionId(randomUUID()),
  }
}

/**
 * Tool names a child's capability must be resolved against.
 *
 * §5.2 makes a child's tool surface a property of the COMPOSITION, not of the
 * caller's frozen filter. Three candidate sources, in order:
 *
 *   1. `service.compositionTools` — the unrestricted surface `main-runtime`
 *      captured at main-agent activation. This is the correct one: nothing
 *      reachable from this plugin's own context sees it, because `dsh-scope`
 *      tags scopes with a MODULE-PRIVATE symbol and a linked install resolves
 *      its own copy of that module (see 3 below).
 *   2. `schemas(parent)` — the caller's view. Resolving here is what the
 *      fallback does, and it is WRONG for an edge whose target needs a tool the
 *      caller lacks (`Planner → Review` needs `exec`, `Review → Research` needs
 *      `web`); those fail closed rather than silently granting less.
 *   3. `schemas(scopeOf(ctx))` — tried and REJECTED. `kScope` is
 *      `Symbol("dsh.scope")`: module-private, NOT `Symbol.for`. When the plugin
 *      resolves a different copy of `@deepseek-ai/dsh-scope` than the harness
 *      (exactly what a `link:` install does) the tag is unreadable, `scopeOf`
 *      returns `undefined`, and the lookup degrades to the GLOBAL layer only —
 *      a plain `Banbo → Explorer` delegation then dies with `capability "read"
 *      ... does not register`. Do not reintroduce it, and do not rely on
 *      cross-package module identity anywhere in this bundle.
 *
 * @param ctx - the preset-standing plugin context.
 * @param parent - the calling agent, used only by the fallback.
 * @param composedPreset - the preset whose composition surface applies.
 * @returns the tool names to resolve capabilities against.
 */
function compositionToolNames(ctx, parent, composedPreset) {
  const captured = ctx.banboAgents?.compositionTools?.get(composedPreset)
  if (captured !== undefined) return captured
  return new Set(ctx.tools.schemas(parent).map((schema) => schema.name))
}

/** One stable named child tool; a retired record remains only an ABI shell. */
function namedTool(ctx, shared, configuredMainAgentId, record) {
  // §5.1/§5.3: each definition carries the authoritative "when to use this
  // expert, and when NOT to" sentence. Until this was rendered, a main agent
  // saw only the tool's mechanical behaviour and had to guess the routing from
  // the tool NAME — which is why a coordinator reviewed work itself instead of
  // calling `agent_review`. Read it from the live definition, not the ABI
  // record, which deliberately does not carry it.
  const guidance = ctx.banboAgents?.definitions?.get(record.id)?.child?.guidance
  // §16.10: the caller cannot judge "will this fit in the foreground?" without
  // knowing the actual deadline, and a real session chose background purely to
  // dodge a deadline it could not see. Render the LIVE value, not a constant —
  // the budget is per-preset configurable.
  const foregroundMs = ctx.banboAgents?.definitions?.get(configuredMainAgentId)?.main?.budget?.foregroundDeadlineMs
  const deadlineClause = typeof foregroundMs === 'number'
    ? ` A FOREGROUND call waits up to ${Math.round(foregroundMs / 60_000)} minutes for the child to settle`
    : ' A FOREGROUND call waits for the child to settle'
  return defineTool({
    name: record.toolName,
    description: record.retired === true
      ? `Retired Agent ${record.id}; calling this compatibility shell always fails until its definition is restored and the Host restarts.`
      : `Delegate one bounded task to the "${record.id}" Agent.${typeof guidance === 'string' && guidance !== '' ? ` ${guidance}` : ''}${deadlineClause} — or for the foreground deadline, after which it returns a cancel_requested or cleanup_deferred status — and is never resumable afterwards: the child ends with the call. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — if you need the result now, stay in the foreground.`,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete task instructions for the child Agent.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Short human-readable task label.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; "I will also do this task myself" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message.',
      },
    },
    output: textOutput,
    timeoutMs: NAMED_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      if (record.retired === true) {
        throw new DelegationError(
          'retired',
          `banbo-agents: Agent "${record.id}" is retired because its definition was deleted; restore its YAML and restart, or stop calling ${record.toolName}`,
          { targetAgentId: record.id },
        )
      }
      return delegateOne(runtimeForCall(ctx, shared, configuredMainAgentId, exec.agent), {
        parent: exec.agent,
        targetAgentId: record.id,
        prompt: args.prompt,
        description: args.description,
        runInBackground: args.run_in_background ?? false,
        signal: exec.signal,
      })
    },
  })
}

/** The foreground-only one-shot batch tool. */
function batchTool(ctx, shared, configuredMainAgentId) {
  return defineTool({
    name: 'delegate_batch',
    description: 'Run 1..maxBatchWidth independent Agent tasks as ONE foreground barrier and return every result in the same turn. Each item runs its target as a ONE-SHOT run regardless of that Agent\'s continuation, so a batch child can never be resumed with send_message afterwards. To keep a child for follow-up work, make a single background agent_<id> call instead — background plus an optional Agent yields a durable child. Every item is terminal on return, including partial failures and deadline cleanup state.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agentId: { type: 'string', required: true },
            prompt: { type: 'string', required: true },
            description: { type: 'string', required: true },
          },
        },
      },
      deadlineMs: {
        type: 'integer',
        description: 'Optional wait boundary in milliseconds; must be in [60000, 1800000].',
      },
    },
    output: textOutput,
    timeoutMs: BATCH_TOOL_TIMEOUT_MS,
    execute(args, exec) {
      return delegateBatch(runtimeForCall(ctx, shared, configuredMainAgentId, exec.agent), {
        parent: exec.agent,
        tasks: args.tasks,
        deadlineMs: args.deadlineMs,
        signal: exec.signal,
      })
    },
  })
}

/** Preset-standing plugin entry: stable ABI registrations and shared owners. */
export default function apply(ctx, config) {
  const shared = {
    budgets: new RootBudgetRegistry(),
    holders: new HolderRegistry({ logger: ctx.logger }),
    liveIdentities: new Map(),
    continuableLeases: new Map(),
    observations: new Map(),
    logger: ctx.logger,
    now: Date.now,
  }

  for (const record of ctx.banboAgents.abi.agents) {
    if (record.hasChild === true || record.retired === true) {
      ctx.tools.register(namedTool(ctx, shared, config.agentId, record))
    }
  }
  ctx.tools.register(batchTool(ctx, shared, config.agentId))

  ctx.on('subagent/end', (info) => {
    if (shared.continuableLeases.has(info.id)) {
      const text = outputText(info.lastAssistantMessage)
      logDelegationEnd(
        shared,
        info.id,
        info.stopReason,
        info.stopReason === 'completed' ? (text === '' ? 'empty' : 'completed') : 'failed',
      )
    }
    releaseContinuableLease(shared, info.id)
  })

  const main = ctx.banboAgents.definitions.get(config.agentId)?.main
  const drainGraceMs = main?.budget?.drainGraceMs ?? 30_000
  ctx.effect(() => async () => {
    await shared.holders.drain({ graceMs: drainGraceMs })
    for (const lease of shared.continuableLeases.values()) lease.release()
    shared.continuableLeases.clear()
  }, 'banbo-delegation:drain')

  return shared
}

apply.inject = inject
apply.Config = Config
