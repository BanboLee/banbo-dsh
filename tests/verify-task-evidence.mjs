#!/usr/bin/env node
// Verifies per-task evidence directories under an evidence root passed as an argument.
//
// Usage: node tests/verify-task-evidence.mjs <evidence-root> <task-nums...>
// Exit 0 when every listed task has valid evidence; exit 1 otherwise.
//
// For each task N, checks `task-<N>/` under the root:
//   1. TDD evidence: `tdd-red.log` AND `tdd-green.log` both exist, OR
//      (only for task 8) `tdd-not-applicable.md` exists containing the exact
//      sentence `no implementation change; TDD not applicable`.
//   2. `karpathy.md` exists containing exactly the five required headings:
//      `## Assumptions`, `## Simplest sufficient approach`,
//      `## Changed files`, `## No speculative abstraction`,
//      `## Surgical scope confirmation`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const KARPATHY_HEADINGS = [
  '## Assumptions',
  '## Simplest sufficient approach',
  '## Changed files',
  '## No speculative abstraction',
  '## Surgical scope confirmation',
]

const NON_APPLICABLE_SENTENCE = 'no implementation change; TDD not applicable'

function main() {
  const root = process.argv[2]
  const taskNums = process.argv.slice(3)
  if (!root || taskNums.length === 0) {
    console.error('usage: node tests/verify-task-evidence.mjs <evidence-root> <task-nums...>')
    process.exit(1)
  }

  const report = []
  for (const num of taskNums) {
    const taskDir = join(root, `task-${num}`)
    if (!existsSync(taskDir)) {
      report.push(`task-${num}: evidence directory missing: ${taskDir}`)
      continue
    }

    // 1. TDD evidence.
    const red = join(taskDir, 'tdd-red.log')
    const green = join(taskDir, 'tdd-green.log')
    const notApplicable = join(taskDir, 'tdd-not-applicable.md')
    if (existsSync(red) && existsSync(green)) {
      // OK
    } else if (num === '8' && existsSync(notApplicable)) {
      const body = readFileSync(notApplicable, 'utf8')
      if (!body.includes(NON_APPLICABLE_SENTENCE)) {
        report.push(
          `task-8: tdd-not-applicable.md must contain the exact sentence "${NON_APPLICABLE_SENTENCE}"`,
        )
      }
    } else {
      report.push(
        `task-${num}: missing TDD evidence (need tdd-red.log + tdd-green.log, or for task-8 tdd-not-applicable.md)`,
      )
    }

    // 2. karpathy.md headings.
    const karpathy = join(taskDir, 'karpathy.md')
    if (!existsSync(karpathy)) {
      report.push(`task-${num}: missing karpathy.md`)
    } else {
      const body = readFileSync(karpathy, 'utf8')
      for (const heading of KARPATHY_HEADINGS) {
        if (!body.includes(heading)) {
          report.push(`task-${num}: karpathy.md missing heading ${heading}`)
        }
      }
    }
  }

  if (report.length > 0) {
    console.log(report.join('\n'))
    console.log(`\nverify-task-evidence: ${report.length} problem(s) under ${root}`)
    process.exit(1)
  }
  console.log(
    `verify-task-evidence: OK (${taskNums.length} task(s) under ${root} have valid TDD evidence and karpathy.md headings)`,
  )
}

main()
