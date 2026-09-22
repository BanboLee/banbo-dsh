/** Root-session concurrency accounting — docs/agents-plugin-plan.md §10.3. */

/** Width-budget rejection with a fixable diagnostic. */
export class BudgetError extends Error {
  /** @type {string} */
  code
  /** @type {number | undefined} */
  running
  /** @type {number | undefined} */
  requested
  /** @type {number | undefined} */
  limit

  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'BudgetError'
    this.code = code
    Object.assign(this, detail)
  }
}

/** Process-local counters keyed directly by identity.rootSessionId. */
export class RootBudgetRegistry {
  /** @type {Map<string, number>} */
  #running = new Map()

  /** Number of newly-created child rounds currently owned by one root. */
  running(rootSessionId) {
    return this.#running.get(rootSessionId) ?? 0
  }

  /**
   * Atomically reserve `count` slots and return one idempotent lease.
   * No await occurs between checking and incrementing: JS run-to-completion is
   * the lock, and a batch either obtains every slot or none.
   */
  acquire(rootSessionId, count, limit) {
    if (typeof rootSessionId !== 'string' || rootSessionId === '') {
      throw new BudgetError('bad-root-session', 'rootSessionId must be a non-empty string')
    }
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new BudgetError('bad-count', 'child slot count must be a positive safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw new BudgetError('bad-limit', 'maxConcurrentChildren limit must be a safe integer in [1, 32]')
    }

    const running = this.running(rootSessionId)
    if (running + count > limit) {
      throw new BudgetError(
        'concurrency-exceeded',
        `banbo-agents: root Session "${rootSessionId}" has ${running} running child round(s); reserving ${count} would exceed maxConcurrentChildren=${limit}. Wait for existing work, reuse an idle continuable child, reduce the batch, or raise the budget and restart.`,
        { running, requested: count, limit },
      )
    }
    this.#running.set(rootSessionId, running + count)

    let released = false
    return Object.freeze({
      rootSessionId,
      count,
      release: () => {
        if (released) return false
        released = true
        const next = Math.max(0, this.running(rootSessionId) - count)
        if (next === 0) this.#running.delete(rootSessionId)
        else this.#running.set(rootSessionId, next)
        return true
      },
    })
  }

  /** Stable detached diagnostic view. */
  snapshot() {
    return [...this.#running]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rootSessionId, runningChildren]) => ({ rootSessionId, runningChildren }))
  }
}
