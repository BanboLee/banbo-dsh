/** Gate D — official run, jobs, tool-signal, and provider lifecycle probes. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  NO_START_CAPABILITIES,
  SubagentRuntime,
  subprocessRunHandle,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const completed: SubagentResult = {
  output: [{ type: 'text', text: 'done' }],
  stopReason: 'completed',
}

const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

async function subagentFixture(start: SubagentProvider['start']) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  const provider: SubagentProvider = {
    name: 'probe',
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    start,
  }
  const remove = ctx.subagents.registerProvider(provider)
  const parent = { id: 'parent', session: { id: 'parent' } }
  const request = {
    parent,
    prompt: [{ type: 'text' as const, text: 'probe' }],
    signal: new AbortController().signal,
  }
  return { ctx, remove, request }
}

function remoteRun(result: Promise<SubagentResult>, dispose = vi.fn(async () => {})): SubagentRun {
  return { id: 'remote-child' as never, localAgent: undefined, result, dispose }
}

describe('D1 — SubagentRun settlement and provider ownership', () => {
  it('emits start synchronously, then end before a caller result continuation, exactly once', async () => {
    const result = deferred<SubagentResult>()
    const fixture = await subagentFixture(async () => remoteRun(result.promise))
    const order: string[] = []
    fixture.ctx.on('subagent/start', () => { order.push('start') })
    fixture.ctx.on('subagent/end', () => { order.push('end') })

    const run = await fixture.ctx.subagents.start('probe', fixture.request as never)
    run.result.then(() => { order.push('result-observed') })
    expect(order).toEqual(['start'])

    result.resolve(completed)
    result.resolve({ output: [], stopReason: 'error' })
    await run.result
    await Promise.resolve()
    expect(order).toEqual(['start', 'end', 'result-observed'])
  })

  it('rejects new starts after provider removal while an accepted run stays holder-owned', async () => {
    const result = deferred<SubagentResult>()
    const dispose = vi.fn(async () => {})
    const fixture = await subagentFixture(async () => remoteRun(result.promise, dispose))
    const run = await fixture.ctx.subagents.start('probe', fixture.request as never)
    await Promise.resolve(fixture.remove())

    await expect(fixture.ctx.subagents.start('probe', fixture.request as never))
      .rejects.toMatchObject({ name: 'SubagentError', code: 'NO_PROVIDER' })
    result.resolve(completed)
    await expect(run.result).resolves.toEqual(completed)
    await run.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('preserves a normal completion through idempotent disposal', async () => {
    const teardown = vi.fn(async () => {})
    const controller = new AbortController()
    const onAbort = vi.fn()
    controller.signal.addEventListener('abort', onAbort)
    const run = subprocessRunHandle({
      id: 'normal' as never,
      result: Promise.resolve(completed),
      signal: controller.signal,
      onAbort,
      requestCancel: vi.fn(),
      teardown,
    })

    await expect(run.result).resolves.toEqual(completed)
    await Promise.all([run.dispose(), run.dispose()])
    expect(teardown).toHaveBeenCalledOnce()
  })

  it('settles local cancellation but leaves non-cooperative teardown visibly pending', async () => {
    const result = deferred<SubagentResult>()
    const teardown = deferred<void>()
    const controller = new AbortController()
    const onAbort = vi.fn()
    controller.signal.addEventListener('abort', onAbort)
    let cancelCalls = 0
    const run = subprocessRunHandle({
      id: 'non-cooperative' as never,
      result: result.promise,
      signal: controller.signal,
      onAbort,
      requestCancel() {
        cancelCalls += 1
        result.resolve({ output: [], stopReason: 'aborted' })
      },
      teardown: () => teardown.promise,
    })

    let disposed = false
    const disposal = run.dispose().then(() => { disposed = true })
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    await Promise.resolve()
    expect({ cancelCalls, disposed }).toEqual({ cancelCalls: 1, disposed: false })

    teardown.resolve()
    await disposal
    expect(disposed).toBe(true)
  })
})

async function jobsFixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 4 })
  ctx.jobs.attachController('gate-d')
  return ctx
}

describe('D2 — LocalJobRegistry cancellation and ownership', () => {
  it('accepts producer-owned abort settlement and announces the committed terminal record once', async () => {
    const ctx = await jobsFixture()
    const done = deferred<{ status: 'killed' }>()
    const notices: string[] = []
    ctx.jobs.onJobDone((snapshot) => { notices.push(`${snapshot.id}:${snapshot.status}`) })
    const id = ctx.jobs.start({
      kind: 'subagent', label: 'self-abort probe',
      run: () => ({ cancel: vi.fn(), done: done.promise }),
    })

    done.resolve({ status: 'killed' })
    const snapshot = await ctx.jobs.wait(id, 100)
    expect(snapshot).toMatchObject({ id, status: 'killed', reported: true })
    expect(notices).toEqual([`${id}:killed`])
  })

  it('forwards kill reason and changes running through stopping to terminal', async () => {
    const ctx = await jobsFixture()
    const done = deferred<{ status: 'killed' }>()
    const reasons: Array<string | undefined> = []
    const id = ctx.jobs.start({
      kind: 'subagent', label: 'kill probe',
      run: () => ({
        cancel(reason) {
          reasons.push(reason)
          done.resolve({ status: 'killed' })
        },
        done: done.promise,
      }),
    })

    expect(ctx.jobs.kill(id, undefined, 'deadline')).toBe('requested')
    expect(ctx.jobs.get(id).status).toBe('stopping')
    await expect(ctx.jobs.wait(id, 100)).resolves.toMatchObject({ status: 'killed' })
    expect(reasons).toEqual(['deadline'])
  })

  it('owner scope disposal cancels, awaits, and removes owned jobs', async () => {
    const ctx = await jobsFixture()
    const agent = { id: 'owner', session: { id: 'owner' }, ctx: undefined as unknown }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    ctx.agents.register(agent as never)
    const done = deferred<{ status: 'killed' }>()
    const reasons: Array<string | undefined> = []
    const id = ctx.jobs.start({
      kind: 'subagent', label: 'owner cleanup', owner: agent as never,
      run: () => ({
        cancel(reason) {
          reasons.push(reason)
          done.resolve({ status: 'killed' })
        },
        done: done.promise,
      }),
    })
    expect(ctx.jobs.get(id, agent as never).status).toBe('running')

    await scope.dispose()
    expect(reasons).toEqual(['owner disposed'])
    expect(ctx.jobs.list(agent as never)).toEqual([])
  })
})

function signalTool(entered: Deferred<AbortSignal>, release: Deferred<Record<string, never>>): ToolDefinition {
  return {
    name: 'signal_probe',
    description: 'signal fusion probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async (_args, exec) => {
      entered.resolve(exec.signal)
      return release.promise
    },
  }
}

async function signalFixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  return ctx
}

describe('D3 — tools/execute replaces the signal by fusing it with caller cancellation', () => {
  it('gives the body a third fused signal that a wrapper abort reaches', async () => {
    const ctx = await signalFixture()
    const entered = deferred<AbortSignal>()
    const release = deferred<Record<string, never>>()
    ctx.tools.register(signalTool(entered, release))
    const caller = new AbortController()
    const wrapper = new AbortController()
    ctx.on('tools/execute', async (exec, next) => {
      const prior = exec.signal
      exec.signal = wrapper.signal
      try {
        return await next()
      } finally {
        exec.signal = prior
      }
    })

    const execution = ctx.tools.execute({
      callId: 'gate-d-wrapper' as never,
      name: 'signal_probe', arguments: {}, signal: caller.signal,
    })
    const bodySignal = await entered.promise
    expect(bodySignal).not.toBe(caller.signal)
    expect(bodySignal).not.toBe(wrapper.signal)
    expect(bodySignal.aborted).toBe(false)

    wrapper.abort('wrapper deadline')
    expect(bodySignal.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    release.resolve({})
    // Either side of the fused signal selects the canonical cancellation
    // outcome, so a body that still returns normally is rewritten to ABORTED.
    await expect(execution).resolves.toMatchObject({
      isError: true, error: { info: { name: 'AbortError', code: 'ABORTED' } },
    })
  })

  it('still lets the original caller signal abort the body and select the canonical ABORTED result', async () => {
    const ctx = await signalFixture()
    const entered = deferred<AbortSignal>()
    const release = deferred<Record<string, never>>()
    ctx.tools.register(signalTool(entered, release))
    const caller = new AbortController()
    ctx.on('tools/execute', async (exec, next) => {
      const prior = exec.signal
      exec.signal = new AbortController().signal
      try {
        return await next()
      } finally {
        exec.signal = prior
      }
    })

    const execution = ctx.tools.execute({
      callId: 'gate-d-caller' as never,
      name: 'signal_probe', arguments: {}, signal: caller.signal,
    })
    const bodySignal = await entered.promise
    caller.abort('caller deadline')
    expect(bodySignal.aborted).toBe(true)
    release.resolve({})
    await expect(execution).resolves.toMatchObject({
      isError: true, error: { info: { name: 'AbortError', code: 'ABORTED' } },
    })
  })
})
