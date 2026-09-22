/**
 * Deadline plumbing — docs/agents-plugin-plan.md §10.6/§10.8.
 *
 * Every delegation path races its work against a timer. These tests pin the two
 * properties that make that safe: a deadline can never keep the Node event loop
 * alive after the race is decided, and the caller always disarms it.
 */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEADLINE_REACHED, armDeadline, raceWithDeadline } from '../deadline.js'

const moduleUrl = new URL('../deadline.js', import.meta.url).href

afterEach(() => {
  vi.useRealTimers()
})

describe('armDeadline', () => {
  it('resolves the deadline sentinel and lets the process exit without waiting', () => {
    // The decisive check: an armed-but-unawaited deadline must not hold the
    // event loop. Without `unref` this child would sit for the full 60 s and
    // blow the spawn timeout.
    const script = [
      `const { armDeadline } = await import(${JSON.stringify(moduleUrl)})`,
      'armDeadline(60_000, undefined)',
      "console.log('armed')",
    ].join('\n')
    const started = Date.now()
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    const elapsed = Date.now() - started

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('armed')
    expect(elapsed, 'an unawaited deadline must not keep the process alive').toBeLessThan(10_000)
  })

  it('stops the timer when the caller disarms it', async () => {
    vi.useFakeTimers()
    const timer = armDeadline(1_000, undefined)
    let fired = false
    timer.promise.then(() => { fired = true })

    timer.cancel()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fired).toBe(false)
  })

  it('still fires when it is not disarmed', async () => {
    vi.useFakeTimers()
    const timer = armDeadline(1_000, undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(timer.promise).resolves.toBe(DEADLINE_REACHED)
  })

  it('uses an injected timer verbatim and disarms nothing it does not own', async () => {
    const seen: number[] = []
    const timer = armDeadline(1_234, async (ms: number) => { seen.push(ms) })
    expect(timer.cancel()).toBeUndefined()
    await expect(timer.promise).resolves.toBe(DEADLINE_REACHED)
    expect(seen).toEqual([1_234])
  })
})

describe('raceWithDeadline', () => {
  it('returns the winning arm and disarms the timer', async () => {
    vi.useFakeTimers()
    const pending = new Promise(() => {})
    const winner = Promise.resolve('work')

    await expect(raceWithDeadline(60_000, undefined, [winner, pending])).resolves.toBe('work')
    // The timer was cleared, so nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the sentinel when the deadline wins', async () => {
    vi.useFakeTimers()
    const never = new Promise(() => {})
    const raced = raceWithDeadline(500, undefined, [never])
    await vi.advanceTimersByTimeAsync(500)
    await expect(raced).resolves.toBe(DEADLINE_REACHED)
  })

  it('disarms the timer even when an arm rejects', async () => {
    vi.useFakeTimers()
    const failing = Promise.reject(new Error('arm failed'))
    await expect(raceWithDeadline(60_000, undefined, [failing])).rejects.toThrow(/arm failed/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes an injected delay through unchanged', async () => {
    const seen: number[] = []
    const never = new Promise(() => {})
    const raced = raceWithDeadline(4_321, async (ms: number) => { seen.push(ms) }, [never])
    await expect(raced).resolves.toBe(DEADLINE_REACHED)
    expect(seen).toEqual([4_321])
  })
})
