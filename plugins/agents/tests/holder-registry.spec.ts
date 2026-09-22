/** Holder ownership and bounded cleanup — plan §10.8. */

import { describe, expect, it, vi } from 'vitest'

import { HolderRegistry, RunHolder } from '../holder-registry.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runFixture() {
  const result = deferred<{ output: unknown[]; stopReason: string }>()
  const disposed = deferred<void>()
  return {
    run: {
      id: 'child-1',
      localAgent: undefined,
      result: result.promise,
      dispose: vi.fn(() => disposed.promise),
    },
    result,
    disposed,
  }
}

describe('RunHolder', () => {
  it('exists before the subagent start and exposes its cancellation signal', () => {
    const holder = new RunHolder('worker: task')
    expect(holder.state).toBe('reserved')
    expect(holder.signal.aborted).toBe(false)
  })

  it('publishes one attached run and exposes its result', async () => {
    const fixture = runFixture()
    const holder = new RunHolder('worker: task')
    holder.attach(fixture.run as never)
    fixture.result.resolve({ output: [], stopReason: 'completed' })
    await expect(holder.result).resolves.toEqual({ output: [], stopReason: 'completed' })
    expect(holder.id).toBe('child-1')
  })

  it('makes cancellation and settlement idempotent and disposes exactly once', async () => {
    const fixture = runFixture()
    const holder = new RunHolder('worker: task')
    holder.attach(fixture.run as never)
    expect(holder.cancel('deadline')).toBe(true)
    expect(holder.cancel('dispose')).toBe(false)
    expect(holder.signal.aborted).toBe(true)
    expect(holder.signal.reason).toBe('deadline')

    const first = holder.settle()
    const second = holder.settle()
    expect(first).toBe(second)
    expect(fixture.run.dispose).toHaveBeenCalledTimes(1)
    fixture.disposed.resolve()
    await first
    expect(holder.state).toBe('settled')
    expect(fixture.run.dispose).toHaveBeenCalledTimes(1)
  })

  it('settles a failed start without inventing a run or dispose call', async () => {
    const holder = new RunHolder('worker: failed start')
    const error = new Error('start failed')
    holder.beginStart()
    holder.failStart(error)
    await expect(holder.result).rejects.toBe(error)
    await expect(holder.settle()).resolves.toBeUndefined()
    expect(holder.state).toBe('settled')
  })

  it('keeps ownership when cancellation races a pending start and disposes the late run', async () => {
    const fixture = runFixture()
    const holder = new RunHolder('worker: slow start')
    holder.beginStart()
    holder.cancel('deadline')
    const settlement = holder.settle()
    expect(holder.state).toBe('settling')
    expect(fixture.run.dispose).not.toHaveBeenCalled()

    holder.attach(fixture.run as never)
    expect(fixture.run.dispose).toHaveBeenCalledTimes(1)
    fixture.disposed.resolve()
    await settlement
    expect(holder.state).toBe('settled')
  })

  it('rejects double attach and attach after failed start', () => {
    const holder = new RunHolder('worker: task')
    holder.attach(runFixture().run as never)
    expect(() => holder.attach(runFixture().run as never)).toThrow(/already/i)
    const failed = new RunHolder('worker: failure')
    failed.failStart(new Error('no'))
    expect(() => failed.attach(runFixture().run as never)).toThrow(/failed|settled/i)
  })
})

describe('HolderRegistry', () => {
  it('registers synchronously before any run exists and removes after settlement', async () => {
    const registry = new HolderRegistry()
    const holder = registry.reserve('worker: task')
    expect(registry.size).toBe(1)
    expect(registry.snapshot()[0]).toMatchObject({ label: 'worker: task', state: 'reserved' })

    const fixture = runFixture()
    holder.attach(fixture.run as never)
    const settlement = holder.settle()
    fixture.disposed.resolve()
    await settlement
    await Promise.resolve()
    expect(registry.size).toBe(0)
  })

  it('drain cancels every holder, starts settlement, and reports no settled holder', async () => {
    const logger = { warn: vi.fn() }
    const registry = new HolderRegistry({ logger })
    const first = registry.reserve('worker: first')
    const second = registry.reserve('leaf: second')
    const a = runFixture()
    const b = runFixture()
    first.attach(a.run as never)
    second.attach(b.run as never)

    const draining = registry.drain({ graceMs: 5 })
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(a.run.dispose).toHaveBeenCalledTimes(1)
    expect(b.run.dispose).toHaveBeenCalledTimes(1)
    a.disposed.resolve()
    b.disposed.resolve()

    await expect(draining).resolves.toEqual({ unresolved: [] })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(registry.size).toBe(0)
  })

  it('returns after grace and logs every non-cooperating holder with its age', async () => {
    const gate = deferred<void>()
    const logger = { warn: vi.fn() }
    let now = 100
    const registry = new HolderRegistry({
      logger,
      now: () => now,
      delay: () => gate.promise,
    })
    const holder = registry.reserve('worker: hung')
    holder.attach(runFixture().run as never)
    now = 350

    const draining = registry.drain({ graceMs: 30_000 })
    gate.resolve()
    const outcome = await draining

    expect(outcome.unresolved).toEqual([
      { label: 'worker: hung', ageMs: 250, state: 'settling' },
    ])
    expect(logger.warn).toHaveBeenCalledWith('banbo-agents: holder/orphaned', {
      label: 'worker: hung', registeredMs: 250, graceMs: 30_000,
    })
    expect(registry.size).toBe(1)
  })

  it('drain handles an unstarted reservation without hanging', async () => {
    const registry = new HolderRegistry()
    registry.reserve('worker: never started')
    await expect(registry.drain({ graceMs: 10 })).resolves.toEqual({ unresolved: [] })
    expect(registry.size).toBe(0)
  })
})
