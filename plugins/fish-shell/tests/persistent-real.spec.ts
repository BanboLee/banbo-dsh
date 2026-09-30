/**
 * REAL persistent-fish integration test, gated behind `DSH_REAL_FISH_PTY=1`
 * (skipped otherwise, like the `RUN_REAL_HEADLESS_E2E` lane): a real Cordis
 * Context with NO `@deepseek-ai/dsh-terminal` registry — the key self-managed
 * requirement — plus the real `@deepseek-ai/dsh-subprocess-local` PTY
 * substrate, and this bundle's real `terminal-fish` backend driven directly
 * by the self-managed `persistent` tool. Verifies with real fish (4.0.0, must
 * exist on PATH once the gate is open — a missing fish fails loud rather than
 * skipping) that persistent semantics survive across calls, that timeouts
 * reset the shell, and that calls are serialized.
 *
 * It also drives the CONFINED spawn path (`workspace-write`) with a real PTY:
 * no real sandbox backend package is a dependency of this plugin, so the
 * `ctx.sandbox` provider here is an ASYNC argv recorder/passthrough (the real
 * `SandboxProvider.confine` is a promise, which is exactly what the backend
 * must await). The child's `TERM` is asserted from inside the PTY, because the
 * subprocess provider advertises `terminalType` as `TERM` (overwriting `env`).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { registerPersistentFish } from '../persistent.js'

const REAL_FISH_PTY = process.env.DSH_REAL_FISH_PTY === '1'

function findFish(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir.length === 0) continue
    const candidate = join(dir, 'fish')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const fishPath = findFish()
/**
 * The gate is the ONLY skip. Once `DSH_REAL_FISH_PTY=1` is open, a missing
 * `fish` FAILS in `beforeAll`: a silent skip would report green coverage that
 * never ran. (Unlike `terminal-session-real.spec.ts` this lane needs no `dsh`
 * CLI — it drives the backend through a real in-process Cordis Context.)
 */
const realDescribe = REAL_FISH_PTY ? describe : describe.skip

interface RealAgent {
  id: string
  ctx: Context
  session: { header: { cwd: string } }
}

let ctx: Context | undefined
let agent: RealAgent | undefined
let timeoutAgent: RealAgent | undefined
let confinedAgent: RealAgent | undefined
let workspace: string | undefined
let confinedWorkspace: string | undefined
/** Every `ctx.sandbox.confine(argv, policy)` the confined lane requested. */
const confineCalls: Array<{ argv: readonly string[], mode: string }> = []

async function execute(owner: RealAgent | undefined, command: string): Promise<string> {
  const tool = ctx?.tools.get('fish', owner as never)
  if (tool === undefined) throw new Error('persistent fish tool not visible')
  // The tool's `execute` only reads `exec.agent` and `exec.signal`; the rest
  // of the execution context (call identity, session) is harness-owned.
  const exec = {
    agent: owner,
    callId: `real-fish-${Math.random().toString(36).slice(2)}`,
    sessionId: 'real-fish-session',
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof tool.execute>[1]
  const result = await tool.execute({ command }, exec)
  return String(result)
}

beforeAll(async () => {
  if (!REAL_FISH_PTY) return
  if (fishPath === undefined) {
    throw new Error([
      'DSH_REAL_FISH_PTY=1 is open, but this lane cannot run:',
      '  - `fish` is not on PATH: install it (`apt-get install fish` on Linux, `brew install fish` on macOS) and re-run.',
      `PATH searched: ${process.env.PATH ?? ''}`,
      'This lane refuses to skip silently once its gate is open.',
    ].join('\n'))
  }
  workspace = mkdtempSync(join(tmpdir(), 'dsh-fish-real-'))
  confinedWorkspace = join(workspace, 'confined')
  mkdirSync(confinedWorkspace)
  confineCalls.length = 0
  const root = new Context()
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime, {})
  // NO @deepseek-ai/dsh-terminal registry: the self-managed persistent tool
  // must work without ctx.terminals (invisible at the host/agent plane).
  await root.plugin(LocalSubprocessRuntime)
  // The projection state used by the sandbox-mode fence (never queried here).
  root.provide('sessionProjections', { stateOf: () => undefined })
  // Confinement seams. The provider is ASYNC, exactly like the real
  // `SandboxProvider.confine` in 0.1.7-rc.2 (a synchronous double is what hid
  // the backend's un-awaited use), and it records every requested argv. The
  // mode is per calling session, so the confined agent below takes the
  // workspace-write path while every other agent stays unconfined.
  root.provide('sandbox', {
    confine: async (argv: readonly string[], policy: { mode: string }) => {
      confineCalls.push({ argv: [...argv], mode: policy.mode })
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    },
  })
  root.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    resolve: (options?: { session?: { header?: { cwd?: string } } }) =>
      options?.session?.header?.cwd === confinedWorkspace
        ? { mode: 'workspace-write', workspaceRoot: confinedWorkspace }
        : { mode: 'danger-full-access', workspaceRoot: workspace },
  })

  const host = await root.plugin({ name: 'persistent-real-host', inject: ['tools', 'systemPrompt'], apply() {} })
  const hostCtx = host.ctx

  // The agent object IS the scope key (dsh-agent-loop: createScope(loopCtx,
  // this)), so the same object is used for the tools lookup and exec.agent.
  const agentObject: RealAgent = {
    id: 'real-fish-agent',
    ctx: undefined as unknown as Context,
    session: { header: { cwd: workspace } },
  }
  const agentScope = createScope(hostCtx, agentObject)
  agentObject.ctx = agentScope.ctx
  agent = agentObject

  // A second agent whose persistent fish tool runs under a short internal
  // deadline (the tool's own timeoutMs, not an upstream abort) so the
  // timeout-reset path can be exercised quickly.
  const timeoutObject: RealAgent = {
    id: 'real-fish-timeout-agent',
    ctx: undefined as unknown as Context,
    session: { header: { cwd: workspace } },
  }
  const timeoutScope = createScope(hostCtx, timeoutObject)
  timeoutObject.ctx = timeoutScope.ctx
  timeoutAgent = timeoutObject

  // A third agent whose sessions resolve to `workspace-write`: its persistent
  // fish PTY must go through the confined spawn path (async confine +
  // terminalType) and still start, answer, and report `TERM=dumb`.
  const confinedObject: RealAgent = {
    id: 'real-fish-confined-agent',
    ctx: undefined as unknown as Context,
    session: { header: { cwd: confinedWorkspace } },
  }
  const confinedScope = createScope(hostCtx, confinedObject)
  confinedObject.ctx = confinedScope.ctx
  confinedAgent = confinedObject

  root.provide('agents', {
    get: (id: string) => (id === agent?.id ? agent : id === timeoutAgent?.id ? timeoutAgent : id === confinedAgent?.id ? confinedAgent : undefined),
  })

  // The persistent fish tool is registered at each agent scope, exactly like
  // policy.js does when it detects the minimal preset's persistent bash.
  registerPersistentFish(root, agent.ctx)
  registerPersistentFish(root, timeoutAgent.ctx, { timeoutMs: 500 })
  registerPersistentFish(root, confinedAgent.ctx)
  ctx = root
}, 60_000)

afterAll(async () => {
  await ctx?.fiber.dispose().catch(() => {})
  ctx = undefined
  agent = undefined
  timeoutAgent = undefined
  confinedAgent = undefined
  if (workspace !== undefined) {
    rmSync(workspace, { recursive: true, force: true })
    workspace = undefined
  }
  confinedWorkspace = undefined
})

realDescribe('real persistent fish PTY (DSH_REAL_FISH_PTY=1)', () => {
  it('keeps variables and cwd across calls in one persistent fish', async () => {
    const first = await execute(agent, 'set x 5; set -gx PERSIST_FISH_VAR "hello world"')
    expect(first).toContain('[Command finished with exit code 0]')

    const second = await execute(agent, 'echo got-$x')
    expect(second).toContain('got-5')

    const third = await execute(agent, 'echo $PERSIST_FISH_VAR')
    expect(third).toContain('hello world')

    const cwd = await execute(agent, 'cd /tmp; pwd')
    expect(cwd).toContain('/tmp')
    const still = await execute(agent, 'pwd')
    expect(still).toContain('/tmp')
  })

  it('keeps functions defined in an earlier call', async () => {
    await execute(agent, 'function dsh_probe_fn; echo fn-called; end')
    const out = await execute(agent, 'dsh_probe_fn')
    expect(out).toContain('fn-called')
  })

  it('reports the command exit status in the result', async () => {
    const failed = await execute(agent, 'false')
    expect(failed).toContain('[Command finished with exit code 1]')
    const ok = await execute(agent, 'true')
    expect(ok).toContain('[Command finished with exit code 0]')
  })

  it('serializes concurrent calls in submission order', async () => {
    const [a, b] = await Promise.all([
      execute(agent, 'echo first; sleep 0.3; echo first-done'),
      execute(agent, 'echo second; echo second-done'),
    ])
    // Both succeeded and the earlier call finished before the later one ran
    // (serialization is per owner; the second result carries no first output).
    expect(a).toContain('first-done')
    expect(b).toContain('second-done')
    expect(a.indexOf('first-done')).toBeGreaterThan(-1)
  })

  it('starts and answers through the CONFINED (workspace-write) spawn path with real fish', async () => {
    confineCalls.length = 0

    const out = await execute(confinedAgent, 'echo confined-persist-ok')
    expect(out).toContain('confined-persist-ok')
    expect(out).toContain('[Command finished with exit code 0]')

    // The backend awaited the async provider and spawned its (wrapped) argv:
    // the fish dialect reached `confine()` instead of the spawn reading
    // `.argv` off a promise (which failed every confined persistent spawn).
    expect(confineCalls.map((call) => call.argv)).toEqual([['fish', '--no-config', '-i']])
    expect(confineCalls[0]?.mode).toBe('workspace-write')

    // `terminalType` is what the subprocess provider advertises as the child's
    // TERM (it overwrites `env`), so the readiness contract's `TERM=dumb` is
    // observable inside the real PTY.
    const term = await execute(confinedAgent, 'echo TERM=$TERM')
    expect(term).toContain('TERM=dumb')
    expect(term).toContain('[Command finished with exit code 0]')
  }, 30_000)

  it('resets the shell when a command exceeds the deadline and the next call starts fresh', async () => {
    const timedOut = await execute(timeoutAgent, 'sleep 5')
    expect(timedOut).toContain('[Command timed out]')
    expect(timedOut).toContain('was reset')

    // The next call runs in a brand-new shell: earlier state is gone.
    // (Quoted form: fish 4 drops a bare word containing an undefined
    // variable entirely, so the value must be compared inside quotes.)
    const fresh = await execute(timeoutAgent, 'echo "after-reset-$x"')
    expect(fresh).toContain('after-reset-')
    expect(fresh).not.toContain('after-reset-5')
    expect(fresh).toContain('[Command finished with exit code 0]')
  }, 30_000)
})
