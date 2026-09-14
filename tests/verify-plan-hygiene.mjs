#!/usr/bin/env node
// Verifies task-row grammar of a plan file passed as an argument.
//
// Usage: node tests/verify-plan-hygiene.mjs <plan-file>
// Exit 0 when the plan is healthy; exit 1 with a report on stdout otherwise.
//
// Checks:
//   1. Required top-level sections exist.
//   2. Every `- [ ] N.` / `- [x] N.` / `- [X] N. <title>` task row carries all
//      required field labels.
//      The matcher follows the plan's actual grammar: `Blocked by:`/`Blocks:`
//      appear inline on the `Parallelization:` line; `Run RED:`/`Run GREEN:`
//      may be written as `- Run RED:` bullets; `References`,
//      `Acceptance criteria`, and `QA scenarios` may carry a parenthetical
//      suffix (e.g. `References (executor has NO interview context ...)`).
//   3. Each task row has an allowed `Recommended task executor category`
//      (leading token of the value: `quick`, `writing`, `unspecified-high`).
//   4. Each `Commit:` line declares a message and exact staged paths
//      (`Stage exactly ...`), with the plan's `Conditional` exception for
//      the final reconciliation task (todo 8).
//   5. No forbidden placeholder tokens appear anywhere.
//
// Forbidden placeholder tokens are chosen so the plan's own guardrail prose
// is allowlisted: `TODO` is matched case-sensitively (uppercase only) so the
// plan's legitimate `Todo 1`/`Todo 8` references and `## Todos` heading are
// not flagged, and documented angle-bracket command examples like
// `<profile>`, `<absolute-path>`, `<name>` are not in the forbidden set.

import { readFileSync } from 'node:fs'

const FORBIDDEN_PLACEHOLDERS = [
  { token: 'TODO', caseSensitive: true },
  { token: 'FIXME', caseSensitive: false },
  { token: 'TBD', caseSensitive: false },
  { token: 'XXX', caseSensitive: false },
  { token: 'REPLACE_ME', caseSensitive: false },
  { token: 'lorem ipsum', caseSensitive: false },
  { token: 'your-name-here', caseSensitive: false },
  { token: 'INSERT_', caseSensitive: false },
]

const REQUIRED_SECTIONS = [
  '## Todos',
  '## Final verification wave',
  '## Commit strategy',
  '## Success criteria',
  '## Verification strategy',
  '## Scope',
]

// Field checks run against the collected indented lines of each task row.
// Each entry: { label, re } where re must match one of the row's lines.
const FIELD_CHECKS = [
  { label: 'What to do / Must NOT do', re: /^ {2}What to do \/ Must NOT do:/ },
  { label: 'Parallelization', re: /^ {2}Parallelization:/ },
  { label: 'Blocked by (inline on Parallelization)', re: /^ {2}Parallelization:.*Blocked by:/ },
  { label: 'Blocks (inline on Parallelization)', re: /^ {2}Parallelization:.*Blocks:/ },
  { label: 'References', re: /^ {2}References(?: \([^)]*\))?:/ },
  { label: 'Interfaces', re: /^ {2}Interfaces:/ },
  { label: 'TDD steps', re: /^ {2}TDD steps:/ },
  { label: 'Run RED', re: /^ {2}-? ?(Run )?RED:/ },
  { label: 'Run GREEN', re: /^ {2}-? ?(Run )?GREEN(?::| after)/ },
  { label: 'Acceptance criteria', re: /^ {2}Acceptance criteria(?: \([^)]*\))?:/ },
  { label: 'QA scenarios', re: /^ {2}QA scenarios(?: \([^)]*\))?:/ },
  { label: 'Commit', re: /^ {2}Commit:/ },
  { label: 'Recommended task executor category', re: /^ {2}Recommended task executor category:/ },
]

const ALLOWED_CATEGORIES = new Set(['quick', 'writing', 'unspecified-high'])

function fail(report, message) {
  report.push(`FAIL: ${message}`)
}

function main() {
  const planPath = process.argv[2]
  if (!planPath) {
    console.error('usage: node tests/verify-plan-hygiene.mjs <plan-file>')
    process.exit(1)
  }
  const report = []
  const text = readFileSync(planPath, 'utf8')
  const lines = text.split('\n')

  // 1. Required sections.
  for (const section of REQUIRED_SECTIONS) {
    if (!lines.some((line) => line.trim() === section)) {
      fail(report, `missing required section: ${section}`)
    }
  }

  // 2-4. Task rows: collect each row's indented body. Top-level implementation
  // rows are recognized in any valid checkbox lifecycle state (`[ ]` open,
  // `[x]`/`[X]` completed); any other status inside the brackets is rejected.
  const taskRows = []
  let currentRow = null
  for (const line of lines) {
    if (/^- \[[ xX]\] \d+\.\s/.test(line)) {
      currentRow = { start: line, body: [] }
      taskRows.push(currentRow)
      continue
    }
    if (currentRow && /^ {2,}/.test(line)) currentRow.body.push(line)
  }

  if (taskRows.length === 0) {
    fail(report, 'no `- [ ] N.`, `- [x] N.`, or `- [X] N.` task rows found')
  }

  for (const row of taskRows) {
    for (const check of FIELD_CHECKS) {
      if (!row.body.some((line) => check.re.test(line))) {
        fail(report, `task row "${row.start.trim()}" missing field: ${check.label}`)
      }
    }

    // Recommended task executor category: leading token of the value.
    const categoryLine = row.body.find((line) => /^ {2}Recommended task executor category:/.test(line))
    if (!categoryLine) {
      fail(report, `task row "${row.start.trim()}" missing Recommended task executor category`)
    } else {
      const value = categoryLine.slice('  Recommended task executor category:'.length).trim()
      const category = value.split(/\s+[—-]\s+|[\s,.]+/)[0]
      if (!ALLOWED_CATEGORIES.has(category)) {
        fail(report, `task row "${row.start.trim()}" has disallowed category "${category}"`)
      }
    }

    // Commit line: `Y | <message> | Stage exactly <paths>` or `Conditional | ...`.
    const commitLine = row.body.find((line) => /^ {2}Commit:/.test(line))
    if (!commitLine) {
      fail(report, `task row "${row.start.trim()}" missing Commit line`)
    } else {
      const value = commitLine.slice('  Commit:'.length).trim()
      const isConditional = value.startsWith('Conditional')
      const hasMessage = /^(Y|Conditional)\s*\|.+/i.test(value)
      const hasStageExactly = value.includes('Stage exactly')
      if (!isConditional && !hasMessage) {
        fail(report, `task row "${row.start.trim()}" commit line is not "Y | <message> | Stage exactly ..."`)
      }
      if (!isConditional && !hasStageExactly) {
        fail(report, `task row "${row.start.trim()}" commit line lacks "Stage exactly <paths>"`)
      }
    }
  }

  // 5. Forbidden placeholder tokens.
  for (const { token, caseSensitive } of FORBIDDEN_PLACEHOLDERS) {
    const haystack = caseSensitive ? text : text.toLowerCase()
    const needle = caseSensitive ? token : token.toLowerCase()
    if (haystack.includes(needle)) {
      fail(report, `forbidden placeholder token found: "${token}"`)
    }
  }

  if (report.length > 0) {
    console.log(report.join('\n'))
    console.log(`\nverify-plan-hygiene: ${report.length} problem(s) in ${planPath}`)
    process.exit(1)
  }
  console.log(`verify-plan-hygiene: OK (${taskRows.length} task rows, all fields/categories/commits valid, no forbidden placeholders) in ${planPath}`)
}

main()
