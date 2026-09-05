import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import rtkShellPlugin from '../index.js'

const FIXTURES_BIN = fileURLToPath(new URL('../../../tests/fixtures/bin/', import.meta.url))
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
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
  readonly shellTarget: SandboxBashExecutor
  readonly calls: ConfineCall[]
  readonly mounts: readonly Fiber[]
  readonly originalRun: SandboxBashExecutor['run']
  readonly originalStart: SandboxBashExecutor['start']
}

export type ConfineDelegate = (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv

export interface RtkShellHarnessConfig {
  readonly mode?: SandboxMode
  readonly mounts?: number
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
  const { mode, mounts: mountCount = 1, workspaceRoot, ...execConfig } = config
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      calls.push({ argv: [...argv], policy })
      return confine(argv, policy)
    }
  }
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, {
    ...(mode !== undefined ? { mode } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  })
  await ctx.plugin(LocalSubprocessRuntime)
  const spillDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-spec-'))
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
  ctx.provide('tools', {})
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
  const shell = ctx.shell
  if (!(shell instanceof SandboxBashExecutor)) {
    throw new TypeError('expected SandboxBashExecutor')
  }
  const originalShell = Reflect.get(shell, CORDIS_ORIGINAL)
  const shellTarget = originalShell instanceof SandboxBashExecutor ? originalShell : shell
  const originalRun = shellTarget.run
  const originalStart = shellTarget.start
  const mounts: Fiber[] = []
  for (let index = 0; index < mountCount; index += 1) {
    mounts.push(await ctx.plugin(rtkShellPlugin, execConfig))
  }
  return { ctx, shell, shellTarget, calls, mounts, originalRun, originalStart }
}
