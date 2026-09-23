/** Batch one-shot delegation — plan §10.7 truth table and ownership. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RootBudgetRegistry } from '../budget.js'
import { delegateBatch } from '../delegation.js'
import { HolderRegistry } from '../holder-registry.js'

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

function service() {
  const rootDir = mkdtempSync(join(tmpdir(), 'banbo-batch-'))
  scratch.push(rootDir)
  const child = (id: string, continuation: 'one-shot' | 'optional' = 'one-shot') => ({
    id,
    allowedChildren: [],
    child: {
      model: { default: true }, persona: `${id}.md`, guidance: `${id} guidance`,
      tools: ['read'], continuation,
      // `delegate_batch` executes every item through `startOneShot`, which is
      // the same path a foreground single delegation takes — so a scoped target
      // must get its child-form guard here too (§16.12).
      ...(id === 'a' ? { writeScope: '.banbo-dsh/plans' } : {}),
      // §16.14: an always-kept Agent cannot be batched, because batch runs every
      // item one-shot and the child could then never be followed up.
      ...(id === 'kept' ? { preferBackground: true } : {}),
    },
  })
  const definitions = new Map<string, any>([
    ['lead', {
      id: 'lead', allowedChildren: ['a', 'b', 'optional', 'kept'],
      main: {
        presetId: 'lead-preset', persona: 'lead.md', tools: ['read'], maxDepth: 1,
        budget: {
          maxConcurrentChildren: 3,
          maxBatchWidth: 3,
          foregroundDeadlineMs: 100,
          backgroundDeadlineMs: 200,
          batchDeadlineMs: 150,
          drainGraceMs: 10,
        },
      },
    }],
    ['a', child('a')],
    ['b', child('b')],
    ['not-allowed', child('not-allowed')],
    ['optional', child('optional', 'optional')],
    ['kept', child('kept', 'optional')],
  ])
  return {
    rootDir,
    generation: 'gen',
    definitions,
    personas: new Map([...definitions.keys()].map((id) => [`${id}.md`, `# ${id}\n`])),
    abi: { agents: ([...definitions.keys()].map((id) => ({
      id, toolName: `agent_${id.replace(/-/g, '_')}`,
      hasMain: id === 'lead', hasChild: id !== 'lead',
      ...(id === 'lead' ? { presetId: 'lead-preset' } : {}),
    })) as any[]).concat([{ id: 'retired', toolName: 'agent_retired', hasChild: true, retired: true }]) },
    settings: {
      policy(agentId: string) {
        const definition = definitions.get(agentId)
        return {
          agentId, definition, exists: definition !== undefined, retired: agentId === 'retired',
          effectiveEnabled: definition !== undefined, model: definition?.child?.model,
        }
      },
    },
  }
}

function parent() {
  return { id: 'root', options: {}, session: { header: { agentPreset: 'lead-preset' } } }
}

const registered = new Set([
  'read', 'read_image', 'agent_a', 'agent_b', 'agent_not_allowed', 'agent_optional',
  'agent_retired', 'delegate_batch',
])

type Fixture = ReturnType<typeof runFixture>
function runFixture(id: string) {
  const result = deferred<any>()
  return {
    id,
    result,
    dispose: vi.fn(async () => {}),
    run: undefined as any,
  }
}

function runtime(fixtures: Fixture[], delay?: (ms: number) => Promise<void>, localAgent?: () => unknown) {
  const state = service()
  const budgets = new RootBudgetRegistry()
  const holders = new HolderRegistry({ delay })
  const liveIdentities = new Map()
  let index = 0
  const subagents = {
    start: vi.fn(async () => {
      const fixture = fixtures[index++]
      fixture.run = {
        id: fixture.id,
        localAgent: localAgent === undefined ? undefined : localAgent(),
        result: fixture.result.promise,
        dispose: fixture.dispose,
      }
      return fixture.run
    }),
  }
  return {
    service: state,
    budgets,
    holders,
    liveIdentities,
    continuableLeases: new Map(),
    observations: new Map(),
    subagents,
    configuredMainAgentId: 'lead',
    composedPreset: 'lead-preset',
    registered,
    isToolVisible: () => true,
    delay,
  }
}

const tasks = [
  { agentId: 'a', prompt: 'task a', description: 'A' },
  { agentId: 'b', prompt: 'task b', description: 'B' },
]

const call = (rt: ReturnType<typeof runtime>, input: any = {}) => delegateBatch(rt as never, {
  parent: parent() as never,
  tasks,
  signal: new AbortController().signal,
  ...input,
})

describe('contract preflight rejects the whole call before any start', () => {
  it('rejects width zero or above maxBatchWidth', async () => {
    for (const entries of [[], [...tasks, tasks[0], tasks[1]]]) {
      const rt = runtime([])
      await expect(call(rt, { tasks: entries })).rejects.toThrow(/maxBatchWidth|tasks|1.*3/i)
      expect(rt.subagents.start).not.toHaveBeenCalled()
    }
  })

  it('rejects invalid deadline rather than clamping', async () => {
    for (const deadlineMs of [0, -1, 1.5, 59_999, 1_800_001, Number.NaN, '60000']) {
      const rt = runtime([])
      await expect(call(rt, { deadlineMs }), String(deadlineMs)).rejects.toThrow(/deadline/i)
      expect(rt.subagents.start).not.toHaveBeenCalled()
    }
  })

  it('rejects unknown, retired and malformed items as contract errors', async () => {
    const invalid = [
      [{ agentId: 'unknown', prompt: 'x', description: 'x' }],
      [{ agentId: 'retired', prompt: 'x', description: 'x' }],
      [{ agentId: 'a', prompt: '', description: 'x' }],
      [{ agentId: 'a', prompt: 'x' }],
    ]
    for (const entries of invalid) {
      const rt = runtime([])
      await expect(call(rt, { tasks: entries }), JSON.stringify(entries)).rejects.toThrow()
      expect(rt.subagents.start).not.toHaveBeenCalled()
      expect(rt.budgets.running('root')).toBe(0)
    }
  })

  it('names the fix for an unknown target and for a retired definition', async () => {    const unknown = runtime([])
    await expect(call(unknown, { tasks: [{ agentId: 'unknown', prompt: 'x', description: 'x' }] }))
      .rejects.toThrow(/pick an Agent that has a child form/i)
    const retired = runtime([])
    await expect(call(retired, { tasks: [{ agentId: 'retired', prompt: 'x', description: 'x' }] }))
      .rejects.toThrow(/restore its YAML and restart, or pick another Agent/i)
    const deadline = runtime([])
    await expect(call(deadline, { deadlineMs: 1 })).rejects.toThrow(/\[60000, 1800000\]/)
  })

  it('refuses an always-kept target, because a batched child can never be followed up', async () => {
    // §16.14. Batch executes every item through `startOneShot`, so a batched
    // review would be exactly the one-shot outcome the declaration forbids.
    // Fanning out three reviews is still possible — as three background calls,
    // which is the path that keeps each of them resumable.
    const rt = runtime([])
    await expect(call(rt, { tasks: [{ agentId: 'kept', prompt: 'x', description: 'x' }] }))
      .rejects.toThrow(/always kept for follow-up work/i)
    await expect(call(rt, { tasks: [{ agentId: 'kept', prompt: 'x', description: 'x' }] }))
      .rejects.toThrow(/run_in_background: true/)
    // The refusal is contract-level: nothing starts, and no slot is taken.
    expect(rt.subagents.start).not.toHaveBeenCalled()
    expect(rt.budgets.running('root-session')).toBe(0)
  })

  it('reserves every batch slot atomically before the first start', async () => {
    const fixtures = [runFixture('a-1'), runFixture('b-1')]
    const rt = runtime(fixtures)
    rt.budgets.acquire('root', 2, 3)
    await expect(call(rt)).rejects.toThrow(/maxConcurrentChildren|exceed/i)
    expect(rt.subagents.start).not.toHaveBeenCalled()
    expect(rt.budgets.running('root')).toBe(2)
  })
})

describe('a continuable (optional) target is a legal batch item', () => {
  it('accepts it and runs it through the one-shot path, never startContinuable', async () => {
    // Batch executes EVERY item with `startOneShot`, so a target's
    // `continuation` never applies to this execution mode: an `optional` Agent
    // runs exactly as it does on a foreground single call. The removed
    // `batch-target-continuable` guard rejected the AGENT, not an execution mode.
    const fixture = runFixture('optional-child')
    const rt = runtime([fixture])
    const startContinuable = vi.fn(async () => {
      throw new Error('batch must never create a continuable child')
    })
    ;(rt.subagents as any).startContinuable = startContinuable
    const pending = call(rt, { tasks: [{ agentId: 'optional', prompt: 'optional task', description: 'O' }] })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    fixture.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'optional done' }] })
    await expect(pending).resolves.toEqual({
      status: 'completed',
      deadlineMs: 150,
      items: [{ agentId: 'optional', status: 'completed', result: 'optional done', stopReason: 'completed' }],
    })
    expect(rt.subagents.start, 'the optional target must reach a terminal state through the one-shot path')
      .toHaveBeenCalledTimes(1)
    expect(startContinuable, 'batch must never take the continuable path').not.toHaveBeenCalled()
    expect(fixture.dispose).toHaveBeenCalledTimes(1)
    expect(rt.budgets.running('root')).toBe(0)
  })
})

describe('authorization-level failures are per item', () => {
  it('continues legal items and reports only the unauthorised item failed', async () => {
    const fixture = runFixture('a-1')
    const rt = runtime([fixture])
    const pending = call(rt, { tasks: [
      { agentId: 'not-allowed', prompt: 'no', description: 'denied' },
      { agentId: 'a', prompt: 'yes', description: 'allowed' },
    ] })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    fixture.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] })
    await expect(pending).resolves.toEqual({
      status: 'partial_failed',
      deadlineMs: 150,
      items: [
        expect.objectContaining({ agentId: 'not-allowed', status: 'failed', error: expect.stringMatching(/authoris|allowedChildren/i) }),
        { agentId: 'a', status: 'completed', result: 'ok', stopReason: 'completed' },
      ],
    })
  })
})

describe('allSettled and aggregation truth table', () => {
  it('completed + empty aggregates completed and maps identities per exact run id', async () => {
    const a = runFixture('child-a')
    const b = runFixture('child-b')
    const rt = runtime([a, b])
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(2))
    expect(rt.liveIdentities.get('child-a')).toMatchObject({ agentId: 'a' })
    expect(rt.liveIdentities.get('child-b')).toMatchObject({ agentId: 'b' })
    a.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'A done' }] })
    b.result.resolve({ stopReason: 'completed', output: [] })
    await expect(pending).resolves.toEqual({
      status: 'completed', deadlineMs: 150,
      items: [
        { agentId: 'a', status: 'completed', result: 'A done', stopReason: 'completed' },
        { agentId: 'b', status: 'empty', stopReason: 'completed' },
      ],
    })
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(b.dispose).toHaveBeenCalledTimes(1)
    expect(rt.liveIdentities.size).toBe(0)
    expect(rt.budgets.running('root')).toBe(0)
  })

  it('cleans a batch item whose published run result rejects', async () => {
    // An infrastructure fault makes `run.result` reject. The item still has to
    // release its holder and drop its live identity, and the batch-level lease
    // must be released so the root regains its width.
    const a = runFixture('child-a')
    const rt = runtime([a])
    const pending = call(rt, { tasks: [tasks[0]] })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    expect(rt.holders.size).toBe(1)
    expect(rt.liveIdentities.size).toBe(1)

    a.result.reject(new Error('infrastructure-fault'))
    await pending

    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(rt.holders.size).toBe(0)
    expect(rt.liveIdentities.size).toBe(0)
    expect(rt.budgets.running('root')).toBe(0)
    // A rejected result skips the end-log path, so cleanup owns the entry.
    expect(rt.observations.size).toBe(0)
  })

  it('one failed item aggregates partial_failed without cancelling siblings', async () => {    const a = runFixture('child-a')
    const b = runFixture('child-b')
    const rt = runtime([a, b])
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(2))
    a.result.resolve({ stopReason: 'error', output: [{ type: 'text', text: 'partial' }], diagnostic: 'boom' })
    b.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'B done' }] })
    await expect(pending).resolves.toMatchObject({
      status: 'partial_failed',
      items: [
        { agentId: 'a', status: 'failed', result: 'partial', stopReason: 'error', error: 'boom' },
        { agentId: 'b', status: 'completed', result: 'B done', stopReason: 'completed' },
      ],
    })
  })

  it('start rejection is an item failure, not a whole-call rejection', async () => {
    const a = runFixture('child-a')
    const rt = runtime([a])
    rt.subagents.start.mockRejectedValueOnce(new Error('start failed')).mockImplementationOnce(async () => {
      a.run = { id: a.id, result: a.result.promise, dispose: a.dispose }
      return a.run
    })
    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(2))
    a.result.resolve({ stopReason: 'completed', output: [] })
    await expect(pending).resolves.toMatchObject({
      status: 'partial_failed',
      items: [
        { agentId: 'a', status: 'failed', error: 'start failed' },
        { agentId: 'b', status: 'empty', stopReason: 'completed' },
      ],
    })
  })
})

describe('deadline, abort, and cleanup handoff', () => {
  it('returns partial_timeout, preserving completed items and marking settled cancellation', async () => {
    const deadline = deferred<void>()
    const grace = deferred<void>()
    let waits = 0
    const a = runFixture('child-a')
    const b = runFixture('child-b')
    const rt = runtime([a, b], () => (++waits === 1 ? deadline.promise : grace.promise))
    const pending = call(rt, { deadlineMs: 60_000 })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(2))
    a.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'A' }] })
    deadline.resolve()
    const timeoutResult = await pending
    expect(timeoutResult).toMatchObject({
      status: 'partial_timeout', deadlineMs: 60_000,
      items: [
        { agentId: 'a', status: 'completed', result: 'A', stopReason: 'completed' },
        { agentId: 'b', status: 'cancel_requested', error: expect.stringMatching(/did not return|cancel/i) },
      ],
    })
    expect(b.dispose).toHaveBeenCalledTimes(1)
  })

  it('returns cleanup_deferred for a non-cooperating run but releases width capacity', async () => {
    const deadline = deferred<void>()
    const grace = deferred<void>()
    let waits = 0
    const a = runFixture('child-a')
    a.dispose = vi.fn(() => new Promise<void>(() => {}))
    const rt = runtime([a], () => (++waits === 1 ? deadline.promise : grace.promise))
    const pending = call(rt, { tasks: [tasks[0]], deadlineMs: 60_000 })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    deadline.resolve()
    await Promise.resolve()
    grace.resolve()
    await expect(pending).resolves.toMatchObject({
      status: 'partial_timeout',
      items: [{ agentId: 'a', status: 'cleanup_deferred', error: expect.stringMatching(/did not return|cancel/i) }],
    })
    expect(rt.holders.size).toBe(1)
    expect(rt.liveIdentities.size).toBe(1)
    expect(rt.budgets.running('root')).toBe(0)
  })

  it('keeps ownership when deadline beats provider publication and cleans the late run', async () => {
    const deadline = deferred<void>()
    const grace = deferred<void>()
    const published = deferred<any>()
    let waits = 0
    const late = runFixture('late-child')
    const rt = runtime([late], () => (++waits === 1 ? deadline.promise : grace.promise))
    rt.subagents.start.mockImplementationOnce(() => published.promise)
    const pending = call(rt, { tasks: [tasks[0]], deadlineMs: 60_000 })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(1))
    deadline.resolve()
    await Promise.resolve()
    grace.resolve()
    await expect(pending).resolves.toMatchObject({
      status: 'partial_timeout',
      items: [{ agentId: 'a', status: 'cleanup_deferred' }],
    })
    expect(rt.holders.size).toBe(1)
    expect(rt.budgets.running('root')).toBe(0)

    late.run = { id: late.id, result: late.result.promise, dispose: late.dispose }
    published.resolve(late.run)
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(rt.holders.size).toBe(0))
    expect(rt.liveIdentities.size).toBe(0)
  })

  it('parent abort wins top-level status while preserving already completed items', async () => {
    const controller = new AbortController()
    const a = runFixture('child-a')
    const b = runFixture('child-b')
    const rt = runtime([a, b], () => new Promise<void>(() => {}))
    const pending = call(rt, { signal: controller.signal })
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(2))
    a.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'A' }] })
    await Promise.resolve()
    controller.abort('user')
    const cancelledResult = await pending
    expect(cancelledResult).toMatchObject({
      status: 'cancelled',
      items: [
        { agentId: 'a', status: 'completed', result: 'A', stopReason: 'completed' },
        { agentId: 'b', status: 'cancel_requested' },
      ],
    })
  })
})

describe('a scoped batch target is guarded like any other one-shot child (§16.12)', () => {
  const execution = (cwd: string, tool: string, filePath: string) =>
    ({ name: tool, arguments: { file_path: filePath }, agent: { session: { header: { cwd } } } })

  it('installs the scope on exactly the batch items whose target declares one', async () => {
    const guards: Array<(e: unknown) => string | undefined> = []
    const a = runFixture('a-1')
    const b = runFixture('b-1')
    // `delegate_batch` runs every item through `startOneShot` — the same path a
    // foreground single delegation takes — so a scoped target must be guarded
    // here too. Only `a` declares a scope in the fixture.
    const rt = runtime([a, b], undefined, () => ({
      ctx: { tools: { guard: (fn: never) => { guards.push(fn); return () => {} } } },
    }))

    const pending = call(rt)
    await vi.waitFor(() => expect(rt.subagents.start).toHaveBeenCalledTimes(2))
    expect(guards).toHaveLength(1)

    const cwd = mkdtempSync(join(tmpdir(), 'banbo-batch-scope-'))
    scratch.push(cwd)
    expect(guards[0]!(execution(cwd, 'write', '.banbo-dsh/plans/plan.md'))).toBeUndefined()
    expect(guards[0]!(execution(cwd, 'write', 'src/index.ts'))).toMatch(/may only write under/)

    a.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'A' }] })
    b.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'B' }] })
    await pending
  })
})
