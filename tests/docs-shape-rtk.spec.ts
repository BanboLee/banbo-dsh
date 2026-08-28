/**
 * Docs-shape contract test for `plugins/rtk-shell/README.md`.
 *
 * Asserts the structural and contract strings a user needs from the README:
 * the required section headings, the exact `rtk rewrite` exit-code contract
 * (0/1/2/3), the workspace-root install command form (with `-w`), sandbox
 * preservation, the deterministic fake-RTK testing story (no user-global RTK
 * dependency), and the verification command. It deliberately avoids asserting
 * incidental prose.
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

describe('dsh-rtk-shell README shape', () => {
  it('has every required section heading', () => {
    for (const heading of REQUIRED_HEADINGS) {
      expect(README, `missing required heading: ## ${heading}`).toContain(`## ${heading}`)
    }
  })

  it('documents the exact exit-code contract 0/1/2/3', () => {
    for (const code of ['Exit 0', 'Exit 1', 'Exit 2', 'Exit 3']) {
      expect(README, `missing exit-code mapping row: ${code}`).toContain(code)
    }
    // Exit 1 delegates unchanged (passthrough).
    expect(README).toContain('passthrough')
    // Exit 2 fails closed with the typed deny error.
    expect(README).toContain('fails closed')
    expect(README).toContain('RtkDenyError')
    // Exit 3 is rewrite-with-note, never interactive approval.
    expect(README).toContain('no interactive approval')
  })

  it('documents the workspace-root install command with -w', () => {
    expect(README).toContain('dsh plugin --profile <name> add -w ./plugins/rtk-shell')
  })

  it('documents sandbox preservation', () => {
    expect(README).toContain('sandbox')
    expect(README).toContain('preserv')
  })

  it('documents that deterministic tests never depend on a user-global rtk', () => {
    expect(README).toContain('user-global')
    expect(README).toContain('fake')
  })

  it('documents the deterministic verification command', () => {
    expect(README).toContain('pnpm exec vitest run plugins/rtk-shell/tests/*.spec.ts')
  })
})
