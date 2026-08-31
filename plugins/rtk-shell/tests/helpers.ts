import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import rtkShellPlugin from '../index.js'

const FIXTURES_BIN = fileURLToPath(new URL('../../../tests/fixtures/bin/', import.meta.url))
const UNIX_SIGNATURES = ['read-only file system', 'permission denied'] as const
const RUNNER_FAILURE = [{ fatalSignatures: ['fake-runner: '] }] as const
const spillDirs: string[] = []

export const READ_ONLY_SANDBOX = { mode: 'read-only', denied: false, enforcement: 'full' } as const

export interface ConfineCall {
  readonly argv: readonly string[]
  readonly policy: SandboxPolicy
}

export interface RtkShellHarness {
  readonly ctx: Context
  readonly shell: SandboxBashExecutor
  readonly calls: ConfineCall[]
}

export type ConfineDelegate = (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv

export interface RtkShellHarnessConfig {
  readonly mode?: SandboxMode
  readonly rewriteTimeoutMs?: number
  readonly workspaceRoot?: string
  readonly grepCompress?: boolean
}

function passthrough(argv: readonly string[]): ConfinedArgv {
  return { argv: [...argv], enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }
}

export function installFakeRtkPathHooks(): void {
  let originalPath: string | undefined
  beforeAll(() => {
    originalPath = process.env.PATH
    process.env.PATH = `${FIXTURES_BIN}${delimiter}${originalPath ?? ''}`
  })
  afterEach(() => {
    delete process.env.FAKE_RTK_MODE
    delete process.env.FAKE_RTK_PIPE_MODE
  })
  afterAll(() => {
    process.env.PATH = originalPath ?? ''
    for (const spillDir of spillDirs.splice(0)) {
      rmSync(spillDir, { recursive: true, force: true })
    }
  })
}

export async function createRtkShellHarness(
  config: RtkShellHarnessConfig = {},
  confine: ConfineDelegate = passthrough,
): Promise<RtkShellHarness> {
  const { mode, workspaceRoot, ...execConfig } = config
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      calls.push({ argv: [...argv], policy })
      return confine(argv, policy)
    }
  }
  const ctx = new Context()
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, {
    ...(mode !== undefined ? { mode } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  })
  await ctx.plugin(LocalSubprocessRuntime)
  const spillDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-shell-spec-'))
  spillDirs.push(spillDir)
  const subprocess = ctx.subprocess
  if (!(subprocess instanceof LocalSubprocessRuntime)) {
    throw new TypeError('expected LocalSubprocessRuntime')
  }
  subprocess.internals = { spillDir }
  // Mount a REAL base shell provider as ctx.shell, then decorate it with the
  // rtk function plugin (design A1: the plugin wraps the live ctx.shell's
  // run/start instead of replacing the shell provider). Design B1 also
  // injects the `tools` runtime, so provide a minimal stand-in here — the
  // plugin only registers a `tools/post-execute` listener against it and
  // never invokes a tool through it.
  await ctx.provide('tools', {})
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
  await ctx.plugin(rtkShellPlugin, execConfig)
  const shell = ctx.shell
  if (!(shell instanceof SandboxBashExecutor)) {
    throw new TypeError('expected SandboxBashExecutor')
  }
  return { ctx, shell, calls }
}
