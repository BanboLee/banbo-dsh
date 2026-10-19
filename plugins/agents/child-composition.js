/**
 * In-flight child composition handoff — docs/agents-plugin-plan.md §5.2/§16.12.
 *
 * 0.2.1 removed `toolFilter` and `persona` from `SubagentStartRequest`: a local
 * child is now composed ONLY from an independently selected `agentPreset`, and
 * the manager's own `applyChildComposition` therefore sees neither field. A
 * banbo child still needs both — its persona is the role prompt, and its tool
 * allowlist is the §5.2 capability surface — so this bundle applies them itself
 * in the child's creation window.
 *
 * The window is the `agent/created` listener in `main-runtime`: the official
 * factory runs a local child's `setup` and then announces it BEFORE the child's
 * first model request, so a restriction registered there is in force for the
 * whole conversation. Because the manager reserves the child id before it
 * materializes the child (this bundle supplies it), the delegation runtime can
 * park the exact composition under that id first and the listener consumes it.
 *
 * Two rules make the handoff safe:
 *   - the entry is keyed by the RESERVED child id, so two concurrent delegations
 *     can never see each other's composition;
 *   - it is removed on every path — consumed by the listener, or released by the
 *     delegating call's `finally` when creation failed before publication.
 *
 * @module @banbolee/dsh-agents/child-composition
 */

/** Reserved child id → the composition to apply when that child materializes. */
const pending = new Map()

/**
 * Park one child's composition until its creation window runs.
 * @param childId - the child id already reserved for this delegation.
 * @param composition - `agentId`, the resolved persona text, and the allowlist.
 */
export function reserveChildComposition(childId, composition) {
  pending.set(childId, composition)
}

/**
 * Drop a reservation whose child never materialized.
 * @param childId - the reserved child id.
 * @returns whether an entry was removed.
 */
export function releaseChildComposition(childId) {
  return pending.delete(childId)
}

/**
 * Consume one child's composition exactly once, in its creation window.
 * @param childId - the id of the agent being created.
 * @returns the parked composition, or `undefined` when this is not a banbo child.
 */
export function takeChildComposition(childId) {
  const composition = pending.get(childId)
  if (composition === undefined) return undefined
  pending.delete(childId)
  return composition
}
