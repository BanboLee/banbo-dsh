/**
 * Diagnostics coordinator: owns the post-execute augment transaction, the
 * operation registry/controller, the absolute-deadline timer with its
 * caller/cleanup relay, the one-shot final stat/deadline/generation commit
 * gate, and the `retiredIo` late-final-stat registry.
 *
 * The coordinator is the single owner of the whole augment lifecycle: every
 * augment is registered in the active registry before any workspace I/O or
 * runtime admission, every terminal path goes through the one-shot gate and
 * retires its taken candidates, and unload strictly runs stop-admission →
 * abort active operations → await all active augment promises → await all
 * retired late-final-stat I/O, with the entry applying `runtime.dispose()`
 * only after both registries are empty.
 *
 * @module dsh-lsp-diagnostics/coordinator
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { compareEligibleTargets, renderDiagnostics, sanitizeDisplayPath } from './render.js'

/**
 * Loose structural seams, mirroring the runtime's own public shapes. The
 * coordinator only consumes the documented surface (`take/isCurrent/
 * retireIfCurrent`, `diagnose/stopAdmission/dispose`, `resolve/stat/
 * contains/fileUrl`); keeping these structural keeps both the real services
 * and the deterministic test fakes assignable.
 * @typedef {object} CollectorSeam
 * @property {(exec: any, target: any, observation: any) => void} observe
 * @property {(exec: any) => import('./collector.js').MutationCandidate[]} take
 * @property {(candidate: any) => boolean} isCurrent
 * @property {(candidate: any) => boolean} retireIfCurrent
 */

/**
 * @typedef {object} RuntimeSeam
 * @property {(candidate: any, canonicalWorkspace: any, canonicalUri: string, signal?: AbortSignal) => Promise<import('./runtime.js').DiagnosisOutcome>} diagnose
 * @property {() => void} stopAdmission
 * @property {() => Promise<void>} dispose
 */

/**
 * @typedef {object} FsSeam
 * @property {(path: string, opts?: { cwd?: string, signal?: AbortSignal }) => Promise<any>} resolve
 * @property {(target: any, signal?: AbortSignal) => Promise<{ version: string, type: string, size?: number } | undefined>} stat
 * @property {(parent: any, child: any) => boolean} contains
 * @property {(target: any) => string} fileUrl
 */

/**
 * @typedef {object} CoordinatorOptions
 * @property {CollectorSeam} collector
 * @property {RuntimeSeam} runtime
 * @property {import('./index.js').PluginConfig} config
 * @property {FsSeam} fs
 */

/**
 * @typedef {object} AugmentOperation
 * @property {AbortController} controller
 * @property {Promise<unknown>} promise
 * @property {() => void} expireDeadline
 * @property {() => void} disposeOperationDeadline
 */

/**
 * @typedef {object} FinalStatRecord
 * @property {boolean} settled
 * @property {{ status: 'fulfilled', value: { version: string, type: string, size?: number } | undefined } | { status: 'rejected', reason: unknown } | undefined} outcome
 * @property {Promise<{ status: 'fulfilled' | 'rejected', value?: any, reason?: unknown }>} promise
 */

/** @typedef {'open' | 'committed' | 'timed-out'} GateState */

/**
 * The accepted post-execute decision surface this plugin reads and extends.
 * @typedef {object} PostExecuteDecision
 * @property {string} kind
 * @property {readonly unknown[]} [additionalContexts]
 */

/**
 * Lowercase last path suffix of a file URL's pathname (`.ts`, `.tsx`, `.go`).
 * Never reads `displayPath` for routing.
 * @param {string} uri - the canonical document URI.
 * @returns {string} the extension including the dot, or '' when absent.
 */
function extensionOf(uri) {
  try {
    const pathname = new URL(uri).pathname
    const slash = pathname.lastIndexOf('/')
    const base = slash === -1 ? pathname : pathname.slice(slash + 1)
    const dot = base.lastIndexOf('.')
    if (dot === -1) return ''
    return base.slice(dot).toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Create the diagnostics coordinator.
 *
 * @param {CoordinatorOptions} options - collector/runtime/config/fs dependencies.
 * @returns {{
 *   listener(exec: unknown, _result: unknown, next: () => Promise<unknown>): Promise<unknown>
 *   stopAdmission(): void
 *   abortActiveOperations(): void
 *   awaitActiveOperations(): Promise<void>
 *   awaitRetiredIo(): Promise<void>
 * }}
 */
export function createDiagnosticsCoordinator({ collector, runtime, config, fs }) {
  /** @type {Set<AugmentOperation>} */
  const activeOperations = new Set()
  /** @type {Set<Promise<unknown>>} */
  const pendingInvocations = new Set()
  /** @type {Set<Promise<unknown>>} */
  const retiredIo = new Set()
  /** @type {AbortController} */
  const cleanupController = new AbortController()
  /** @type {boolean} */
  let admissionOpen = true

  /** Closed extension route derived from the validated server config. */
  const supportedExtensions = new Set()
  for (const server of Object.values(config.servers)) {
    for (const extension of Object.keys(server.extensionToLanguage)) supportedExtensions.add(extension)
  }

  /**
   * Synchronously close admission and abort the coordinator cleanup signal.
   * Also stops the runtime's own admission. Idempotent.
   * @returns {void}
   */
  function stopAdmission() {
    admissionOpen = false
    runtime.stopAdmission()
    cleanupController.abort()
  }

  /**
   * Abort every active augment operation controller. A listener still awaiting
   * downstream `next()` has no plugin-owned cancellation seam, so cleanup owns
   * it by waiting for its tracked settlement instead.
   * @returns {void}
   */
  function abortActiveOperations() {
    for (const operation of activeOperations) {
      if (!operation.controller.signal.aborted) operation.controller.abort()
    }
  }

  /**
   * Await settlement of every active augment and every pending listener
   * invocation, looping until both registries are empty (each tracked promise
   * removes itself in its outermost finally).
   * @returns {Promise<void>}
   */
  async function awaitActiveOperations() {
    while (activeOperations.size > 0 || pendingInvocations.size > 0) {
      const tracked = [
        ...[...activeOperations].map((operation) => operation.promise),
        ...pendingInvocations,
      ]
      await Promise.allSettled(tracked)
    }
  }

  /**
   * Await settlement of every retired late-final-stat record, looping until
   * the registry is empty (each record removes itself in its finalize).
   * @returns {Promise<void>}
   */
  async function awaitRetiredIo() {
    while (retiredIo.size > 0) {
      await Promise.allSettled([...retiredIo])
    }
  }

  /**
   * Register every not-yet-settled final-stat record's promise in `retiredIo`.
   * Synchronous, idempotent, never awaits. Late settlement only has the
   * record's observer/removal side effects.
   * @param {readonly FinalStatRecord[]} records - the taken final-stat records.
   * @returns {void}
   */
  function retireUnsettledFinalStats(records) {
    for (const record of records) {
      if (!record.settled) retiredIo.add(record.promise)
    }
  }

  /**
   * Start one always-observed final stat record. The chain always settles to
   * `{ status: 'fulfilled' | 'rejected' }`, captures its settled outcome on
   * the record, and its non-throwing finalize synchronously marks it settled
   * and idempotently removes its promise from `retiredIo`.
   * @param {any} target - the document target.
   * @param {AbortSignal | undefined} signal - the operation signal.
   * @returns {FinalStatRecord}
   */
  function startFinalStat(target, signal) {
    /** @type {FinalStatRecord} */
    const record = {
      settled: false,
      outcome: undefined,
      promise: /** @type {FinalStatRecord['promise']} */ (/** @type {unknown} */ (Promise.resolve(undefined))),
    }
    const promise = Promise.resolve()
      .then(() => fs.stat(target, signal))
      .then((value) => {
        const outcome = /** @type {{ status: 'fulfilled', value: { version: string, type: string, size?: number } | undefined }} */ ({
          status: 'fulfilled',
          value,
        })
        record.outcome = outcome
        return outcome
      })
      .catch((reason) => {
        const outcome = /** @type {{ status: 'rejected', reason: unknown }} */ ({ status: 'rejected', reason })
        record.outcome = outcome
        return outcome
      })
      .finally(() => {
        record.settled = true
        retiredIo.delete(promise)
      })
    record.promise = promise
    return record
  }

  /**
   * Begin one post-execute augment transaction. In a no-await critical
   * section: when admission is closed, take + retire synchronously and return
   * undefined (zero timers/listeners/I/O). Otherwise create the controller,
   * the absolute-deadline timer, the caller/cleanup relay listeners and the
   * idempotent disposer, register the tracked promise in the active registry
   * BEFORE any workspace I/O (the body starts in a microtask), and return the
   * operation record.
   * @param {unknown} exec - the tool-execution context.
   * @param {unknown} decision - the already-accepted post-execute decision.
   * @returns {AugmentOperation | undefined}
   */
  function beginAugment(exec, decision) {
    if (!admissionOpen) {
      const candidates = collector.take(exec)
      for (const candidate of candidates) collector.retireIfCurrent(candidate)
      return undefined
    }
    const controller = new AbortController()
    const deadlineAt = Date.now() + config.timeoutMs
    /** @type {{ gate: GateState, deadlineFired: boolean, abortKind: 'caller' | 'cleanup' | undefined, finalStats: FinalStatRecord[] }} */
    const state = {
      gate: 'open',
      deadlineFired: false,
      abortKind: undefined,
      finalStats: [],
    }
    /** @type {AugmentOperation} */
    const operation = {
      controller,
      promise: /** @type {Promise<unknown>} */ (Promise.resolve(undefined)),
      expireDeadline: () => {},
      disposeOperationDeadline: () => {},
    }
    const transitionTimeout = () => {
      if (state.gate !== 'open') return
      state.gate = 'timed-out'
      retireUnsettledFinalStats(state.finalStats)
    }
    /**
     * Record the abort source and run the deadline transition. The abort kind
     * is recorded even when the controller was already aborted (e.g. the
     * deadline fired first and a caller/cleanup abort arrives later), so a
     * later external abort always suppresses the timeout publication.
     * @param {'deadline' | 'caller' | 'cleanup'} reason - the abort source.
     */
    const abortWith = (reason) => {
      if (reason !== 'deadline' && state.abortKind === undefined) state.abortKind = reason
      if (controller.signal.aborted) return
      if (reason === 'deadline') state.deadlineFired = true
      controller.abort()
      transitionTimeout()
    }
    const callerSignal = /** @type {{ signal?: AbortSignal } | null} */ (exec)?.signal
    const onCallerAbort = () => abortWith('caller')
    const onCleanupAbort = () => abortWith('cleanup')
    operation.expireDeadline = () => abortWith('deadline')
    const onDeadline = operation.expireDeadline
    if (callerSignal instanceof AbortSignal) {
      if (callerSignal.aborted) onCallerAbort()
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
    cleanupController.signal.addEventListener('abort', onCleanupAbort, { once: true })
    const deadlineTimer = setTimeout(onDeadline, config.timeoutMs)
    let disposed = false
    const disposeOperationDeadline = () => {
      if (disposed) return
      disposed = true
      clearTimeout(deadlineTimer)
      if (callerSignal instanceof AbortSignal) callerSignal.removeEventListener('abort', onCallerAbort)
      cleanupController.signal.removeEventListener('abort', onCleanupAbort)
    }
    operation.disposeOperationDeadline = disposeOperationDeadline
    const tracked = Promise.resolve()
      .then(() => augmentAcceptedDecision(exec, decision, operation, state, deadlineAt))
      .finally(() => {
        // Non-standard termination: if final stats started but the gate never
        // closed stats-first, abort, forbid publish, and re-register unsettled
        // records before disposing the timer/listeners and dropping the record.
        if (state.finalStats.length > 0 && state.gate === 'open') {
          abortWith('cleanup')
        }
        operation.disposeOperationDeadline()
        activeOperations.delete(operation)
      })
    operation.promise = tracked
    activeOperations.add(operation)
    return operation
  }

  /**
   * Run the accepted-decision augment: take, extension route, workspace
   * eligibility, frozen render metadata, serial diagnosis, the one-shot final
   * stat/deadline/generation gate, the aggregate render, and the single
   * context commit. Every return path takes and retires.
   * @param {unknown} exec - the tool-execution context.
   * @param {unknown} decision - the accepted post-execute decision.
   * @param {AugmentOperation} operation - the registered operation record.
   * @param {{ gate: GateState, deadlineFired: boolean, abortKind: 'caller' | 'cleanup' | undefined, finalStats: FinalStatRecord[] }} state - shared gate state.
   * @param {number} deadlineAt - absolute deadline timestamp.
   * @returns {Promise<unknown>} the decision, possibly with the notice appended.
   */
  async function augmentAcceptedDecision(exec, decision, operation, state, deadlineAt) {
    const signal = operation.controller.signal
    const candidates = collector.take(exec)
    /** Retire every taken candidate; idempotent and safe on every return path. */
    const retireAll = () => {
      for (const candidate of candidates) collector.retireIfCurrent(candidate)
    }
    try {
      /** @type {PostExecuteDecision} */
      const decisionRecord = /** @type {PostExecuteDecision} */ (decision)
      if (decisionRecord.kind !== 'accept') {
        retireAll()
        return decision
      }
      // 1. Extension route filter, before any workspace/runtime/read work.
      /** @type {{ candidate: import('./collector.js').MutationCandidate, canonicalUri: string }[]} */
      const routed = []
      for (const candidate of candidates) {
        let canonicalUri
        try {
          canonicalUri = fs.fileUrl(candidate.target)
        } catch {
          collector.retireIfCurrent(candidate)
          continue
        }
        if (supportedExtensions.has(extensionOf(canonicalUri))) routed.push({ candidate, canonicalUri })
        else collector.retireIfCurrent(candidate)
      }
      if (routed.length === 0) {
        retireAll()
        return decision
      }
      if (signal.aborted) {
        retireAll()
        return decision
      }
      // 2. Workspace root from the session header; missing/empty is ineligible.
      const execRecord = /** @type {{ agent?: { session?: { header?: { cwd?: unknown } } } }} */ (exec)
      const workspaceRoot = execRecord?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        retireAll()
        return decision
      }
      if (signal.aborted) {
        retireAll()
        return decision
      }
      // 3. Canonicalize the workspace exactly once.
      let workspaceTarget
      try {
        workspaceTarget = await fs.resolve(workspaceRoot, { signal })
      } catch {
        retireAll()
        return decision
      }
      if (signal.aborted) {
        retireAll()
        return decision
      }
      let workspaceInfo
      try {
        workspaceInfo = await fs.stat(workspaceTarget, signal)
      } catch {
        retireAll()
        return decision
      }
      if (signal.aborted) {
        retireAll()
        return decision
      }
      if (workspaceInfo === undefined || workspaceInfo.type !== 'directory') {
        retireAll()
        return decision
      }
      // 4. Per-target eligibility: contains with pre/post abort checks, then
      // freeze renderPath + canonicalUri exactly once. Every early exit and
      // abort break retires the remaining taken candidates.
      /** @type {{ candidate: import('./collector.js').MutationCandidate, renderPath: string, targetKey: string, canonicalUri: string }[]} */
      const eligible = []
      for (const route of routed) {
        const { candidate, canonicalUri } = route
        if (signal.aborted) break
        let contained = false
        try {
          contained = fs.contains(workspaceTarget, candidate.target) === true
        } catch {
          contained = false
        }
        if (signal.aborted) break
        if (!contained) {
          collector.retireIfCurrent(candidate)
          continue
        }
        let renderPath
        try {
          renderPath = sanitizeDisplayPath(candidate.target.displayPath)
        } catch {
          collector.retireIfCurrent(candidate)
          continue
        }
        eligible.push({
          candidate,
          renderPath,
          targetKey: String(candidate.target.targetKey ?? ''),
          canonicalUri,
        })
      }
      if (signal.aborted) {
        retireAll()
        return decision
      }
      if (eligible.length === 0) {
        retireAll()
        return decision
      }
      eligible.sort(compareEligibleTargets)
      // 5. Serial diagnosis in the shared order.
      /** @type {{ target: (typeof eligible)[number], outcome: import('./runtime.js').DiagnosisOutcome }[]} */
      const diagnosed = []
      for (const target of eligible) {
        if (signal.aborted) break
        /** @type {import('./runtime.js').DiagnosisOutcome} */
        let outcome
        try {
          outcome = await runtime.diagnose(target.candidate, workspaceTarget, target.canonicalUri, signal)
        } catch (error) {
          if (signal.aborted) break
          // Plugin-owned failure after eligibility: bounded unavailable with
          // safe candidate metadata.
          outcome = { kind: 'unavailable', reason: 'diagnostics unavailable' }
        }
        if (signal.aborted) break
        diagnosed.push({ target, outcome })
      }
      // 6. Final stat round + one-shot commit gate. Only candidates that
      // actually completed a diagnosis get a final stat, and only while the
      // gate is still open and the operation is alive.
      /** @type {FinalStatRecord[]} */
      const records = []
      if (state.gate === 'open' && !signal.aborted && Date.now() < deadlineAt) {
        for (const { target } of diagnosed) records.push(startFinalStat(target.candidate.target, signal))
        state.finalStats = records
        if (records.length > 0) {
          const allStats = Promise.all(records.map((record) => record.promise))
          let onAbort
          const aborted = new Promise((resolve) => {
            if (signal.aborted) {
              resolve(true)
              return
            }
            onAbort = () => resolve(true)
            signal.addEventListener('abort', onAbort, { once: true })
          })
          try {
            await Promise.race([allStats, aborted])
          } finally {
            if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
          }
        }
      }
      // The gate's terminal decision, in the same no-await critical section:
      // stats-first commits only when every record settled, the clock is
      // strictly before the deadline, the signal is alive, and the gate is
      // still open; `now === deadlineAt` is always deadline-first.
      if (state.gate === 'open') {
        const allSettled = records.length > 0 && records.every((record) => record.settled)
        if (allSettled && Date.now() < deadlineAt && !signal.aborted) {
          state.gate = 'committed'
        } else {
          // Wall-clock expiry before the deadline timer task runs: run the
          // full deadline transition (deadlineFired + controller abort) so the
          // same-tick contender still produces the timeout aggregate.
          if (!signal.aborted && Date.now() >= deadlineAt) operation.expireDeadline()
          else {
            state.gate = 'timed-out'
            retireUnsettledFinalStats(records)
          }
        }
      }
      // 7. Build the renderer entries according to the winning gate.
      /** @type {{ renderPath: string, targetKey: string, canonicalUri: string, kind: 'diagnostics' | 'clean' | 'unavailable', diagnostics?: readonly import('./render.js').NormalizedDiagnostic[], reason?: string }[]} */
      const entries = []
      if (state.gate === 'committed') {
        for (let index = 0; index < diagnosed.length; index += 1) {
          const entry = diagnosed[index]
          if (entry === undefined) continue
          const { target, outcome } = entry
          const record = records[index]
          if (record === undefined) continue
          if (record.outcome === undefined || record.outcome.status === 'rejected') {
            // Stat plugin-owned error: bounded unavailable only while current.
            if (collector.isCurrent(target.candidate)) {
              entries.push({
                renderPath: target.renderPath,
                targetKey: target.targetKey,
                canonicalUri: target.canonicalUri,
                kind: 'unavailable',
                reason: 'diagnostics unavailable',
              })
            }
            continue
          }
          const info = record.outcome.value
          if (info === undefined || info.type !== 'file') continue
          if (info.version !== target.candidate.version) continue
          if (!collector.isCurrent(target.candidate)) continue
          if (outcome.kind === 'stale') continue
          if (outcome.kind === 'ok') {
            if (outcome.diagnostics.length === 0) {
              entries.push({
                renderPath: target.renderPath,
                targetKey: target.targetKey,
                canonicalUri: target.canonicalUri,
                kind: 'clean',
              })
            } else {
              entries.push({
                renderPath: target.renderPath,
                targetKey: target.targetKey,
                canonicalUri: target.canonicalUri,
                kind: 'diagnostics',
                diagnostics: outcome.diagnostics,
              })
            }
          } else {
            entries.push({
              renderPath: target.renderPath,
              targetKey: target.targetKey,
              canonicalUri: target.canonicalUri,
              kind: 'unavailable',
              reason: outcome.reason,
            })
          }
        }
      } else if (state.gate === 'timed-out' && state.deadlineFired && state.abortKind === undefined) {
        // Deadline-first: timeout unavailable only for still-current eligible
        // candidates; cleanup/caller abort never generates context.
        for (const target of eligible) {
          if (collector.isCurrent(target.candidate)) {
            entries.push({
              renderPath: target.renderPath,
              targetKey: target.targetKey,
              canonicalUri: target.canonicalUri,
              kind: 'unavailable',
              reason: 'timeout',
            })
          }
        }
      }
      // Both terminal paths retire every taken candidate in this same
      // no-await critical section; never touch the independent counter or a
      // newer active marker.
      retireAll()
      // 8. Commit exactly one aggregate context when the gate won and the
      // operation was not aborted by the caller or by cleanup. Deadline-first
      // (gate timed-out + deadline fired, no external abort kind) still
      // publishes its timeout-unavailable aggregate; caller/cleanup abort
      // never generates context.
      if (entries.length > 0 && state.abortKind === undefined) {
        const rendered = renderDiagnostics(entries, config)
        if (rendered.text !== null) {
          const message = createUserMessage({
            content: [{ type: 'text', text: rendered.text }],
            source: {
              kind: 'plugin',
              plugin: 'dsh-lsp-diagnostics',
              form: 'notice',
              summary: boundContextSummary(rendered.text),
            },
          })
          return {
            ...decisionRecord,
            additionalContexts: [...(decisionRecord.additionalContexts ?? []), message],
          }
        }
      }
      return decision
    } catch (error) {
      // Plugin-owned catch: fail-open with the original decision; the outer
      // tracked finally still disposes the timer/listeners and the record.
      for (const candidate of candidates) collector.retireIfCurrent(candidate)
      return decision
    }
  }

  /**
   * The real three-parameter `tools/post-execute` waterfall listener:
   * `await next()` is the unique call and sits outside any try/catch, so
   * downstream throws and caller aborts propagate with their identity. The
   * invocation is tracked before `next()` so plugin cleanup owns and awaits
   * its settlement, and a downstream rejection still takes and retires the exec's
   * candidates before the original error propagates.
   * @param {unknown} exec - the tool-execution context.
   * @param {unknown} _result - the dispatched result (unconsumed, but never omitted).
   * @param {() => Promise<unknown>} next - the waterfall continuation.
   * @returns {Promise<unknown>}
   */
  const listener = (exec, _result, next) => {
    // Start in a microtask so the complete listener promise is registered
    // before `next()` can run or perform any downstream work.
    const invocation = Promise.resolve().then(async () => {
      const downstream = next()
      // Observe rejection only to clean collector state. Awaiting the original
      // promise below preserves the exact rejection object and remains outside
      // the plugin-owned try/catch.
      void downstream.then(undefined, () => {
        for (const candidate of collector.take(exec)) collector.retireIfCurrent(candidate)
      })
      const decision = await downstream
      try {
        const operation = beginAugment(exec, decision)
        if (operation === undefined) return decision
        return await operation.promise
      } catch (_pluginOwnedFailure) {
        return decision
      }
    })
    pendingInvocations.add(invocation)
    void invocation.then(
      () => pendingInvocations.delete(invocation),
      () => pendingInvocations.delete(invocation),
    )
    return invocation
  }

  return { listener, stopAdmission, abortActiveOperations, awaitActiveOperations, awaitRetiredIo }
}
