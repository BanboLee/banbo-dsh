/**
 * Deterministic unit tests for the `dsh-fish-shell` model-facing fish tool:
 * the bash→fish guidance in TOOL_DESCRIPTION (A) and the [fish syntax] hint
 * injected into failed results (B). Pure functions only — no harness boot, no
 * live fish shell.
 */

import { describe, expect, it } from 'vitest'
import {
  FISH_SYNTAX_HINTS,
  TOOL_DESCRIPTION,
  fishSyntaxHint,
  renderResult,
} from '../tool.js'

function stream(text: string, truncated = false) {
  return { text, truncated }
}

function result(overrides: Partial<ReturnType<typeof renderResult>> & Record<string, unknown> = {}) {
  return {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30000,
    stdout: stream(''),
    stderr: stream(''),
    ...overrides,
  }
}

describe('dsh-fish-shell tool description (A)', () => {
  it('opens by telling the model this is FISH, not bash', () => {
    expect(TOOL_DESCRIPTION).toContain('FISH shell, NOT bash')
  })

  it('teaches the four highest-frequency bash→fish fixes with concrete forms', () => {
    // Variable assignment (14x in the 12h sample)
    expect(TOOL_DESCRIPTION).toContain('`set VAR x`')
    expect(TOOL_DESCRIPTION).toContain('`set -gx VAR x`')
    // for...do...done → for...end (3x)
    expect(TOOL_DESCRIPTION).toContain('`for i in ...; ...; end`')
    // if...then...fi → if test...end (5x)
    expect(TOOL_DESCRIPTION).toContain('`if test c; ...; end`')
    // heredoc has no fish equivalent (10x)
    expect(TOOL_DESCRIPTION).toContain('fish has no heredoc')
  })

  it('points failed calls at the per-result [fish syntax] hint', () => {
    expect(TOOL_DESCRIPTION).toContain('[fish syntax] hint')
  })
})

describe('fishSyntaxHint (B)', () => {
  it('maps the exact fish diagnostic to the concrete fish form', () => {
    expect(fishSyntaxHint('fish: Unsupported use of \'=\'. In fish, please use \'set SDK x\'.'))
      .toContain('`set VAR x`')
    expect(fishSyntaxHint('fish: Expected a string, but found a redirection')).toContain('heredoc')
    expect(fishSyntaxHint('fish: Missing end to balance this for loop')).toContain('for x in')
    expect(fishSyntaxHint('fish: Missing end to balance this if statement')).toContain('if test')
    expect(fishSyntaxHint('fish: No matches for wildcard \'*.json\'. See `help wildcards-globbing`.'))
      .toContain('unmatched glob')
  })

  it('returns empty for a clean run or a non-fish failure', () => {
    expect(fishSyntaxHint('')).toBe('')
    expect(fishSyntaxHint('git: command not found')).toBe('')
    expect(fishSyntaxHint('Some app crashed')).toBe('')
  })

  it('keeps every hint short and actionable', () => {
    for (const { hint } of FISH_SYNTAX_HINTS) {
      expect(hint.length).toBeLessThan(200)
      expect(hint).toContain('fish')
    }
  })
})

describe('renderResult hint injection (B)', () => {
  it('appends a [fish syntax] hint when the run failed with a fish diagnostic', () => {
    const out = renderResult(result({
      exitCode: 127,
      stderr: stream("fish: Unsupported use of '='. In fish, please use 'set CMD x'.\n"),
    }))
    expect(out).toContain('[fish syntax]')
    expect(out).toContain('`set VAR x`')
    expect(out).toContain('[exit code: 127]')
  })

  it('leaves a successful run without any hint', () => {
    const out = renderResult(result({
      stdout: stream('hello\n'),
    }))
    expect(out).toContain('hello')
    expect(out).not.toContain('[fish syntax]')
    expect(out).not.toContain('[exit code:')
  })

  it('leaves a non-syntax failure (real error text) without a bogus hint', () => {
    const out = renderResult(result({
      exitCode: 1,
      stderr: stream('tsc: error TS2322: type mismatch\n'),
    }))
    expect(out).toContain('[exit code: 1]')
    expect(out).not.toContain('[fish syntax]')
  })

  it('preserves the normal marker contract for sandbox/timeout/signal', () => {
    const denied = renderResult(result({
      exitCode: 0,
      sandbox: { mode: 'read-only', denied: true },
    }))
    expect(denied).toContain('[sandbox: file access denied under read-only mode]')

    const timed = renderResult(result({ timedOut: true, timeoutMs: 5000 }))
    expect(timed).toContain('[timed out after 5000ms]')
  })
})
