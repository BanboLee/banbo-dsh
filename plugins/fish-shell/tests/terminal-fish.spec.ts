/**
 * Deterministic tests for this bundle's fish PTY backend (`terminal-fish.js`)
 * against the 0.1.7-rc.2 seams. Three real defects lived here uncovered,
 * because the backend had no unit test, the real PTY lane only ran
 * `danger-full-access`, and the composition test double returned a SYNCHRONOUS
 * `confine()` result:
 *
 *   - the confined branch read `.argv` off the sandbox provider's PROMISE
 *     (`SandboxProvider.confine` is async in 0.1.7-rc.2), so every confined
 *     persistent spawn failed before starting fish;
 *   - `spawnTerminal` omitted the now-required `terminalType`, which the
 *     provider advertises as the child's `TERM` (overwriting `env`), leaving
 *     the readiness contract's `TERM=dumb` unset;
 *   - a throwing session factory leaked the freshly allocated terminal.
 *
 * Each test below FAILS against the pre-fix code (verified by reverting the
 * fix locally and re-running).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { TerminalBackendCleanupError } from '@deepseek-ai/dsh-terminal'
import { FishTerminalBackend, resolveConfig } from '../terminal-fish.js'

/** The default argv `resolveConfig({})` resolves to (fish, config-free, interactive). */
const FISH_ARGV = ['fish', '--no-config', '-i']

interface FakeSession {
  pid: number
  motd?: string
  status: () => { kind: 'running' }
  read: () => { text: string, lineEnd: number, totalLines: number, truncated: boolean }
  startSend: () => {
    done: Promise<{ sessionStatus: { kind: 'running' }, waitReason: string, viewport: string, truncated: boolean }>
    readOutput: () => { delta: string, truncated: boolean }
  }
  close: ReturnType<typeof vi.fn>
}

/** A session whose readiness never settles into `stdin_read` when `ready` is false. */
function fakeSession(ready: boolean): FakeSession {
  return {
    pid: 4242,
    status: () => ({ kind: 'running' as const }),
    read: () => ({ text: '', lineEnd: 0, totalLines: 0, truncated: false }),
    startSend: () => ({
      done: Promise.resolve({
        sessionStatus: { kind: 'running' as const },
        waitReason: ready ? 'stdin_read' : 'timeout',
        viewport: ready ? 'dsh> ' : '',
        truncated: false,
      }),
      readOutput: () => ({ delta: '', truncated: false }),
    }),
    close: vi.fn(async () => {}),
  }
}

interface MountOptions {
  mode?: string
  ready?: boolean
  timeoutMs?: number
  createSession?: (terminal: unknown, config: unknown) => unknown
  terminateFails?: boolean
}

interface BackendHarness {
  ctx: Context
  backend: FishTerminalBackend
  confinements: Array<{ argv: readonly string[], mode: string }>
  spawned: SubprocessTerminalSpawnSpec[]
  terminate: ReturnType<typeof vi.fn>
  session: FakeSession
}

async function mountBackend(options: MountOptions = {}): Promise<BackendHarness> {
  const {
    mode = 'workspace-write',
    ready = true,
    timeoutMs = 1000,
    createSession,
    terminateFails = false,
  } = options
  const ctx = new Context()
  const confinements: BackendHarness['confinements'] = []
  const spawned: BackendHarness['spawned'] = []
  const terminate = vi.fn(() => {
    if (terminateFails) throw new Error('terminate boom')
  })
  const session = fakeSession(ready)
  ctx.provide('sandboxPolicy', {
    defaultMode: mode,
    resolve: () => ({ mode, workspaceRoot: '/ws' }),
  } as never)
  // An ASYNC provider, exactly like the real `SandboxProvider.confine` in
  // 0.1.7-rc.2 — the defect was invisible only behind a synchronous double.
  ctx.provide('sandbox', {
    confine: vi.fn(async (argv: readonly string[], policy: { mode: string }) => {
      confinements.push({ argv: [...argv], mode: policy.mode })
      return {
        argv: ['sandbox-runner', ...argv],
        enforcement: 'full' as const,
        denialSignatures: [],
        runnerFailureRules: [],
      }
    }),
  } as never)
  const backend = new FishTerminalBackend(
    ctx,
    resolveConfig({ timeoutMs }),
    async (spec: SubprocessTerminalSpawnSpec) => {
      spawned.push(spec)
      // Only `terminate` is read by the backend; the rest of the real handle
      // (pid/output/done/write/…) is provider-owned and unused here.
      return { terminate } as unknown as SubprocessTerminalHandle
    },
    // The harness's factory is a minimal session double: only the members
    // `startupSession` reads exist on it.
    (createSession ?? (() => session)) as unknown as NonNullable<ConstructorParameters<typeof FishTerminalBackend>[3]>,
  )
  return { ctx, backend, confinements, spawned, terminate, session }
}

function ownerSpec(ctx: Context) {
  return {
    owner: { id: 'pty-owner', ctx, session: { header: { cwd: '/ws' } } },
    sessionId: 'pty-session-1',
    signal: new AbortController().signal,
  }
}

describe('FishTerminalBackend.spawn over the 0.1.7-rc.2 seams', () => {
  it.each(['workspace-write', 'read-only'])('awaits the async sandbox provider and spawns the confined argv under %s', async (mode) => {
    const harness = await mountBackend({ mode })

    const session = await harness.backend.spawn(ownerSpec(harness.ctx) as never)

    // The provider was asked to wrap the fish dialect argv...
    expect(harness.confinements).toEqual([{ argv: FISH_ARGV, mode }])
    // ...and the WRAPPED argv (not `undefined`) reached the terminal provider.
    expect(harness.spawned[0]?.argv).toEqual(['sandbox-runner', ...FISH_ARGV])
    expect(session).toBe(harness.session)
  })

  it('passes the `dumb` terminalType that the provider advertises as the child TERM', async () => {
    const harness = await mountBackend({ mode: 'danger-full-access' })

    await harness.backend.spawn(ownerSpec(harness.ctx) as never)

    // Full access needs no confinement call at all.
    expect(harness.confinements).toEqual([])
    // `terminalType` is REQUIRED in 0.1.7-rc.2 and the provider overwrites the
    // child's `TERM` with it, so it must be the `dumb` the fish prompt's
    // readiness contract is verified against (and match the env we hand over).
    expect(harness.spawned[0]?.terminalType).toBe('dumb')
    expect(harness.spawned[0]?.env?.TERM).toBe('dumb')
  })

  it('terminates the terminal when the session factory throws', async () => {
    const harness = await mountBackend({
      mode: 'workspace-write',
      createSession: () => {
        throw new Error('session factory exploded')
      },
    })

    await expect(harness.backend.spawn(ownerSpec(harness.ctx) as never))
      .rejects.toThrow('session factory exploded')
    // The freshly allocated PTY must not outlive the failed factory.
    expect(harness.terminate).toHaveBeenCalledTimes(1)
  })

  it('reports a terminate failure as TerminalBackendCleanupError instead of leaking quietly', async () => {
    const harness = await mountBackend({
      createSession: () => {
        throw new Error('session factory exploded')
      },
      terminateFails: true,
    })

    await expect(harness.backend.spawn(ownerSpec(harness.ctx) as never))
      .rejects.toBeInstanceOf(TerminalBackendCleanupError)
    expect(harness.terminate).toHaveBeenCalledTimes(1)
  })

  it('closes the session (and does not terminate the terminal) when readiness fails', async () => {
    const harness = await mountBackend({ mode: 'danger-full-access', ready: false, timeoutMs: 20 })

    await expect(harness.backend.spawn(ownerSpec(harness.ctx) as never))
      .rejects.toThrow(/did not reach readiness/)

    expect(harness.session.close).toHaveBeenCalledWith('PTY startup failed')
    expect(harness.terminate).not.toHaveBeenCalled()
  })
})
