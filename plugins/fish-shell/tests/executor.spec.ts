/**
 * Deterministic tests for this bundle's executors against the 0.1.7-rc.2
 * `ShellExecutor` API: the ONE entry point the host calls (`execute`), and the
 * argv that actually reaches the process substrate — which must stay the fish
 * dialect (`fish -c <command>`) both unconfined (`danger-full-access`) and
 * through the sandbox provider's confinement (`fish -c` must be the argv the
 * sandbox wraps; a `bash -c` here would silently run bash instead of fish).
 *
 * The executors are the REAL classes from the installed
 * `@deepseek-ai/dsh-bash-sandbox` / `@deepseek-ai/dsh-bash-local`, mounted on a
 * real Cordis context; only the process substrate (`ctx.subprocess`), the
 * sandbox provider, and the policy service are fakes — so the assertions cover
 * the production argv path without spawning a real shell. The 0.1.5 entry
 * points (`run`, `start`, `runArgv`, `startArgv`) are asserted ABSENT: the
 * harness never calls them, so an override left there is silently bypassed.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FishSandboxExecutor } from '../index.js'
import { FishLocalExecutor } from '../local.js'

/** One collect-mode reader over a fixed text (the subprocess seam's shape). */
function reader(text: string) {
  return {
    readFrom: (fromByte: number) => ({ text: text.slice(fromByte), nextOffset: text.length, lossy: false }),
  }
}

interface SpawnRecord {
  argv: readonly string[]
  cwd: string
  env: Record<string, string>
  graceMs: number
  signal?: AbortSignal
}

/** A minimal `SubprocessHandle`: collected readers plus settled exit facts. */
function fakeSubprocess(records: SpawnRecord[], stdout = 'fish says hi\n') {
  return {
    spawn: vi.fn((spec: SpawnRecord) => {
      records.push(spec)
      return {
        collected: { stdout: reader(stdout), stderr: reader('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
      }
    }),
  }
}

interface Confinement {
  argv: readonly string[]
  policy: { mode: string }
}

/** Mount the REAL sandbox fish executor over fake seams. */
async function mountSandboxExecutor(mode = 'workspace-write') {
  const spawned: SpawnRecord[] = []
  const confinements: Confinement[] = []
  const ctx = new Context()
  ctx.provide('subprocess', fakeSubprocess(spawned) as never)
  ctx.provide('sandbox', {
    confine: vi.fn(async (argv: readonly string[], policy: { mode: string }) => {
      confinements.push({ argv: [...argv], policy })
      return {
        argv: ['sandbox-runner', ...argv],
        enforcement: 'full' as const,
        denialSignatures: [],
        runnerFailureRules: [],
      }
    }),
  } as never)
  ctx.provide('sandboxPolicy', {
    defaultMode: mode,
    resolve: vi.fn(() => ({ mode, workspaceRoot: '/ws' })),
  } as never)
  await ctx.plugin(FishSandboxExecutor, { cwd: '/ws' })
  return { ctx, shell: ctx.shell, spawned, confinements }
}

describe('FishSandboxExecutor over the 0.1.7-rc.2 execute API', () => {
  it('runs a danger-full-access command as `fish -c` without asking the sandbox provider', async () => {
    const { shell, spawned, confinements } = await mountSandboxExecutor('danger-full-access')

    const execution = await shell.execute(shell.resolve({ command: 'echo hi' }))
    const result = await execution.result()

    // The argv handed to the process substrate IS the fish dialect.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.argv).toEqual(['fish', '-c', 'echo hi'])
    // Full access stays unconfined, exactly like the base class.
    expect(confinements).toHaveLength(0)
    // ...and still carries the base class's full-access sandbox fact.
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(result.exitCode).toBe(0)
  })

  it('confines the `fish -c` argv (never `bash -c`) under a confined mode', async () => {
    const { shell, spawned, confinements } = await mountSandboxExecutor('workspace-write')

    const execution = await shell.execute(shell.resolve({ command: 'echo $version' }))
    const result = await execution.result()

    // The fish dialect proof for the confined path: the provider is asked to
    // wrap `fish -c <command>`, and the wrapped argv is what gets spawned.
    expect(confinements).toHaveLength(1)
    expect(confinements[0]?.argv).toEqual(['fish', '-c', 'echo $version'])
    expect(confinements[0]?.policy.mode).toBe('workspace-write')
    expect(spawned[0]?.argv).toEqual(['sandbox-runner', 'fish', '-c', 'echo $version'])
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  })

  it('publishes one handle per execute call, with the settled facts on it', async () => {
    const { shell } = await mountSandboxExecutor('danger-full-access')

    const execution = await shell.execute(shell.resolve({ command: 'sleep 1' }))

    expect(typeof execution.kill).toBe('function')
    expect(execution.observed.stdout.readFrom(0).text).toBe('fish says hi\n')
    await execution.done
    expect(execution.status).toBe('completed')
    expect(execution.exitCode).toBe(0)
    expect(await execution.result()).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
  })

  it('arms no deadline under `onExpiry: none` and one under the foreground default', async () => {
    const { shell, spawned } = await mountSandboxExecutor('danger-full-access')

    // The background-job lane: `onExpiry: 'none'` spawns with the caller's own
    // signal only, so no executor timer can kill a long-running job. (`'none'`
    // is what 0.1.5's `start()` did — it never built a `deadline(...)` — and
    // what the official 0.1.7 tool-bash resolves its job lane with.)
    const job = shell.resolve({ command: 'sleep 300', timeoutMs: 5, onExpiry: 'none' })
    await shell.execute(job)
    expect(job.onExpiry).toBe('none')
    expect(spawned[0]?.signal).toBeUndefined()

    // The foreground lane keeps the executor's `kill` default: the spawn
    // carries a fused deadline signal, so expiry still kills the command.
    const foreground = shell.resolve({ command: 'sleep 300', timeoutMs: 5 })
    expect(foreground.onExpiry).toBe('kill')
    await shell.execute(foreground)
    expect(spawned[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('FishLocalExecutor over the 0.1.7-rc.2 execute API', () => {
  it('runs `fish -c` with the resolved workdir and the managed environment', async () => {
    const spawned: SpawnRecord[] = []
    const ctx = new Context()
    ctx.provide('subprocess', fakeSubprocess(spawned) as never)
    await ctx.plugin(FishLocalExecutor, { cwd: '/ws' })

    const execution = await ctx.shell.execute(ctx.shell.resolve({
      command: 'echo $version',
      dshEnv: { DSH_SESSION_ID: 's1' },
    }))
    const result = await execution.result()

    expect(spawned[0]?.argv).toEqual(['fish', '-c', 'echo $version'])
    expect(spawned[0]?.cwd).toBe('/ws')
    // The model-friendly environment is still applied, with the harness-owned
    // `DSH_*` snapshot merged last.
    expect(spawned[0]?.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      DSH_SESSION_ID: 's1',
    })
    expect(result.exitCode).toBe(0)
    expect(result.sandbox).toBeUndefined()
  })
})

describe('executor surface', () => {
  it('exposes the new entry points and no legacy one the host would bypass', () => {
    for (const cls of [FishSandboxExecutor, FishLocalExecutor]) {
      for (const legacy of ['run', 'start', 'runArgv', 'startArgv']) {
        expect(legacy in cls.prototype, `${cls.name}.${legacy} must not exist`).toBe(false)
      }
      // The shell swap is defined HERE, on the entry the host actually calls.
      expect(Object.hasOwn(cls.prototype, 'execute'), `${cls.name}.execute`).toBe(true)
    }
    // `confine()` is the base class's confined-execution boundary
    // (`SandboxBashExecutor.execute` dispatches to it virtually); the fish
    // override must be this subclass's own method.
    expect(Object.hasOwn(FishSandboxExecutor.prototype, 'confine')).toBe(true)
  })
})
