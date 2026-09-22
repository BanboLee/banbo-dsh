/** Single named delegation lifecycle — plan §10.3–§10.5/§11.1.1. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RootBudgetRegistry } from '../budget.js'
import {
  delegateOne,
  releaseContinuableLease,
} from '../delegation.js'
import { HolderRegistry } from '../holder-registry.js'
import { readChildIdentity } from '../identity.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function state(continuation: 'one-shot' | 'optional' = 'one-shot') {
  const rootDir = mkdtempSync(join(tmpdir(), 'banbo-delegate-one-'))
  scratch.push(rootDir)
  const definitions = new Map([
    ['lead', {
      id: 'lead',
      allowedChildren: ['worker'],
      main: {
        presetId: 'lead-preset', persona: 'lead.md', tools: ['read'], maxDepth: 2,
        budget: {
          maxConcurrentChildren: 2,
          maxBatchWidth: 2,
          foregroundDeadlineMs: 100,
          backgroundDeadlineMs: 200,
          batchDeadlineMs: 150,
          drainGraceMs: 10,
        },
      },
    }],
    ['worker', {
      id: 'worker',
      allowedChildren: [],
      child: {
        model: { default: true }, persona: 'worker.md', guidance: 'Do work.',
        tools: ['read'], continuation,
      },
    }],
  ])
  return {
    rootDir,
    generation: 'gen-now',
    definitions,
    personas: new Map([['lead.md', '# Lead\n'], ['worker.md', '# Worker\n']]),
    abi: { agents: [
      { id: 'lead', toolName: 'agent_lead', hasMain: true, presetId: 'lead-preset' },
      { id: 'worker', toolName: 'agent_worker', hasChild: true },
    ] },
    settings: {
      policy(agentId: string) {
        const definition = definitions.get(agentId)
        return {
          agentId, definition, exists: definition !== undefined, retired: false,
          effectiveEnabled: definition !== undefined,
          model: definition?.child?.model,
        }
      },
    },
  }
}

function parent() {
  return {
    id: 'root-session',
    options: { provider: 'parent', model: 'model' },
    session: { header: { agentPreset: 'lead-preset' } },
  }
}

const registered = new Set(['read', 'read_image', 'agent_worker', 'delegate_batch'])

function runFixture() {
  const result = deferred<any>()
  const dispose = vi.fn(async () => {})
  return {
    run: { id: 'child-one', localAgent: undefined, result: result.promise, dispose },
    result,
    dispose,
  }
}

function runtime(options: {
  continuation?: 'one-shot' | 'optional'
  run?: ReturnType<typeof runFixture>
  delay?: (ms: number) => Promise<void>
  jobs?: any
} = {}) {
  const service = state(options.continuation)
  const fixture = options.run ?? runFixture()
  const budgets = new RootBudgetRegistry()
  const holders = new HolderRegistry({ delay: options.delay })
  const liveIdentities = new Map()
  const continuableLeases = new Map()
  const subagents = {
    start: vi.fn(async () => fixture.run),
    startContinuable: vi.fn(async (spec) => {
      expect(readChildIdentity(service.rootDir, spec.childId)).toMatchObject({ agentId: 'worker' })
      return { childId: spec.childId, messageId: 'message-1' }
    }),
  }
  return {
    service,
    fixture,
    budgets,
    holders,
    liveIdentities,
    continuableLeases,
    observations: new Map(),
    subagents,
    jobs: options.jobs,
    configuredMainAgentId: 'lead',
    composedPreset: 'lead-preset',
    registered,
    isToolVisible: () => true,
    createChildId: () => 'reserved-child',
    delay: options.delay,
  }
}

const call = (rt: ReturnType<typeof runtime>, runInBackground = false, signal = new AbortController().signal) => delegateOne(rt as never, {
  parent: parent() as never,
  targetAgentId: 'worker',
  prompt: 'Do the task.',
  description: 'bounded task',
  runInBackground,
  signal,
})

describe('foreground one-shot', () => {
  it('registers identity immediately after publication, returns output, and cleans every owner', async () => {
    const rt = runtime()
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    expect(rt.holders.size).toBe(1)
    expect(rt.budgets.running('root-session')).toBe(1)
    expect(rt.liveIdentities.get('child-one')).toMatchObject({ agentId: 'worker', rootSessionId: 'root-session' })

    rt.fixture.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    await expect(pending).resolves.toMatchObject({
      kind: 'foreground', agentId: 'worker', childId: 'child-one', status: 'completed', result: 'done',
    })
    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.holders.size).toBe(0)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
    expect(existsSync(join(rt.service.rootDir, '.children'))).toBe(false)
  })

  it('releases the lease and settles the holder when the published run result rejects', async () => {
    // The official `SubagentRun` contract permits `result` to reject on an
    // infrastructure fault. That path must not leak the concurrency lease, the
    // holder, or the live identity.
    const rt = runtime()
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))

    rt.fixture.result.reject(new Error('infrastructure-fault'))
    await expect(pending).rejects.toThrow(/infrastructure-fault/)

    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.holders.size).toBe(0)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
    // The observation map must hold only currently-alive children: a rejected
    // result skips the end-log path, so cleanup owns dropping the entry.
    expect(rt.observations.size).toBe(0)
  })

  it('returns a failed terminal with partial text for non-completed stop reasons', async () => {
    const rt = runtime()
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalled())
    rt.fixture.result.resolve({
      stopReason: 'max-tokens',
      output: [{ type: 'text', text: 'partial' }],
      diagnostic: 'limit reached',
    })
    await expect(pending).resolves.toMatchObject({
      status: 'failed', stopReason: 'max-tokens', result: 'partial', error: 'limit reached',
    })
    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels at deadline, waits grace, and reports cancel_requested when dispose settles', async () => {
    const deadline = deferred<void>()
    const grace = deferred<void>()
    let waits = 0
    const rt = runtime({ delay: () => (++waits === 1 ? deadline.promise : grace.promise) })
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalled())
    deadline.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'cancel_requested' })
    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.budgets.running('root-session')).toBe(0)
  })

  it('hands a non-cooperating holder to the registry and returns cleanup_deferred', async () => {
    const deadline = deferred<void>()
    const grace = deferred<void>()
    let waits = 0
    const rt = runtime({
      delay: () => (++waits === 1 ? deadline.promise : grace.promise),
    })
    rt.fixture.run.dispose = vi.fn(() => new Promise<void>(() => {}))
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalled())
    deadline.resolve()
    await Promise.resolve()
    grace.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'cleanup_deferred' })
    expect(rt.holders.size).toBe(1)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(1)
  })

  it('releases a reservation when start rejects before publication', async () => {
    const rt = runtime()
    rt.subagents.start.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(call(rt)).rejects.toThrow(/provider unavailable/)
    expect(rt.holders.size).toBe(0)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
  })
})

describe('optional background → continuable', () => {
  it('writes the sidecar before startContinuable and holds budget until subagent/end', async () => {
    const rt = runtime({ continuation: 'optional' })
    await expect(call(rt, true)).resolves.toMatchObject({
      kind: 'continuable', agentId: 'worker', childId: 'reserved-child', status: 'started',
    })
    expect(rt.subagents.start).not.toHaveBeenCalled()
    expect(rt.subagents.startContinuable).toHaveBeenCalledTimes(1)
    expect(readChildIdentity(rt.service.rootDir, 'reserved-child')).toMatchObject({
      agentId: 'worker', mainAgentId: 'lead', rootSessionId: 'root-session',
    })
    expect(rt.budgets.running('root-session')).toBe(1)
    expect(releaseContinuableLease(rt as never, 'reserved-child')).toBe(true)
    expect(releaseContinuableLease(rt as never, 'reserved-child')).toBe(false)
    expect(rt.budgets.running('root-session')).toBe(0)
  })

  it('rolls back sidecar and budget when creation fails', async () => {
    const rt = runtime({ continuation: 'optional' })
    rt.subagents.startContinuable.mockRejectedValueOnce(new Error('cannot create'))
    await expect(call(rt, true)).rejects.toThrow(/cannot create/)
    expect(readChildIdentity(rt.service.rootDir, 'reserved-child')).toBeUndefined()
    expect(rt.budgets.running('root-session')).toBe(0)
  })

  it('optional foreground remains one-shot', async () => {
    const rt = runtime({ continuation: 'optional' })
    const pending = call(rt, false)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    expect(rt.subagents.startContinuable).not.toHaveBeenCalled()
    rt.fixture.result.resolve({ stopReason: 'completed', output: [] })
    await expect(pending).resolves.toMatchObject({ kind: 'foreground', status: 'empty' })
  })
})

describe('one-shot background job', () => {
  it('rejects before creating a child when jobs are unavailable', async () => {
    const rt = runtime()
    await expect(call(rt, true)).rejects.toThrow(/jobs|background/i)
    expect(rt.subagents.start).not.toHaveBeenCalled()
    expect(rt.budgets.running('root-session')).toBe(0)
  })

  it('registers an owned job whose hooks settle and clean the one-shot run', async () => {
    let hooks: any
    const jobs = {
      start: vi.fn((spec) => {
        expect(spec.owner.id).toBe('root-session')
        hooks = spec.run()
        return 'subagent-1'
      }),
    }
    const rt = runtime({ jobs })
    await expect(call(rt, true)).resolves.toEqual({
      kind: 'background', agentId: 'worker', jobId: 'subagent-1', status: 'started',
    })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    rt.fixture.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'background done' }] })
    await expect(hooks.done).resolves.toEqual({ status: 'completed', output: 'background done' })
    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
  })

  it('settles a background job whose published run result rejects', async () => {
    let hooks: any
    const jobs = {
      start: vi.fn((spec) => {
        hooks = spec.run()
        return 'subagent-2'
      }),
    }
    const rt = runtime({ jobs })
    await call(rt, true)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))

    rt.fixture.result.reject(new Error('infrastructure-fault'))
    await expect(hooks.done).resolves.toMatchObject({ status: 'failed' })

    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.holders.size).toBe(0)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
    // Symmetry with the foreground and batch rejection cases.
    expect(rt.observations.size).toBe(0)
  })

  it('kills a background run at its own deadline and frees the concurrency slot', async () => {
    // §14.1 item 9: `backgroundDeadlineMs` expiry must cancel, wait the grace,
    // and release the slot — a hung background run may not strand it.
    let hooks: any
    const jobs = {
      start: vi.fn((spec) => { hooks = spec.run(); return 'subagent-3' }),
    }
    const deadline = deferred<void>()
    const grace = deferred<void>()
    let waits = 0
    const rt = runtime({ jobs, delay: () => (++waits === 1 ? deadline.promise : grace.promise) })
    await call(rt, true)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))

    deadline.resolve()
    await expect(hooks.done).resolves.toMatchObject({
      status: 'killed', detail: expect.stringMatching(/background deadline/i),
    })
    expect(rt.fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.holders.size).toBe(0)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
  })

  it('defers a non-cooperating background run to the registry and still frees the slot', async () => {
    let hooks: any
    const jobs = {
      start: vi.fn((spec) => { hooks = spec.run(); return 'subagent-4' }),
    }
    const deadline = deferred<void>()
    const grace = deferred<void>()
    let waits = 0
    const rt = runtime({ jobs, delay: () => (++waits === 1 ? deadline.promise : grace.promise) })
    rt.fixture.run.dispose = vi.fn(() => new Promise<void>(() => {}))
    await call(rt, true)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))

    deadline.resolve()
    await Promise.resolve()
    grace.resolve()
    await expect(hooks.done).resolves.toMatchObject({
      status: 'failed', detail: expect.stringMatching(/cleanup deferred|HolderRegistry/i),
    })
    // Ownership stays with the registry, but width capacity is released so one
    // hung provider cannot exhaust every root slot.
    expect(rt.holders.size).toBe(1)
    expect(rt.budgets.running('root-session')).toBe(0)
    expect(rt.liveIdentities.size).toBe(1)
  })
})
