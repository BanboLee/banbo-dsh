import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRealHeadlessHarness,
  type RealHeadlessHarness,
} from './headless-real-harness'

const REAL_E2E_ENABLED = process.env.RUN_REAL_HEADLESS_E2E === '1'
const realDescribe = REAL_E2E_ENABLED ? describe : describe.skip

const harnesses: RealHeadlessHarness[] = []

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()
    if (harness !== undefined) await harness.cleanup()
  }
})

realDescribe('real DSH headless profile', () => {
  it('boots the canonical base, headless, and local bundle stack', async () => {
    // Given an isolated profile loaded by the existing real dsh-app-boot seam
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const booted = await harness.boot()

    // When its loaded bundle provenance is inspected
    const bundleStack = booted.proof.installedBundles

    // Then it is the actual headless stack followed by every local plugin
    expect(bundleStack).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
      '@banbolee/dsh-fish-shell',
      '@banbolee/dsh-rtk',
      '@banbolee/dsh-codegraph-mcp',
    ])
  }, 120_000)

  it('removes isolated artifacts and restores every mutated environment variable', async () => {
    // Given a snapshot of every environment variable the real harness owns
    const names = [
      'DSH_HOME',
      'HOME',
      'PATH',
      'XDG_CONFIG_HOME',
      'CODEGRAPH_NO_DAEMON',
      'DO_NOT_TRACK',
      'CODEGRAPH_NO_UPDATE_CHECK',
      'TMPDIR',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GIT_SSH_COMMAND',
      'GIT_TERMINAL_PROMPT',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_TEMPLATE_DIR',
      'GIT_CONFIG',
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_DATE',
    ] as const
    const originalCwd = process.cwd()
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    delete process.env.GIT_TERMINAL_PROMPT
    process.env.SSH_AUTH_SOCK = '/test/agent.sock'
    process.env.GIT_ASKPASS = '/test/git-askpass'
    process.env.SSH_ASKPASS = '/test/ssh-askpass'
    process.env.GIT_SSH_COMMAND = 'ssh -F /test/config'
    process.env.GIT_DIR = join(process.cwd(), 'hostile.git')
    process.env.GIT_WORK_TREE = '/definitely/not/the-fixture'
    process.env.GIT_COMMON_DIR = '/definitely/not/common'
    process.env.GIT_OBJECT_DIRECTORY = '/definitely/not/objects'
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = '/definitely/not/alternates'
    process.env.GIT_TEMPLATE_DIR = '/definitely/not/templates'
    process.env.GIT_CONFIG = '/definitely/not/config'
    process.env.GIT_AUTHOR_NAME = 'Hostile Ambient Author'
    process.env.GIT_COMMITTER_DATE = '2001-01-01T00:00:00Z'
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const temporaryHome = harness.dshHome
    const remotes = spawnSync('git', ['-C', harness.gitProject, 'remote'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    const commit = spawnSync(
      'git',
      [
        `--git-dir=${join(harness.gitProject, '.git')}`,
        `--work-tree=${harness.gitProject}`,
        'log',
        '-1',
        '--format=%an|%cI',
      ],
      { encoding: 'utf8', timeout: 5_000 },
    )
    expect(process.env.SSH_AUTH_SOCK).toBeUndefined()
      expect(process.env.GIT_ASKPASS).toBeUndefined()
      expect(process.env.SSH_ASKPASS).toBeUndefined()
    expect(process.env.GIT_SSH_COMMAND).toBeUndefined()
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(remotes.status).toBe(0)
    expect(remotes.stdout).toBe('')
    expect(commit.status).toBe(0)
    expect(commit.stdout).toMatch(/^Real Headless E2E\|/)
    expect(commit.stdout).not.toContain('2001-01-01')
    await harness.boot()

      // When the whole harness is cleaned
      await harness.cleanup()
      harnesses.pop()

      // Then its temporary tree is gone and process environment is byte-for-byte restored
      expect(existsSync(temporaryHome)).toBe(false)
      expect(Object.fromEntries(names.map((name) => [name, process.env[name]]))).toEqual(before)
      expect(process.cwd()).toBe(originalCwd)
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }, 120_000)
})
