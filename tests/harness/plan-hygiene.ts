import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { runNode } from '../helpers/process'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const planHygiene = join(root, 'tests/verify-plan-hygiene.mjs')
const realPlan = join(root, '.omo/plans/rtk-codegraph-dsh-plugins.md')

describe('verify-plan-hygiene.mjs', () => {
  const validPlanSections = [
    '## Scope',
    '## Verification strategy',
    '## Todos',
    '## Final verification wave',
    '## Commit strategy',
    '## Success criteria',
  ]

  function writeValidPlan(dir: string, filename: string, checkbox: string): string {
    const path = join(dir, filename)
    writeFileSync(path, [
      '# Fixture plan',
      '',
      ...validPlanSections.map((section) => [section, '', '- placeholder content']).flat(),
      `${checkbox} 1. Some task`,
      '  What to do / Must NOT do: do the thing',
      '  Parallelization: Wave 0 | Blocked by: none | Blocks: 2',
      '  References: somewhere',
      '  Interfaces:',
      '  - produces the thing',
      '  TDD steps:',
      '  - Run RED: pnpm exec vitest run x',
      '  - Run GREEN: pnpm exec vitest run x',
      '  Acceptance criteria: it works',
      '  QA scenarios: happy: run it. failure: break it.',
      '  Commit: Y | `chore(x): do the thing` | Stage exactly `x/**`.',
      '  Recommended task executor category: quick',
      '',
    ].join('\n'))
    return path
  }

  it('passes on the real plan file', async () => {
    const result = await runNode(planHygiene, [realPlan])
    expect(result.code).toBe(0)
  }, 30000)

  it('accepts a valid open plan whose task rows are all `- [ ]`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-open-'))
    try {
      const path = writeValidPlan(dir, 'open.md', '- [ ]')
      const result = await runNode(planHygiene, [path])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a valid completed plan whose task rows are all `- [x]`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-x-'))
    try {
      const path = writeValidPlan(dir, 'completed.md', '- [x]')
      const result = await runNode(planHygiene, [path])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a valid completed plan whose task rows are all `- [X]`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-X-'))
    try {
      const path = writeValidPlan(dir, 'completed-upper.md', '- [X]')
      const result = await runNode(planHygiene, [path])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an invalid checkbox status so arbitrary checkbox grammar is not accepted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-z-'))
    try {
      const path = writeValidPlan(dir, 'invalid-checkbox.md', '- [z]')
      const result = await runNode(planHygiene, [path])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails on a plan missing required per-task fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-bad-'))
    try {
      const broken = join(dir, 'broken.md')
      writeFileSync(broken, [
        '# Broken plan',
        '',
        '## Todos',
        '',
        '- [ ] 1. Missing everything after the title',
        '  What to do / Must NOT do: whatever',
        '',
        '## Success criteria',
        '',
        '- done',
      ].join('\n'))
      const result = await runNode(planHygiene, [broken])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when a forbidden placeholder token appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-todo-'))
    try {
      const broken = join(dir, 'todo.md')
      const body = `${'## Todos\n\n- [ ] 1. Some task\n'}\n  What to do / Must NOT do: finish me TODO\n`
      writeFileSync(broken, body)
      const result = await runNode(planHygiene, [broken])
      expect(result.code).not.toBe(0)
      expect(result.stdout).toMatch(/TODO/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
