/** Root-session width budget — docs/agents-plugin-plan.md §10.3. */

import { describe, expect, it } from 'vitest'

import { BudgetError, RootBudgetRegistry } from '../budget.js'

describe('RootBudgetRegistry', () => {
  it('shares one counter across every descendant identity of a root Session', () => {
    const registry = new RootBudgetRegistry()
    const first = registry.acquire('root-1', 2, 3)
    expect(registry.running('root-1')).toBe(2)
    const second = registry.acquire('root-1', 1, 3)
    expect(registry.running('root-1')).toBe(3)
    first.release()
    expect(registry.running('root-1')).toBe(1)
    second.release()
    expect(registry.running('root-1')).toBe(0)
  })

  it('keeps independent roots independent', () => {
    const registry = new RootBudgetRegistry()
    registry.acquire('a', 2, 2)
    expect(() => registry.acquire('b', 2, 2)).not.toThrow()
    expect(registry.running('a')).toBe(2)
    expect(registry.running('b')).toBe(2)
  })

  it('fails fast without reserving a partial batch', () => {
    const registry = new RootBudgetRegistry()
    registry.acquire('root', 2, 3)
    const error = (() => {
      try {
        registry.acquire('root', 2, 3)
        return undefined
      } catch (thrown) {
        return thrown as BudgetError
      }
    })()
    expect(error).toBeInstanceOf(BudgetError)
    expect(error?.code).toBe('concurrency-exceeded')
    expect(error?.running).toBe(2)
    expect(error?.requested).toBe(2)
    expect(error?.limit).toBe(3)
    expect(registry.running('root')).toBe(2)
  })

  it('makes release idempotent and never decrements below zero', () => {
    const registry = new RootBudgetRegistry()
    const lease = registry.acquire('root', 1, 1)
    expect(lease.release()).toBe(true)
    expect(lease.release()).toBe(false)
    expect(registry.running('root')).toBe(0)
  })

  it('rejects invalid counts and limits instead of clamping silently', () => {
    const registry = new RootBudgetRegistry()
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(() => registry.acquire('root', count, 3), String(count)).toThrow(/count|positive|integer/i)
    }
    for (const limit of [0, -1, 1.5, 33, Number.NaN]) {
      expect(() => registry.acquire('root', 1, limit), String(limit)).toThrow(/limit|1.*32|integer/i)
    }
  })

  it('rejects an empty root identity fail-closed', () => {
    const registry = new RootBudgetRegistry()
    expect(() => registry.acquire('', 1, 3)).toThrow(/root/i)
  })

  it('returns a detached snapshot for diagnostics', () => {
    const registry = new RootBudgetRegistry()
    registry.acquire('b', 1, 3)
    registry.acquire('a', 2, 3)
    const snapshot = registry.snapshot()
    expect(snapshot).toEqual([
      { rootSessionId: 'a', runningChildren: 2 },
      { rootSessionId: 'b', runningChildren: 1 },
    ])
    snapshot[0].runningChildren = 99
    expect(registry.running('a')).toBe(2)
  })

  it('clears empty state entries after the last lease releases', () => {
    const registry = new RootBudgetRegistry()
    const lease = registry.acquire('root', 1, 2)
    lease.release()
    expect(registry.snapshot()).toEqual([])
  })
})
