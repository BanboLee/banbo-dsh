import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createRealHeadlessHarness,
  RTK_BIN,
  type RealBoot,
  type RealHeadlessHarness,
} from './headless-real-harness'

const REAL_E2E_ENABLED = process.env.RUN_REAL_HEADLESS_E2E === '1'
const realDescribe = REAL_E2E_ENABLED ? describe : describe.skip
let harness: RealHeadlessHarness
let booted: RealBoot

beforeAll(async () => {
  harness = await createRealHeadlessHarness()
  const settingsDir = join(harness.gitProject, '.claude')
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    permissions: {
      allow: ['Bash(git status *)'],
      ask: ['Bash(git log *)'],
      deny: ['Bash(git branch *)'],
    },
  }))
  booted = await harness.boot()
}, 120_000)

afterAll(async () => {
  await harness?.cleanup()
})

realDescribe('real RTK decoration in the headless profile', () => {
  it('uses only the pinned local release binary', () => {
    // Given the explicit RTK runtime path used by the profile patch
    const invocation = spawnSync(RTK_BIN, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    })

    // When its provenance is inspected
    const resolved = invocation.stdout.trim()

    // Then the configured override and stable RTK version are observable
    if (process.env.DSH_REAL_E2E_RTK_BIN !== undefined) {
      expect(RTK_BIN).toBe(process.env.DSH_REAL_E2E_RTK_BIN)
    }
    expect(invocation.status).toBe(0)
    expect(resolved).toMatch(/^rtk \S+$/)
  })

  it('rewrites and executes a supported git command with cwd and quoting intact', async () => {
    // Given a supported command whose output exposes quoting and cwd
    const command = 'git status --short; printf \'%s\\n%s\\n%s\\n\' "$PWD" \'quoted value\' "$REAL_E2E_ENV"'

    // When the real RTK decorator and fish provider execute it
    const result = await booted.runShell({
      command,
      workdir: harness.gitProject,
      env: { REAL_E2E_ENV: 'preserved' },
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })

    // Then the rewritten git command executes and the untouched segment survives
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.endsWith(`${harness.gitProject}\nquoted value\npreserved\n`)).toBe(true)
    expect(result.stderr.text).toContain('rtk rewrite exit 3 (ask)')
  })

  it('passes supported commands with substitution and file redirects through unchanged', async () => {
    // Given normally supported git commands made untestable in two independent ways
    const redirected = join(harness.gitProject, 'git-status.txt')
    const substitution = 'git log -1 --format="format:$(printf substitution-pass)"'
    const redirect = `git log -1 --format=format:redirect-pass > ${redirected}`

    // When each command crosses the real RTK oracle
    const [substituted, redirectedResult] = await Promise.all([
      booted.runShell({
        command: substitution,
        workdir: harness.gitProject,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
      }),
      booted.runShell({
        command: redirect,
        workdir: harness.gitProject,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
      }),
    ])

    // Then original command behavior survives with no ask-note rewrite evidence
    expect(substituted.exitCode).toBe(0)
    expect(substituted.stdout.text).toBe('substitution-pass')
    expect(substituted.stderr.text).not.toContain('rtk rewrite exit 3')
    expect(redirectedResult.exitCode).toBe(0)
    expect(redirectedResult.stdout.text).toBe('')
    expect(redirectedResult.stderr.text).not.toContain('rtk rewrite exit 3')
    expect(readFileSync(redirected, 'utf8')).toBe('redirect-pass')
  })

  it('does not double-wrap an already-rtk command', async () => {
    // Given an already decorated command
    const command = 'rtk git status --short'

    // When it crosses the decorator again
    const result = await booted.runShell({
      command,
      workdir: harness.gitProject,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })

    // Then the real RTK subcommand executes instead of attempting rtk rtk
    expect(result.exitCode).toBe(0)
    expect(result.stderr.text).not.toContain('unrecognized subcommand')
  })

  it('fails open when the pinned RTK binary becomes unavailable', async () => {
    // Given a second boot whose RTK config points at a missing binary
    const missingRtkBoot = await harness.boot({ rtkBinary: join(harness.home, 'missing-rtk') })
    const command = 'git status --short'
    const grepFixture = join(harness.profile, 'missing-rtk-grep.txt')
    writeFileSync(grepFixture, 'missingRtkToken\n')

    // When shell rewrite and grep post-processing cross the unavailable oracle
    const result = await missingRtkBoot.runShell({
      command,
      workdir: harness.gitProject,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })
    const grep = await missingRtkBoot.executeTool('grep', {
      pattern: 'missingRtkToken',
      path: grepFixture,
    })
    await missingRtkBoot.cleanup()

    // Then both DSH integration paths fail open unchanged
    expect(result.exitCode).toBe(0)
    expect(result.stderr.text).not.toContain('rtk rewrite exit 3')
    expect(grep.isError).toBe(false)
    expect(grep.content).toHaveLength(1)
    expect(grep.content[0]?.text).toContain('Found 1 match')
    expect(grep.content[0]?.text).toContain('missingRtkToken')
  })

  it('applies deterministic allow, ask, and deny rules from the isolated project', async () => {
    // Given project-local allow, ask, and deny Bash rules
    const allowCommand = 'git status --short'
    const askCommand = 'git log -1 --oneline'
    const denyCommand = 'git branch --show-current'

    // When each verdict is exercised through the mounted decorator
    const allowed = await booted.runShell({
      command: allowCommand,
      workdir: harness.gitProject,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })
    const asked = await booted.runShell({
      command: askCommand,
      workdir: harness.gitProject,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })
    // Then allow is silent, ask is noted, and deny is a typed machine failure
    expect(allowed.stderr.text).not.toContain('rtk rewrite exit 3')
    expect(asked.stderr.text).toContain('rtk rewrite exit 3 (ask)')
    await expect(booted.runShell({
      command: denyCommand,
      workdir: harness.gitProject,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })).rejects.toMatchObject({ name: 'RtkDenyError', code: 'RTK_DENY' })
  })

  it('compresses real grep output once through the mounted DSH post-execute pipeline', async () => {
    // Given test-owned files whose rendered paths are valid RTK grep records
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(harness.profile, `fixture-${index}:1:`), 'pipelineToken\n')
    }

    // When the mounted real grep tool executes through RTK post-processing
    const result = await booted.executeTool('grep', {
      pattern: 'pipelineToken',
      path: harness.profile,
      include: 'fixture-*',
    })

    // Then the real RTK formatter replaces the content exactly once
    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toContain('100 matches in 100F:')
    expect(result.content[0]?.text?.match(/100 matches in 100F:/g)).toHaveLength(1)
    expect(result.content[0]?.text).not.toContain('Found 100 matches')
  })
})
