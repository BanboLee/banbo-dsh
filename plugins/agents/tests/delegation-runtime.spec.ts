/** Preset-standing DelegationRuntime plugin surface — plan §9.4/§10/§11.2. */

import { describe, expect, it, vi } from 'vitest'

import delegationRuntime, {
  Config,
  inject,
  name,
} from '../delegation.js'

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function service() {
  const definitions = new Map<string, any>([
    ['lead', {
      id: 'lead', allowedChildren: ['worker'],
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
      id: 'worker', allowedChildren: [],
      child: {
        model: { default: true }, persona: 'worker.md', guidance: 'Do work.',
        tools: ['read'], continuation: 'one-shot',
      },
    }],
  ])
  return {
    rootDir: '/tmp/banbo-runtime-test',
    generation: 'gen',
    definitions,
    personas: new Map([['lead.md', '# Lead'], ['worker.md', '# Worker']]),
    abi: { agents: [
      { id: 'lead', toolName: 'agent_lead', hasMain: true, presetId: 'lead-preset' },
      { id: 'worker', toolName: 'agent_worker', hasChild: true },
      { id: 'retired', toolName: 'agent_retired', hasChild: true, retired: true },
    ] },
    settings: {
      policy(agentId: string) {
        const definition = definitions.get(agentId)
        return {
          agentId, definition, exists: definition !== undefined,
          retired: agentId === 'retired', effectiveEnabled: definition !== undefined,
          model: definition?.child?.model,
        }
      },
    },
  }
}

function fakeContext() {
  const tools: any[] = []
  const listeners = new Map<string, (...args: any[]) => any>()
  const effects: Array<() => any> = []
  const ctx = {
    banboAgents: service(),
    subagents: { start: vi.fn(), startContinuable: vi.fn() },
    jobs: { start: vi.fn() },
    tools: {
      register: vi.fn((tool) => {
        tools.push(tool)
        return () => {}
      }),
      schemas: vi.fn(() => [
        { name: 'read' }, { name: 'read_image' },
        { name: 'agent_worker' }, { name: 'agent_retired' }, { name: 'delegate_batch' },
      ]),
      get: vi.fn(() => ({})),
    },
    agentPresets: { composedPreset: vi.fn(() => 'lead-preset') },
    on: vi.fn((event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }),
    effect: vi.fn((body) => {
      const disposer = body()
      effects.push(disposer)
      return () => {}
    }),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }
  return { ctx, tools, listeners, effects }
}

function agent() {
  return {
    id: 'root-session', options: { provider: 'p', model: 'm' }, ctx: { scope: 'agent' },
    session: { header: { agentPreset: 'lead-preset' } },
  }
}

describe('plugin metadata and generated config', () => {
  it('declares all required public services and validates one agent id', () => {
    expect(name).toBe('banbo-delegation')
    expect(inject).toEqual(expect.arrayContaining([
      'banboAgents', 'subagents', 'jobs', 'tools', 'agentPresets',
    ]))
    expect(Config['~standard'].validate({ agentId: 'lead' }).value).toEqual({ agentId: 'lead' })
    expect(() => Config['~standard'].validate({ agentId: 'Bad Id' })).toThrow(/agentId/i)
  })
})

describe('stable tool registration', () => {
  it('registers active child and retired ABI names plus one batch tool', () => {
    const harness = fakeContext()
    delegationRuntime(harness.ctx as never, { agentId: 'lead' })
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      'agent_worker', 'agent_retired', 'delegate_batch',
    ])
    const worker = harness.tools[0]
    expect(worker.parameters).toMatchObject({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        description: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      required: ['prompt', 'description'],
    })
    expect(worker.timeoutMs).toBeGreaterThan(200 + 10)
    expect(harness.tools[2].timeoutMs).toBeGreaterThan(1_800_000 + 10)
  })

  it('retired shell always rejects before touching providers or budgets', async () => {
    const harness = fakeContext()
    delegationRuntime(harness.ctx as never, { agentId: 'lead' })
    await expect(harness.tools[1].execute({ prompt: 'x', description: 'x' }, {
      agent: agent(), signal: new AbortController().signal,
    })).rejects.toThrow(/retired|restore/i)
    expect(harness.ctx.subagents.start).not.toHaveBeenCalled()
    expect(harness.ctx.subagents.startContinuable).not.toHaveBeenCalled()
  })

  it('active named tool forwards the exact exec agent and signal', async () => {
    const harness = fakeContext()
    const requests: any[] = []
    const result = deferred()
    // A well-formed run, so the assertions below cannot pass because the mock
    // returned `undefined` and something downstream threw a TypeError.
    // `start(provider, request)` takes two arguments.
    harness.ctx.subagents.start = vi.fn(async (_provider: string, request: any) => {
      requests.push(request)
      return { id: 'child-1', localAgent: undefined, result: result.promise, dispose: vi.fn(async () => {}) }
    })
    delegationRuntime(harness.ctx as never, { agentId: 'lead' })
    const parent = agent()
    const controller = new AbortController()

    const pending = harness.tools[0].execute(
      { prompt: 'x', description: 'y' },
      { agent: parent, signal: controller.signal },
    )
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    // The exact live Agent, not a plugin-scope stand-in.
    expect(requests[0].parent).toBe(parent)

    // The exec signal owns cancellation: aborting it must reach the signal the
    // provider actually received.
    controller.abort('exec cancelled')
    await vi.waitFor(() => expect(requests[0].signal.aborted).toBe(true))

    result.resolve({ stopReason: 'completed', output: [] })
    await expect(pending).resolves.toBeDefined()
    expect(harness.ctx.agentPresets.composedPreset).toHaveBeenCalledWith(parent.ctx)
  })

  it('active batch tool rejects an empty task list before any provider start', async () => {
    const harness = fakeContext()
    delegationRuntime(harness.ctx as never, { agentId: 'lead' })
    const parent = agent()
    const controller = new AbortController()
    await expect(harness.tools[2].execute({ tasks: [] }, {
      agent: parent, signal: controller.signal,
    })).rejects.toThrow(/tasks|maxBatchWidth/i)
    expect(harness.ctx.subagents.start).not.toHaveBeenCalled()
  })
})

describe('listeners and lifecycle disposal', () => {
  it('releases a continuable root lease on the public subagent/end child id', () => {
    const harness = fakeContext()
    const runtime = delegationRuntime(harness.ctx as never, { agentId: 'lead' }) as any
    const lease = { release: vi.fn(() => true) }
    runtime.continuableLeases.set('child-1', lease)
    expect(harness.listeners.has('subagent/end')).toBe(true)
    harness.listeners.get('subagent/end')?.({ id: 'child-1', runId: 'run', provider: 'spawn', local: true, stopReason: 'completed' })
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(runtime.continuableLeases.size).toBe(0)
  })

  it('Host disposer drains holders and releases any remaining continuable leases', async () => {
    const harness = fakeContext()
    const runtime = delegationRuntime(harness.ctx as never, { agentId: 'lead' }) as any
    const drain = vi.spyOn(runtime.holders, 'drain').mockResolvedValue({ unresolved: [] })
    const lease = { release: vi.fn(() => true) }
    runtime.continuableLeases.set('child-2', lease)
    expect(harness.effects).toHaveLength(1)
    await harness.effects[0]()
    expect(drain).toHaveBeenCalledWith({ graceMs: 10 })
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(runtime.continuableLeases.size).toBe(0)
  })
})
