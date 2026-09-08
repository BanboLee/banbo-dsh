import { describe, expect, it } from 'vitest'
import {
  MANDATORY_PLAN_IDS,
  REAL_SCENARIO_DRIVERS,
  SCENARIOS,
  assertCompleteResults,
} from '../../scripts/qa/lib/plan.mjs'

type QaResult = {
  readonly id: string
  readonly scenario: string
  readonly status: string
  readonly evidence: Readonly<Record<string, unknown>>
}

function scenarioFor(id: string): string {
  return Object.entries(SCENARIOS).find(([candidate]) => candidate === id)?.[1] ?? 'unknown'
}

function passingResult(id: string): QaResult {
  const evidence = id === 'TUI-05'
    ? { verified: true, toolResultVisible: true }
    : { verified: true }
  return { id, scenario: scenarioFor(id), status: 'passed', evidence }
}

describe('G4-G6 plan result enforcement', () => {
  it('maps every mandatory Plan ID to one named scenario when the contract is loaded', () => {
    // Given: the authoritative mandatory acceptance IDs.
    // When: the runner scenario map is inspected.
    const mappedIds = Object.keys(SCENARIOS)

    // Then: every mandatory ID is mapped exactly once.
    expect(mappedIds).toEqual([...MANDATORY_PLAN_IDS])
    expect(new Set(mappedIds).size).toBe(MANDATORY_PLAN_IDS.length)
  })

  it('assigns a real deterministic driver to every mandatory Plan ID when G6 is registered', () => {
    // Given: the authoritative mandatory acceptance IDs.
    // When: the executable driver registry is inspected.
    const registeredIds = Object.keys(REAL_SCENARIO_DRIVERS)

    // Then: every ID has one non-placeholder driver.
    expect(registeredIds).toEqual([...MANDATORY_PLAN_IDS])
    expect(Object.values(REAL_SCENARIO_DRIVERS)).not.toContain('missing-real-scenario-driver')
  })

  it('accepts one passing sanitized result per Plan ID when the complete run finishes', () => {
    // Given: one passing result for every mandatory ID.
    const results = MANDATORY_PLAN_IDS.map(passingResult)

    // When: the release-gate result set is enforced.
    const report = assertCompleteResults(results)

    // Then: every result is retained exactly once.
    expect(report).toHaveLength(MANDATORY_PLAN_IDS.length)
  })

  it.each([
    ['missing', MANDATORY_PLAN_IDS.slice(1)],
    ['duplicate', [...MANDATORY_PLAN_IDS, MANDATORY_PLAN_IDS[0]]],
    ['unknown', [...MANDATORY_PLAN_IDS, 'UNKNOWN-01']],
  ])('rejects a %s Plan ID set when the release gate is finalized', (_caseName, ids) => {
    // Given: a result set with invalid Plan ID cardinality.
    const results = ids.map((id) => ({
      id,
      scenario: scenarioFor(id),
      status: 'passed',
      evidence: { verified: true },
    }))

    // When: the gate attempts to finalize the invalid result set.
    const finalize = () => assertCompleteResults(results)

    // Then: missing, duplicate, and unknown IDs cannot be reported as a pass.
    expect(finalize).toThrow(/Plan ID/)
  })

  it.each(['failed', 'blocked', 'skipped'])(
    'rejects a %s mandatory result when the release gate is finalized',
    (status) => {
      // Given: one non-passing result in an otherwise complete result set.
      const results = MANDATORY_PLAN_IDS.map((id, index) => ({
        ...passingResult(id),
        status: index === 0 ? status : 'passed',
      }))

      // When: the gate attempts to finalize the run.
      const finalize = () => assertCompleteResults(results)

      // Then: truthful non-pass evidence makes G6 nonzero.
      expect(finalize).toThrow(/SH-01.*status/)
    },
  )

  it('rejects evidence containing raw secrets when sanitized results are finalized', () => {
    // Given: a complete result set with a forbidden raw header field.
    const results = MANDATORY_PLAN_IDS.map(passingResult)
    results[0] = {
      ...results[0],
      evidence: { authorization: 'Bearer production-secret' },
    }

    // When: evidence sanitization is enforced.
    const finalize = () => assertCompleteResults(results)

    // Then: secret-bearing evidence cannot be written.
    expect(finalize).toThrow(/evidence.*sanitized/i)
  })

  it('accepts arrays of sanitized machine values when results are finalized', () => {
    // Given: a complete result set with one structural list in its evidence.
    const results = MANDATORY_PLAN_IDS.map(passingResult)
    results[0] = {
      ...results[0],
      evidence: { requiredRows: ['fish-shell', 'tool-fish'] },
    }

    // When: evidence sanitization is enforced.
    const finalize = () => assertCompleteResults(results)

    // Then: safe arrays remain valid evidence.
    expect(finalize).not.toThrow()
  })

  it('rejects a passed TUI-05 result without visible tool-result evidence', () => {
    // Given: every Plan ID passed but TUI-05 lacks its required visible result.
    const results = MANDATORY_PLAN_IDS.map(passingResult)
    const tuiTurn = results.findIndex((result) => result.id === 'TUI-05')
    results[tuiTurn] = {
      ...results[tuiTurn],
      evidence: { driver: 'pty-loopback-turn', toolResultVisible: false },
    }

    // When: scenario-specific acceptance is enforced.
    const finalize = () => assertCompleteResults(results)

    // Then: generic passed status cannot override false TUI evidence.
    expect(finalize).toThrow(/TUI-05.*toolResultVisible/)
  })
})
