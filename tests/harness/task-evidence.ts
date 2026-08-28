import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { runNode } from '../helpers/process'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const taskEvidence = join(root, 'tests/verify-task-evidence.mjs')

describe('verify-task-evidence.mjs', () => {
  const karpathyHeadings = [
    '## Assumptions',
    '## Simplest sufficient approach',
    '## Changed files',
    '## No speculative abstraction',
    '## Surgical scope confirmation',
  ]

  function writeValidTask(dir: string, n: number): void {
    const taskDir = join(dir, `task-${n}`)
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'tdd-red.log'), 'RED ran\n')
    writeFileSync(join(taskDir, 'tdd-green.log'), 'GREEN ran\n')
    writeFileSync(join(taskDir, 'karpathy.md'), `${karpathyHeadings.join('\n\n')}\n`)
  }

  it('passes on a valid evidence root for task 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-ok-'))
    try {
      writeValidTask(dir, 1)
      const result = await runNode(taskEvidence, [dir, '1'])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts tdd-not-applicable.md for task 8 with the exact sentence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-t8-'))
    try {
      const taskDir = join(dir, 'task-8')
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(join(taskDir, 'tdd-not-applicable.md'), 'no implementation change; TDD not applicable\n')
      writeFileSync(join(taskDir, 'karpathy.md'), `${karpathyHeadings.join('\n\n')}\n`)
      const result = await runNode(taskEvidence, [dir, '8'])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when tdd evidence and karpathy headings are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-missing-'))
    try {
      const taskDir = join(dir, 'task-1')
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(join(taskDir, 'karpathy.md'), '## Assumptions\n\n## Wrong heading\n')
      const result = await runNode(taskEvidence, [dir, '1'])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when the evidence directory does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-absent-'))
    try {
      const result = await runNode(taskEvidence, [dir, '99'])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
