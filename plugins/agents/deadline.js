/**
 * Deadline timers that never outlive the race they belong to — §10.6/§10.8.
 *
 * Every delegation path bounds itself by racing work against a timer. A bare
 * `setTimeout` promise leaves that timer armed after the race is decided, which
 * has two observable costs:
 *
 *   - the Node event loop stays alive for the full configured deadline (15 min
 *     foreground, 30 min background, 10 min batch, 30 s drain by default) after
 *     the last delegation already finished, so a Host that exits by draining the
 *     loop looks hung;
 *   - one live timer per delegation is retained for its whole deadline.
 *
 * `armDeadline` fixes both: the production timer is `unref`ed so it can never
 * hold the process open, and the caller disarms it as soon as the race settles.
 * An injected `delayFn` (the tests' fake clock) owns its own timing and is used
 * verbatim, so the deterministic suites keep working unchanged.
 *
 * @module @banbolee/dsh-agents/deadline
 */

/** Resolved by the deadline arm; callers compare it by identity. */
export const DEADLINE_REACHED = Symbol('banbo-agents.deadline')

/**
 * Arm one deadline.
 *
 * @param ms - the deadline in milliseconds.
 * @param delayFn - an injected timer, or `undefined` for the production one.
 * @returns the promise that resolves to {@link DEADLINE_REACHED}, plus the
 *   disposer that disarms the underlying timer.
 */
export function armDeadline(ms, delayFn) {
  let disarm = () => {}
  const promise = new Promise((resolve) => {
    if (delayFn === undefined) {
      const handle = setTimeout(() => resolve(DEADLINE_REACHED), ms)
      // A deadline nobody is waiting on must never hold the process open.
      handle.unref?.()
      disarm = () => clearTimeout(handle)
      return
    }
    // The injected timer owns its own handle; there is nothing to clear here.
    delayFn(ms).then(() => resolve(DEADLINE_REACHED), () => resolve(DEADLINE_REACHED))
  })
  return { promise, cancel: () => disarm() }
}

/**
 * Race `arms` against one deadline, always disarming the timer.
 *
 * @param ms - the deadline in milliseconds.
 * @param delayFn - an injected timer, or `undefined` for the production one.
 * @param arms - the competing promises.
 * @returns the winning arm's value, or {@link DEADLINE_REACHED}.
 */
export async function raceWithDeadline(ms, delayFn, arms) {
  const timer = armDeadline(ms, delayFn)
  try {
    return await Promise.race([...arms, timer.promise])
  } finally {
    timer.cancel()
  }
}
