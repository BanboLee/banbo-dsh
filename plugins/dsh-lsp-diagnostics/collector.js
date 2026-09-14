/**
 * Mutation collector for `fs/observed` write/edit observations.
 *
 * Three responsibility-separated structures:
 *
 * - `pendingByExec`: `WeakMap<exec, Map<targetKey, Candidate>>` — the latest
 *   candidate observed for each exec/target pair. A replaced candidate is
 *   immediately stale.
 * - `nextGenerationByTarget`: `Map<targetKey, number | 'exhausted'>` — the
 *   next generation to allocate for a target (missing entry means `1`). It
 *   only allocates monotonically and never regresses or reuses a generation
 *   within a plugin lifetime; it is never cleaned per target.
 * - `latestObserved`: `Map<targetKey, { generation, version }>` — the current
 *   active marker only, never a counter. `retireIfCurrent` reclaims it.
 *
 * Only `write`, `edit`, and `str_replace_editor` with a mutating command
 * (`create`/`str_replace`/`insert`) are accepted; `view`, unsupported tools
 * and absent observations are silently ignored. The observer never throws:
 * hostile observations and internal counter anomalies are contained.
 *
 * @module @banbolee/dsh-lsp-diagnostics/collector
 */

/**
 * @typedef {object} CollectorExec
 * @property {unknown} [name] - the registered tool name.
 * @property {{ command?: unknown }} [arguments] - parsed tool arguments.
 */

/**
 * @typedef {object} CollectorTargetLike
 * @property {unknown} [targetKey] - opaque stable target identity.
 * @property {unknown} [displayPath] - model-facing path.
 */

/**
 * @typedef {object} MutationCandidate
 * @property {CollectorTargetLike} target - the mutated target.
 * @property {string} version - the observed `FsVersion` token.
 * @property {number} generation - the per-target monotonic generation.
 */

/**
 * @typedef {object} CollectorOptions
 * @property {Map<string, number | 'exhausted'>} [initialNextGenerationByTarget]
 *   Test seam: pre-seeds the per-target generation counter so the
 *   `Number.MAX_SAFE_INTEGER` boundary and the permanent exhausted fail-safe
 *   can be exercised without 2^53 observations. Production wiring never
 *   supplies it.
 */

/** @type {ReadonlySet<string>} */
const SUPPORTED_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** @type {ReadonlySet<string>} */
const SUPPORTED_EDITOR_COMMANDS = new Set(['create', 'str_replace', 'insert'])

/**
 * Create a mutation collector.
 * @param {CollectorOptions} [options] - optional test seam options.
 * @returns {{
 *   observe(exec: unknown, target: unknown, observation: unknown): boolean
 *   take(exec: unknown): MutationCandidate[]
 *   isCurrent(candidate: unknown): boolean
 *   retireIfCurrent(candidate: unknown): boolean
 * }}
 */
export function createMutationCollector(options = {}) {
  /** @type {Map<string, number | 'exhausted'>} */
  const nextGenerationByTarget =
    options.initialNextGenerationByTarget === undefined
      ? new Map()
      : new Map(options.initialNextGenerationByTarget)
  /** @type {Map<string, { generation: number, version: string }>} */
  const latestObserved = new Map()
  /** @type {WeakMap<object, Map<string, MutationCandidate>>} */
  const pendingByExec = new WeakMap()

  /**
   * Check whether the observation comes from a supported mutating tool.
   * @param {unknown} exec - the tool-execution context (actor).
   * @returns {boolean}
   */
  function isSupportedMutation(exec) {
    if (typeof exec !== 'object' || exec === null) return false
    const name = /** @type {CollectorExec} */ (exec).name
    if (typeof name !== 'string' || !SUPPORTED_TOOLS.has(name)) return false
    if (name !== 'str_replace_editor') return true
    const command = /** @type {CollectorExec} */ (exec).arguments?.command
    return typeof command === 'string' && SUPPORTED_EDITOR_COMMANDS.has(command)
  }

  /**
   * Record a successful mutation observation for the exec/target pair.
   *
   * Per target: reads the next counter, allocates it as the generation
   * (advancing to `generation + 1`, or to the permanent `'exhausted'` state
   * at `Number.MAX_SAFE_INTEGER`), replaces the active marker, and stores the
   * latest candidate. A later observation that reads `'exhausted'` deletes
   * the active marker and silently suppresses the candidate, so all prior
   * candidates (including the max-generation one) are stale forever. Any
   * internal error is contained: never throws, never records.
   *
   * @param {unknown} exec - the tool-execution context (actor).
   * @param {unknown} target - the mutated target.
   * @param {unknown} observation - the fs/observed payload.
   * @returns {boolean} true only when a supported present mutation was recorded.
   */
  function observe(exec, target, observation) {
    try {
      if (!isSupportedMutation(exec)) return false
      if (typeof observation !== 'object' || observation === null) return false
      const kind = /** @type {{ kind?: unknown }} */ (observation).kind
      if (kind !== 'present') return false
      const version = /** @type {{ version?: unknown }} */ (observation).version
      if (typeof version !== 'string') return false
      if (typeof target !== 'object' || target === null) return false
      const targetKey = /** @type {CollectorTargetLike} */ (target).targetKey
      if (typeof targetKey !== 'string' || targetKey.length === 0) return false

      const next = nextGenerationByTarget.get(targetKey)
      let generation
      if (next === undefined) {
        generation = 1
      } else if (next === 'exhausted') {
        // Permanent exhaustion: retire the active marker and suppress the
        // candidate; never wrap or reset the counter.
        latestObserved.delete(targetKey)
        return false
      } else if (typeof next === 'number' && Number.isSafeInteger(next) && next > 0) {
        generation = next
      } else {
        // Internal counter anomaly: contain it silently, record nothing.
        return false
      }

      const following = generation < Number.MAX_SAFE_INTEGER ? generation + 1 : 'exhausted'
      nextGenerationByTarget.set(targetKey, following)
      latestObserved.set(targetKey, { generation, version })

      const key = /** @type {object} */ (exec)
      let byTarget = pendingByExec.get(key)
      if (byTarget === undefined) {
        byTarget = new Map()
        pendingByExec.set(key, byTarget)
      }
      // Replacing the candidate for this exec/target makes any prior one stale.
      byTarget.set(targetKey, {
        target: /** @type {CollectorTargetLike} */ (target),
        version,
        generation,
      })
      return true
    } catch {
      // Containment: a hostile observation must never throw.
      return false
    }
  }

  /**
   * Return and clear the pending candidates for one exec.
   * @param {unknown} exec - the tool-execution context (actor).
   * @returns {MutationCandidate[]}
   */
  function take(exec) {
    if (typeof exec !== 'object' || exec === null) return []
    const byTarget = pendingByExec.get(exec)
    if (byTarget === undefined) return []
    pendingByExec.delete(exec)
    return [...byTarget.values()]
  }

  /**
   * Extract a candidate's target key defensively.
   * @param {unknown} candidate - the candidate to inspect.
   * @returns {string | undefined}
   */
  function candidateTargetKey(candidate) {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const targetKey = /** @type {{ target?: { targetKey?: unknown } }} */ (candidate).target?.targetKey
    return typeof targetKey === 'string' ? targetKey : undefined
  }

  /**
   * Whether the candidate is the current active marker: the marker must exist
   * and both `generation` and `version` must match exactly.
   * @param {unknown} candidate - the candidate to check.
   * @returns {boolean}
   */
  function isCurrent(candidate) {
    const targetKey = candidateTargetKey(candidate)
    if (targetKey === undefined) return false
    const marker = latestObserved.get(targetKey)
    if (marker === undefined) return false
    if (typeof candidate !== 'object' || candidate === null) return false
    const { generation, version } = /** @type {{ generation?: unknown, version?: unknown }} */ (candidate)
    return marker.generation === generation && marker.version === version
  }

  /**
   * Retire the active marker only when the candidate matches it exactly
   * (generation and version). Never touches the generation counter, so the
   * next observation for the target allocates the next generation.
   * @param {unknown} candidate - the candidate to retire.
   * @returns {boolean} whether the active marker was removed.
   */
  function retireIfCurrent(candidate) {
    const targetKey = candidateTargetKey(candidate)
    if (targetKey === undefined) return false
    const marker = latestObserved.get(targetKey)
    if (marker === undefined) return false
    if (typeof candidate !== 'object' || candidate === null) return false
    const { generation, version } = /** @type {{ generation?: unknown, version?: unknown }} */ (candidate)
    if (marker.generation !== generation || marker.version !== version) return false
    latestObserved.delete(targetKey)
    return true
  }

  return { observe, take, isCurrent, retireIfCurrent }
}
