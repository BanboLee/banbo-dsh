/**
 * Docs-shape contract test for `plugins/rtk-shell/README.md`.
 *
 * Asserts the structural and contract strings a user needs from the README:
 * the required section headings, the exact `rtk rewrite` exit-code contract
 * (0/1/2/3), the workspace-root install command form (with `-w`), sandbox
 * preservation, the deterministic fake-RTK testing story (no user-global RTK
 * dependency), and the verification command. It deliberately avoids asserting
 * incidental prose.
 *
 * The exit mapping and sandbox checks are mapping-specific, not bare-token
 * presence: each `Behavior` exit row is bound to its required semantics, and
 * sandbox preservation is asserted as a positive contract on the sentence
 * that states it. The mutation regression tests pin the exact scenario the
 * previous loose token-bag predicates failed to reject (swapped exit 0/1
 * mapping and a negated sandbox sentence) and run it through the same
 * `validateRtkReadmeContract` used for the real README, so the checks cannot
 * drift loose again.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const README = readFileSync(fileURLToPath(new URL('../plugins/rtk-shell/README.md', import.meta.url)), 'utf8')

const REQUIRED_HEADINGS = [
  'Usage',
  'Config',
  'Behavior',
  'Model Experience',
  'Known Limitations and Deferred Work',
  'Verification',
] as const

/**
 * Extract the `Behavior`-section exit rows keyed by exit code. A row starts at
 * a `- Exit <n>,` bullet and includes its indented continuation lines; line
 * wrapping is normalized to single spaces so the checks never depend on the
 * markdown wrap width.
 */
function extractExitRows(readme: string): Map<number, string> {
  const rows = new Map<number, string>()
  const start = readme.indexOf('## Behavior')
  const end = readme.indexOf('## Model Experience')
  if (start === -1 || end === -1 || end <= start) return rows
  let current: number | undefined
  let buffer: string[] = []
  const flush = (): void => {
    if (current !== undefined) rows.set(current, buffer.join(' ').replace(/\s+/g, ' ').trim())
  }
  for (const line of readme.slice(start, end).split('\n')) {
    const match = line.match(/^- Exit (\d+),/)
    if (match !== null) {
      flush()
      current = Number(match[1])
      buffer = [line]
    } else if (current !== undefined && /^\s+/.test(line)) {
      buffer.push(line)
    } else if (current !== undefined && line.trim() !== '') {
      flush()
      current = undefined
      buffer = []
    }
  }
  flush()
  return rows
}

/**
 * Bind each exit code to its required documented semantics within the same
 * `Behavior` row, so swapping two rows or changing one row's meaning while
 * keeping the tokens is caught.
 */
function exitMappingChecks(readme: string): string[] {
  const failures: string[] = []
  const rows = extractExitRows(readme)
  for (const code of [0, 1, 2, 3]) {
    const row = rows.get(code)
    if (row === undefined) {
      failures.push(`Behavior section is missing the exit ${code} mapping row`)
      continue
    }
    if (code === 0 && !(row.includes('rewrite') && row.includes('rewritten command'))) {
      failures.push('exit 0 row must bind rewrite to the rewritten-command behavior')
    }
    if (code === 1 && !(row.includes('passthrough') && row.includes('unchanged'))) {
      failures.push('exit 1 row must bind passthrough to the original command running unchanged')
    }
    if (
      code === 2 &&
      !(row.includes('deny') && row.includes('fails closed') && row.includes('RtkDenyError') && row.includes('zero delegate'))
    ) {
      failures.push('exit 2 row must bind deny to fail-closed RtkDenyError with zero delegate invocations')
    }
    if (code === 3 && !(row.includes('rewrite-with-note') && /(?:never|no|not) interactive approval/.test(row))) {
      failures.push('exit 3 row must bind ask to rewrite-with-note with no interactive approval')
    }
  }
  return failures
}

/**
 * Assert a positive sandbox-preservation contract: the sentence that states
 * "sandbox facts" must also commit to them being inherited or preserved. A
 * generic `sandbox` + `preserv` anywhere is not enough.
 */
function sandboxPreservationChecks(readme: string): string[] {
  const flat = readme.replace(/\s+/g, ' ')
  const sentence = flat.split('. ').find((part) => part.includes('sandbox facts')) ?? ''
  if (sentence === '' || !/(?:inherited|preserved)/.test(sentence)) {
    return ['the sentence stating sandbox facts must commit to them being inherited or preserved by the delegated executor']
  }
  return []
}

/**
 * Validate every documentation behavior contract of the README. Returns a
 * non-empty list of failure messages when any required commitment is missing
 * or wrong; an empty list means the README satisfies the contract.
 */
function validateRtkReadmeContract(readme: string): string[] {
  const failures: string[] = []
  for (const heading of REQUIRED_HEADINGS) {
    if (!readme.includes(`## ${heading}`)) failures.push(`missing required heading: ## ${heading}`)
  }
  failures.push(...exitMappingChecks(readme))
  failures.push(...sandboxPreservationChecks(readme))
  if (!readme.includes('dsh plugin --profile <name> add -w ./plugins/rtk-shell')) failures.push('missing -w install command')
  if (!(readme.includes('user-global') && readme.includes('fake'))) failures.push('missing fake/user-global testing story')
  if (!readme.includes('pnpm exec vitest run plugins/rtk-shell/tests/*.spec.ts')) failures.push('missing deterministic verification command')
  return failures
}

describe('dsh-rtk-shell README shape', () => {
  it('has every required section heading', () => {
    for (const heading of REQUIRED_HEADINGS) {
      expect(README, `missing required heading: ## ${heading}`).toContain(`## ${heading}`)
    }
  })

  it('binds each exit code to its required semantics', () => {
    expect(exitMappingChecks(README)).toEqual([])
  })

  it('asserts positive sandbox preservation', () => {
    expect(sandboxPreservationChecks(README)).toEqual([])
  })

  it('documents the workspace-root install command with -w', () => {
    expect(README).toContain('dsh plugin --profile <name> add -w ./plugins/rtk-shell')
  })

  it('documents that deterministic tests never depend on a user-global rtk', () => {
    expect(README).toContain('user-global')
    expect(README).toContain('fake')
  })

  it('documents the deterministic verification command', () => {
    expect(README).toContain('pnpm exec vitest run plugins/rtk-shell/tests/*.spec.ts')
  })

  it('satisfies the full documentation behavior contract', () => {
    expect(validateRtkReadmeContract(README)).toEqual([])
  })

  it('rejects a swapped exit 0/1 mapping (mutation regression)', () => {
    const mutated = README.replace('- Exit 0, rewrite:', '- Exit 0, passthrough:').replace(
      '- Exit 1, passthrough:',
      '- Exit 1, rewrite:',
    )
    expect(mutated).not.toEqual(README)
    expect(validateRtkReadmeContract(mutated)).not.toEqual([])
  })

  it('rejects a negated sandbox preservation sentence (mutation regression)', () => {
    const mutated = README.replace(
      'Sandbox confinement, workdir/env/stdin, timeout, abort, exit code, signal,\nstdout/stderr, sandbox facts, and background-process lifecycle are inherited\nverbatim from the delegated executor.',
      'The sandbox is mentioned here, but this sentence does not preserve the sandbox facts.',
    )
    expect(mutated).not.toEqual(README)
    expect(validateRtkReadmeContract(mutated)).not.toEqual([])
  })
})
