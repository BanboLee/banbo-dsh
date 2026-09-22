/**
 * Docs-shape contract test for the `@banbolee/dsh-agents` bundle.
 *
 * The plan requires the two READMEs and the root README to state the same
 * user-facing contract as the implementation (docs/agents-plugin-plan.md §17
 * item 7, §18). This suite pins the structural facts a user is promised — the
 * install/uninstall/purge commands, the settings namespace, the shipped team,
 * the persona-override rule, and the three explicit non-promises — and
 * deliberately avoids incidental prose, so documentation may be reworded
 * without breaking CI while a changed contract cannot slip through.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const ZH = read('../plugins/agents/README.md')
const EN = read('../plugins/agents/README.en.md')
const ROOT = read('../README.md')

const PACKAGE_NAME = '@banbolee/dsh-agents'
const STATE_DIR = '$DSH_HOME/banbo-agents'
const TEAM = ['banbo', 'planner', 'executor', 'implement', 'review', 'research', 'explorer'] as const

describe('agents README — install surface', () => {
  it('documents the published install, source install, and uninstall commands', () => {
    for (const readme of [ZH, EN]) {
      expect(readme).toContain(`dsh plugin --profile <profile> add ${PACKAGE_NAME}`)
      expect(readme).toContain('dsh plugin --profile <profile> add -w ./plugins/agents')
      expect(readme).toContain(`dsh plugin --profile <profile> remove ${PACKAGE_NAME}`)
    }
    expect(ROOT).toContain(`dsh plugin --profile <profile> add ${PACKAGE_NAME}`)
    expect(ROOT).toContain(`dsh plugin --profile <profile> remove ${PACKAGE_NAME}`)
  })

  it('states that a normal uninstall keeps user data and that purge is manual and destructive', () => {
    for (const readme of [ZH, EN]) {
      expect(readme).toContain(STATE_DIR)
      expect(readme).toContain(`rm -rf "${STATE_DIR}"`)
    }
  })
})

describe('agents README — shipped contract', () => {
  it('names the settings namespace and the Plugin Configuration seat', () => {
    expect(ZH).toContain('Plugin Configuration')
    expect(EN).toContain('Plugin Configuration')
    for (const readme of [ZH, EN]) expect(readme).toContain('banbo-agents')
  })

  it('lists exactly the seven shipped agents in both languages', () => {
    for (const readme of [ZH, EN]) {
      for (const agent of TEAM) expect(readme, `${agent} must appear`).toContain(`\`${agent}\``)
    }
  })

  it('documents same-name persona override without a YAML change', () => {
    expect(ZH).toContain('prompts/planner-child.md')
    expect(EN).toContain('prompts/planner-child.md')
  })

  it('states the three non-promises in both languages', () => {
    expect(ZH).toContain('不精确计数')
    expect(ZH).toContain('不跨重启')
    expect(ZH).toContain('连带整棵子树失效')

    // The English README emphasizes these phrases, so the assertions tolerate
    // markdown emphasis markers instead of pinning incidental formatting.
    expect(EN).toMatch(/not\s+\*{0,2}exactly counted/)
    expect(EN).toMatch(/does\s+\*{0,2}not\*{0,2}\s+survive a restart/)
    expect(EN).toMatch(/invalidates its whole subtree/)
  })

  it('keeps the main-agent model owned by the official selector', () => {
    expect(ZH).toContain('model-on-main-only')
    expect(EN).toContain('model-on-main-only')
    for (const readme of [ZH, EN]) expect(readme).toMatch(/Session model selector|官方 Session model selector/)
  })

  it('documents the frozen-descriptor boundary for existing continuable children', () => {
    expect(ZH).toContain('toolFilter')
    expect(EN).toContain('toolFilter')
    expect(ZH).toMatch(/冻结/)
    expect(EN).toMatch(/frozen/)
  })
})

describe('agents README — build and Gate lanes are documented', () => {
  it('points at the build entry point and the separate gate lane', () => {
    for (const readme of [ZH, EN]) {
      expect(readme).toContain('scripts/build.mjs')
      expect(readme).toContain('tests/gates')
      expect(readme).toContain('packed.spec.ts')
    }
  })

  it('keeps the repository contract test and CI wiring consistent with the docs', () => {
    const shape = read('../tests/package-shape.spec.ts')
    expect(shape).toContain(PACKAGE_NAME)
    const ci = read('../.github/workflows/ci.yml')
    expect(ci).toContain('pnpm build:agents')
    expect(ci).toContain('pnpm test:agents:gates')
    expect(ci).not.toContain('0.1.5-rc.1')
  })
})
