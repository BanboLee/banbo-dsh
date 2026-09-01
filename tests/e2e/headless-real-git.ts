/// <reference types="node" />

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SSH_BOOTSTRAP_ENV = new Set(['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'])

function isAmbientGitSetting(name: string): boolean {
  return name.startsWith('GIT_') || name.startsWith('GCM_') || SSH_BOOTSTRAP_ENV.has(name)
}

function isolatedGitEnvironment(emptyConfig: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !isAmbientGitSetting(name)),
    ),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
  }
}

type GitRunOptions = {
  readonly gitDir: string
  readonly workTree: string
  readonly emptyConfig: string
  readonly args: readonly string[]
}

function runGit(options: GitRunOptions): void {
  const result = spawnSync(
    'git',
    [`--git-dir=${options.gitDir}`, `--work-tree=${options.workTree}`, ...options.args],
    {
      cwd: options.workTree,
      env: isolatedGitEnvironment(options.emptyConfig),
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  if (result.status !== 0) {
    throw new Error(`disposable git setup failed (${result.status ?? 'signal'}):\n${result.stdout}${result.stderr}`)
  }
}

export function initializeGitFixture(dshHome: string): string {
  const gitProject = join(dshHome, 'git-project')
  const gitDir = join(gitProject, '.git')
  const templateDir = join(dshHome, 'empty-git-template')
  const emptyConfig = join(dshHome, 'empty-git-config')
  mkdirSync(gitProject, { recursive: true })
  mkdirSync(templateDir, { recursive: true })
  writeFileSync(emptyConfig, '')
  writeFileSync(join(gitProject, 'fixture.txt'), 'real headless fixture\n')
  runGit({ gitDir, workTree: gitProject, emptyConfig, args: ['init', `--template=${templateDir}`] })
  runGit({ gitDir, workTree: gitProject, emptyConfig, args: ['config', 'user.name', 'Real Headless E2E'] })
  runGit({ gitDir, workTree: gitProject, emptyConfig, args: ['config', 'user.email', 'real-headless@example.invalid'] })
  runGit({ gitDir, workTree: gitProject, emptyConfig, args: ['add', 'fixture.txt'] })
  runGit({ gitDir, workTree: gitProject, emptyConfig, args: ['commit', '-m', 'fixture'] })
  return gitProject
}
