/**
 * The child-composition handoff — docs/agents-plugin-plan.md §5.2/§16.12.
 *
 * 0.2.1 stopped accepting `persona` and `toolFilter` on `SubagentStartRequest`,
 * so this bundle parks them under the reserved child id and applies them in the
 * child's own creation window. These tests cover the handoff itself: the
 * reservation is keyed, consumed exactly once, and releasable when creation
 * never happens.
 */

import { describe, expect, it } from 'vitest'

import {
  releaseChildComposition,
  reserveChildComposition,
  takeChildComposition,
} from '../child-composition.js'

const composition = Object.freeze({
  agentId: 'worker',
  persona: '# Worker\n',
  toolFilter: Object.freeze({ allow: Object.freeze(['read']) }),
})

describe('child composition handoff', () => {
  it('returns the parked composition exactly once', () => {
    reserveChildComposition('child-a', composition)

    expect(takeChildComposition('child-a')).toBe(composition)
    // Consumed: a later creation window for the same id must not re-apply it.
    expect(takeChildComposition('child-a')).toBeUndefined()
  })

  it('keeps two concurrent reservations apart', () => {
    const other = { ...composition, agentId: 'other' }
    reserveChildComposition('child-a', composition)
    reserveChildComposition('child-b', other)

    expect(takeChildComposition('child-b')).toBe(other)
    expect(takeChildComposition('child-a')).toBe(composition)
  })

  it('releases a reservation whose child never materialized', () => {
    reserveChildComposition('child-a', composition)

    expect(releaseChildComposition('child-a')).toBe(true)
    expect(takeChildComposition('child-a')).toBeUndefined()
    // Releasing twice is not an error, and never resurrects an entry.
    expect(releaseChildComposition('child-a')).toBe(false)
  })

  it('answers undefined for a child this bundle never reserved', () => {
    // The official harness creates agents this bundle does not own (a plain
    // top-level Session, an external provider's child); the listener must be a
    // no-op for them rather than throwing.
    expect(takeChildComposition('someone-elses-child')).toBeUndefined()
  })
})
