/** Holder ownership and bounded cleanup — docs/agents-plugin-plan.md §10.8. */

import { raceWithDeadline } from './deadline.js'

/** A promise whose external resolve/reject are owned by this module. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  // The result may reject before a delegate path gets to await it (start
  // failure). Mark it observed without changing what later awaiters receive.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** One pre-registered one-shot run owner. */
export class RunHolder {
  #controller = new AbortController()
  #run
  #result = deferred()
  #publication = deferred()
  #settlement
  #disposal
  #failed = false
  #startPending = false

  constructor(label) {
    if (typeof label !== 'string' || label === '') throw new TypeError('holder label must be a non-empty string')
    this.label = label
    this.createdAt = Date.now()
    this.state = 'reserved'
  }

  get signal() { return this.#controller.signal }
  get result() { return this.#result.promise }
  get id() { return this.#run?.id }

  /** Mark the exact point at which a provider start promise becomes live. */
  beginStart() {
    if (this.state !== 'reserved' || this.#startPending || this.#run !== undefined || this.#failed) {
      throw new Error(`holder "${this.label}" cannot begin start twice or after publication`)
    }
    this.#startPending = true
    this.state = 'starting'
  }

  /** Publish the official run into this already-owned holder exactly once. */
  attach(run) {
    const publishable = this.#startPending || this.state === 'reserved'
    if (!publishable || this.#failed || this.#run !== undefined || this.state === 'settled') {
      throw new Error(`holder "${this.label}" is already attached, failed, or settled`)
    }
    this.#startPending = false
    this.#run = run
    if (this.#settlement === undefined) this.state = 'running'
    Promise.resolve(run.result).then(this.#result.resolve, this.#result.reject)
    // A settlement request may already be waiting on this publication. Begin
    // disposal synchronously at hand-off so no extra orphan window opens.
    if (this.#settlement !== undefined) this.#disposeRun(run)
    this.#publication.resolve(run)
  }

  /** Close a reservation whose official start rejected before publication. */
  failStart(error) {
    if (this.#run !== undefined || this.#failed || this.state === 'settled') {
      throw new Error(`holder "${this.label}" cannot fail start after publication or settlement`)
    }
    this.#startPending = false
    this.#failed = true
    if (this.#settlement === undefined) this.state = 'start-failed'
    this.#result.reject(error)
    this.#publication.resolve(undefined)
  }

  /** Cooperative cancellation, first reason wins. */
  cancel(reason) {
    if (this.#controller.signal.aborted) return false
    this.#controller.abort(reason)
    return true
  }

  /** Invoke official disposal once, including for a run published late. */
  #disposeRun(run) {
    if (this.#disposal !== undefined) return this.#disposal
    try {
      // Invoke synchronously so cancellation/drain never opens an owner window
      // while waiting for the next microtask. Only the returned settlement is
      // asynchronous.
      this.#disposal = Promise.resolve(run?.dispose())
    } catch (error) {
      this.#disposal = Promise.reject(error)
    }
    return this.#disposal
  }

  /** Dispose the published run exactly once; wait for any live start promise. */
  settle() {
    if (this.#settlement !== undefined) return this.#settlement
    this.state = 'settling'
    const disposal = this.#startPending
      ? this.#publication.promise.then((run) => this.#disposeRun(run))
      : this.#disposeRun(this.#run)
    this.#settlement = disposal.then(() => {
      this.state = 'settled'
    })
    return this.#settlement
  }
}

/** Truncate without splitting a UTF-8 code point. */
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** The process-local fallback owner for every unsettled one-shot run. */
export class HolderRegistry {
  #holders = new Set()
  #logger
  #now
  #delay

  constructor(options = {}) {
    this.#logger = options.logger ?? console
    this.#now = options.now ?? Date.now
    // `undefined` means "use the production timer", which `raceWithDeadline`
    // arms `unref`ed and disarms as soon as the drain race settles.
    this.#delay = options.delay
  }

  get size() { return this.#holders.size }

  /** Register before start; auto-remove only after real settlement. */
  reserve(label) {
    const holder = new RunHolder(label)
    holder.createdAt = this.#now()
    this.#holders.add(holder)
    // Never make cleanup depend on a caller remembering to unregister.
    const originalSettle = holder.settle.bind(holder)
    let wrapped
    holder.settle = () => {
      if (wrapped !== undefined) return wrapped
      // A rejected settlement did not prove resources were released; retain the
      // holder so Host drain still owns and reports it.
      wrapped = originalSettle().then(() => {
        this.#holders.delete(holder)
      })
      return wrapped
    }
    return holder
  }

  snapshot() {
    return [...this.#holders].map((holder) => ({
      label: holder.label,
      ageMs: Math.max(0, this.#now() - holder.createdAt),
      state: holder.state,
    }))
  }

  /** Cancel and settle every owned holder, returning after the bounded grace. */
  async drain(options) {
    const graceMs = options?.graceMs
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new TypeError('drain graceMs must be a non-negative safe integer')
    const holders = [...this.#holders]
    for (const holder of holders) holder.cancel('host-dispose')
    const all = Promise.allSettled(holders.map((holder) => holder.settle()))
    if (holders.length === 0) return { unresolved: [] }

    let finished = false
    await raceWithDeadline(graceMs, this.#delay, [all.then(() => { finished = true })])
    if (finished) return { unresolved: [] }

    const unresolved = holders
      .filter((holder) => this.#holders.has(holder))
      .map((holder) => ({
        label: holder.label,
        ageMs: Math.max(0, this.#now() - holder.createdAt),
        state: holder.state,
      }))
    for (const entry of unresolved) {
      this.#logger.warn('banbo-agents: holder/orphaned', {
        label: truncateUtf8(entry.label, 128),
        registeredMs: entry.ageMs,
        graceMs,
      })
    }
    return { unresolved }
  }
}
