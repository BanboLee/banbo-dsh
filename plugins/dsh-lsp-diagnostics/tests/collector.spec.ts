import { describe, expect, it } from 'vitest'
import { createMutationCollector } from '../collector.js'

interface FakeTarget {
  readonly targetKey: string
  readonly displayPath: string
}

interface FakeExec {
  readonly name: string
  readonly arguments?: { readonly command?: string }
}

function target(targetKey = 'ws/a.ts'): FakeTarget {
  return { targetKey, displayPath: `/workspace/${targetKey}` }
}

function exec(name: string, command?: string): FakeExec {
  return command === undefined ? { name } : { name, arguments: { command } }
}

function present(version: string): { readonly kind: 'present'; readonly version: string } {
  return { kind: 'present', version }
}

describe('dsh-lsp-diagnostics mutation collector', () => {
  it('records write observations as generation 1 candidates that are current', () => {
    const collector = createMutationCollector()
    const e = exec('write')
    const t = target()
    collector.observe(e, t, present('v1'))
    const taken = collector.take(e)
    expect(taken).toHaveLength(1)
    const candidate = taken[0]!
    expect(candidate.target).toBe(t)
    expect(candidate.version).toBe('v1')
    expect(candidate.generation).toBe(1)
    expect(collector.isCurrent(candidate)).toBe(true)
  })

  it('records edit observations the same way', () => {
    const collector = createMutationCollector()
    const e = exec('edit')
    const t = target('ws/b.go')
    collector.observe(e, t, present('v9'))
    const [candidate] = collector.take(e)
    expect(candidate?.generation).toBe(1)
    expect(candidate?.version).toBe('v9')
    expect(collector.isCurrent(candidate!)).toBe(true)
  })

  it('records all three mutating str_replace_editor commands', () => {
    for (const command of ['create', 'str_replace', 'insert'] as const) {
      const collector = createMutationCollector()
      const e = exec('str_replace_editor', command)
      const t = target(`ws/${command}.ts`)
      collector.observe(e, t, present(`v-${command}`))
      const [candidate] = collector.take(e)
      expect(candidate?.generation).toBe(1)
      expect(candidate?.version).toBe(`v-${command}`)
      expect(collector.isCurrent(candidate!)).toBe(true)
    }
  })

  it('ignores str_replace_editor view', () => {
    const collector = createMutationCollector()
    const e = exec('str_replace_editor', 'view')
    const t = target()
    collector.observe(e, t, present('v1'))
    expect(collector.take(e)).toEqual([])
  })

  it('ignores unsupported tool names', () => {
    const collector = createMutationCollector()
    const t = target()
    for (const name of ['read', 'run_code', 'bash', 'grep', '']) {
      const e = exec(name)
      collector.observe(e, t, present('v1'))
      expect(collector.take(e), `tool ${name}`).toEqual([])
    }
  })

  it('ignores absent observations', () => {
    const collector = createMutationCollector()
    const e = exec('write')
    const t = target()
    collector.observe(e, t, { kind: 'absent' })
    expect(collector.take(e)).toEqual([])
  })

  it('ignores observations without an actor exec', () => {
    const collector = createMutationCollector()
    const t = target()
    collector.observe(undefined, t, present('v1'))
    expect(collector.take(undefined)).toEqual([])
  })

  it('dedupes repeated observations for the same exec and target', () => {
    const collector = createMutationCollector()
    const e = exec('write')
    const t = target()
    collector.observe(e, t, present('v1'))
    collector.observe(e, t, present('v2'))
    const taken = collector.take(e)
    expect(taken).toHaveLength(1)
    const latest = taken[0]!
    expect(latest.generation).toBe(2)
    expect(latest.version).toBe('v2')
    // The replaced candidate is immediately stale: marker is {generation:2, version:'v2'}.
    expect(collector.isCurrent({ target: t, version: 'v1', generation: 1 })).toBe(false)
  })

  it('take returns and clears per-exec candidates only', () => {
    const collector = createMutationCollector()
    const e1 = exec('write')
    const e2 = exec('edit')
    const t1 = target('ws/a.ts')
    const t2 = target('ws/b.ts')
    expect(collector.take(e1)).toEqual([])
    collector.observe(e1, t1, present('v1'))
    collector.observe(e2, t2, present('v2'))
    const fromE1 = collector.take(e1)
    expect(fromE1).toHaveLength(1)
    expect(fromE1[0]?.target).toBe(t1)
    expect(collector.take(e1)).toEqual([])
    const fromE2 = collector.take(e2)
    expect(fromE2).toHaveLength(1)
    expect(fromE2[0]?.target).toBe(t2)
  })

  it('never throws on hostile execs, targets, or observations', () => {
    const collector = createMutationCollector()
    const e = exec('write')
    const t = target()
    expect(() => collector.observe(undefined, undefined, undefined)).not.toThrow()
    expect(() => collector.observe(null, null, null)).not.toThrow()
    expect(() => collector.observe({ name: 'read' }, t, present('v1'))).not.toThrow()
    expect(() => collector.observe({ name: 'str_replace_editor' }, t, present('v1'))).not.toThrow()
    expect(() => collector.observe({ name: 'str_replace_editor', arguments: { command: 'view' } }, t, present('v1'))).not.toThrow()
    expect(() => collector.observe(e, t, { kind: 'absent' })).not.toThrow()
    expect(() => collector.observe(e, t, { kind: 'present' })).not.toThrow()
    expect(() => collector.observe(e, t, null)).not.toThrow()
    expect(() => collector.observe(e, t, 'junk')).not.toThrow()
    expect(() => collector.observe(e, { displayPath: 'x' }, present('v1'))).not.toThrow()
    expect(() => collector.observe(e, { targetKey: 42 }, present('v1'))).not.toThrow()
    expect(() => collector.observe(e, undefined, present('v1'))).not.toThrow()
    const hostileExec = new Proxy({}, { get() { throw new Error('boom') } })
    expect(() => collector.observe(hostileExec, t, present('v1'))).not.toThrow()
    // None of the above recorded a candidate for a write exec.
    expect(collector.take(e)).toEqual([])
    // isCurrent / retireIfCurrent also contain hostile inputs.
    expect(collector.isCurrent(undefined)).toBe(false)
    expect(collector.isCurrent(null)).toBe(false)
    expect(collector.retireIfCurrent({})).toBe(false)
    expect(collector.retireIfCurrent(null)).toBe(false)
    expect(collector.isCurrent({ target: {}, version: 'v', generation: 1 })).toBe(false)
  })

  it('observe A -> observe B -> retire B -> observe C assigns generations 1,2,3 and A/B never revive', () => {
    const collector = createMutationCollector()
    const t = target()
    const execA = exec('write')
    const execB = exec('edit')
    const execC = exec('write')
    collector.observe(execA, t, present('vA'))
    const [a] = collector.take(execA)
    collector.observe(execB, t, present('vB'))
    const [b] = collector.take(execB)
    expect(a?.generation).toBe(1)
    expect(b?.generation).toBe(2)
    expect(collector.isCurrent(a!)).toBe(false)
    expect(collector.isCurrent(b!)).toBe(true)
    expect(collector.retireIfCurrent(b!)).toBe(true)
    collector.observe(execC, t, present('vC'))
    const [c] = collector.take(execC)
    expect(c?.generation).toBe(3)
    expect(collector.isCurrent(a!)).toBe(false)
    expect(collector.isCurrent(b!)).toBe(false)
    expect(collector.isCurrent(c!)).toBe(true)
  })

  it('reused FsVersion tokens cannot revive older generations', () => {
    const collector = createMutationCollector()
    const t = target()
    const execA = exec('write')
    const execB = exec('edit')
    const execC = exec('write')
    collector.observe(execA, t, present('same-token'))
    const [a] = collector.take(execA)
    collector.observe(execB, t, present('same-token'))
    const [b] = collector.take(execB)
    expect(a?.generation).toBe(1)
    expect(b?.generation).toBe(2)
    expect(collector.isCurrent(a!)).toBe(false)
    expect(collector.isCurrent(b!)).toBe(true)
    expect(collector.retireIfCurrent(b!)).toBe(true)
    collector.observe(execC, t, present('same-token'))
    const [c] = collector.take(execC)
    expect(c?.generation).toBe(3)
    expect(collector.isCurrent(a!)).toBe(false)
    expect(collector.isCurrent(b!)).toBe(false)
    expect(collector.isCurrent(c!)).toBe(true)
  })

  it('same target across execs keeps one monotonic counter that retire never regresses', () => {
    const collector = createMutationCollector()
    const t = target()
    for (let index = 1; index <= 5; index += 1) {
      const e = exec(index % 2 === 0 ? 'edit' : 'write')
      collector.observe(e, t, present(`v${index}`))
      const [candidate] = collector.take(e)
      expect(candidate?.generation, `generation for observation ${index}`).toBe(index)
      expect(collector.retireIfCurrent(candidate!)).toBe(true)
      // Retiring the active marker must not delete or regress the counter.
    }
    // The very next observation is generation 6, never a wrap back to 1.
    const e = exec('write')
    collector.observe(e, t, present('v6'))
    const [candidate] = collector.take(e)
    expect(candidate?.generation).toBe(6)
  })

  it('retireIfCurrent on a stale candidate keeps the active marker', () => {
    const collector = createMutationCollector()
    const t = target()
    const execA = exec('write')
    const execB = exec('write')
    collector.observe(execA, t, present('vA'))
    const [a] = collector.take(execA)
    collector.observe(execB, t, present('vB'))
    const [b] = collector.take(execB)
    expect(collector.retireIfCurrent(a!)).toBe(false)
    expect(collector.isCurrent(b!)).toBe(true)
    expect(collector.retireIfCurrent(b!)).toBe(true)
    expect(collector.retireIfCurrent(b!)).toBe(false)
  })

  it('isCurrent requires both generation and version to match the active marker', () => {
    const collector = createMutationCollector()
    const t = target()
    const execA = exec('write')
    const execB = exec('write')
    collector.observe(execA, t, present('v1'))
    const [a] = collector.take(execA)
    collector.observe(execB, t, present('v2'))
    const [b] = collector.take(execB)
    // Version matches marker but generation does not.
    expect(collector.isCurrent({ target: t, version: 'v2', generation: a!.generation })).toBe(false)
    // Generation matches marker but version does not.
    expect(collector.isCurrent({ target: t, version: 'v1', generation: b!.generation })).toBe(false)
    // Exact double match only.
    expect(collector.isCurrent(b!)).toBe(true)
    expect(collector.retireIfCurrent({ target: t, version: 'v2', generation: a!.generation })).toBe(false)
    expect(collector.isCurrent(b!)).toBe(true)
  })

  it('allocates the final generation at MAX_SAFE_INTEGER then fails safe forever', () => {
    const key = 'ws/max.ts'
    const collector = createMutationCollector({
      initialNextGenerationByTarget: new Map<string, number | 'exhausted'>([[key, Number.MAX_SAFE_INTEGER]]),
    })
    const execA = exec('write')
    const t = target(key)
    collector.observe(execA, t, present('v-max'))
    const [candidate] = collector.take(execA)
    expect(candidate?.generation).toBe(Number.MAX_SAFE_INTEGER)
    expect(collector.isCurrent(candidate!)).toBe(true)
    // The next observation reads 'exhausted': the active marker is deleted and
    // the new candidate is silently suppressed, so the max-generation candidate
    // becomes stale and no wrap/reset ever happens.
    const execB = exec('write')
    collector.observe(execB, t, present('v-after'))
    expect(collector.take(execB)).toEqual([])
    expect(collector.isCurrent(candidate!)).toBe(false)
    const execC = exec('write')
    collector.observe(execC, t, present('v-after-2'))
    expect(collector.take(execC)).toEqual([])
    expect(collector.isCurrent(candidate!)).toBe(false)
  })

  it('a pre-seeded exhausted counter permanently suppresses observations', () => {
    const key = 'ws/exhausted.ts'
    const collector = createMutationCollector({
      initialNextGenerationByTarget: new Map<string, number | 'exhausted'>([[key, 'exhausted']]),
    })
    const t = target(key)
    for (let index = 0; index < 3; index += 1) {
      const e = exec('write')
      collector.observe(e, t, present(`v${index}`))
      expect(collector.take(e), `suppressed observation ${index}`).toEqual([])
    }
    // Other targets are unaffected by the exhausted target.
    const other = exec('write')
    const otherTarget = target('ws/other.ts')
    collector.observe(other, otherTarget, present('v1'))
    const [candidate] = collector.take(other)
    expect(candidate?.generation).toBe(1)
    expect(collector.isCurrent(candidate!)).toBe(true)
  })

  it('different targets allocate independent counters', () => {
    const collector = createMutationCollector()
    const e1 = exec('write')
    const e2 = exec('edit')
    const t1 = target('ws/a.ts')
    const t2 = target('ws/b.go')
    collector.observe(e1, t1, present('v1'))
    collector.observe(e2, t2, present('v1'))
    const [a] = collector.take(e1)
    const [b] = collector.take(e2)
    expect(a?.generation).toBe(1)
    expect(b?.generation).toBe(1)
    collector.observe(e1, t1, present('v2'))
    const [a2] = collector.take(e1)
    expect(a2?.generation).toBe(2)
    expect(collector.isCurrent(b!)).toBe(true)
  })
})
