import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createRealHeadlessHarness,
  type RealBoot,
  type RealHeadlessHarness,
} from './headless-real-harness'

const REAL_E2E_ENABLED = process.env.RUN_REAL_HEADLESS_E2E === '1'
const realDescribe = REAL_E2E_ENABLED ? describe : describe.skip

let harness: RealHeadlessHarness
let booted: RealBoot

beforeAll(async () => {
  harness = await createRealHeadlessHarness()
  booted = await harness.boot()
}, 120_000)

afterAll(async () => {
  await harness?.cleanup()
})

realDescribe('real fish shell in the headless profile', () => {
  it('owns the only active shell provider and replaces the bash tool', () => {
    // Given the actual base, headless, fish, RTK, and CodeGraph composition
    const providers = booted.shellProviders()

    // When the mounted shell and model-facing tool registries are inspected
    const tools = booted.toolNames()

    // Then fish is the sole shell surface and CodeGraph remains registered
    expect(providers).toEqual(['@banbolee/dsh-fish-shell'])
    expect(tools).toContain('fish')
    expect(tools).not.toContain('bash')
    expect(tools).toContain('mcp__codegraph__codegraph_explore')
  })

  it('executes fish-only syntax with quoting, cwd, environment, and full access', async () => {
    // Given one full-access shell request carrying explicit cwd and environment
    const request = {
      command: 'set first "a b"; set second \'c"d\'; set joined (string join "|" "$first" "$second"); math "1 + 2"; printf "%s\\n%s\\n%s\\n" "$joined" "$PWD" "$REAL_E2E_ENV"',
      workdir: harness.profile,
      env: { REAL_E2E_ENV: 'env value' },
      sandboxPolicy: {
        mode: 'danger-full-access',
        workspaceRoot: harness.profile,
      },
    } as const

    // When the mounted real fish provider executes it
    const result = await booted.runShell(request)

    // Then fish semantics and transport facts are preserved
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe(`3\na b|c"d\n${harness.profile}\nenv value\n`)
    expect(result.stderr.text).toBe('')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
  })

  it('executes fish-only syntax inside the workspace under confinement', async () => {
    // Given a safe fish-only command confined to the isolated harness workspace
    const request = {
      command: 'set value workspace; if test "$value" = workspace; echo confined-fish; end',
      workdir: harness.profile,
      sandboxPolicy: {
        mode: 'workspace-write',
        workspaceRoot: harness.profile,
      },
    } as const

    // When the mounted real fish provider executes it through the sandbox
    const result = await booted.runShell(request)

    // Then execution succeeds and reports the exact confined sandbox facts
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('confined-fish\n')
    expect(result.stderr.text).toBe('')
    expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: false })
  })

  it('starts each shell call with fresh process state', async () => {
    // Given one call that defines an exported fish variable
    const first = await booted.runShell({
      command: 'set -gx REAL_E2E_EPHEMERAL persisted; echo $REAL_E2E_EPHEMERAL',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.profile },
    })

    // When a second real fish process reads the same name
    const second = await booted.runShell({
      command: 'if set -q REAL_E2E_EPHEMERAL; echo leaked; else; echo fresh; end',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.profile },
    })

    // Then state from the first process did not survive
    expect(first.stdout.text).toBe('persisted\n')
    expect(second.stdout.text).toBe('fresh\n')
  })

  it('returns nonzero exits and stderr without converting them to infrastructure errors', async () => {
    // Given a fish command with observable stderr and a nonzero status
    const command = 'echo real-fish-stderr >&2; exit 7'

    // When the mounted provider executes it
    const result = await booted.runShell({
      command,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.profile },
    })

    // Then the result carries exact process facts
    expect(result.exitCode).toBe(7)
    expect(result.stderr.text).toBe('real-fish-stderr\n')
    expect(result.timedOut).toBe(false)
  })

  it('reports stable process facts when a fish command times out', async () => {
    // Given a real fish command that exceeds its explicit short timeout
    const command = 'sleep 2'

    // When the mounted provider executes it with a 200ms bound
    const result = await booted.runShell({
      command,
      timeoutMs: 200,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.profile },
    })

    // Then timeout and process termination are machine-observable
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(null)
    expect(result.signal).not.toBe(null)
  })

  it('denies a harmless write outside the workspace root', async () => {
    // Given a sentinel outside the policy root but inside the isolated harness tree
    const workspaceRoot = join(harness.profile, 'workspace')
    const sentinel = join(harness.profile, 'workspace-denied-sentinel')
    mkdirSync(workspaceRoot, { recursive: true })

    // When fish attempts to create it under workspace-write confinement
    const result = await booted.runShell({
      command: `touch ${sentinel}; test -e ${sentinel}; or exit 73`,
      workdir: workspaceRoot,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot },
    })

    // Then the sandbox reports denial and no sentinel reaches disk
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
    expect(existsSync(sentinel)).toBe(false)
  })

  it('fails when fish is missing and never falls back to bash', async () => {
    // Given the real provider with a child PATH that cannot resolve fish
    const command = 'echo must-not-run'

    // When it attempts danger-full-access execution
    const execution = booted.runShell({
      command,
      env: { PATH: harness.home },
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.profile },
    })

    // Then process creation fails instead of running the command through bash
    await expect(execution).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
