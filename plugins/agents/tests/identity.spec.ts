/**
 * Specification for `plugins/agents/identity.js` — the plugin-side sidecar that
 * carries a continuable child's business identity across restarts.
 *
 * This exists because a private Session event type is unusable: persistence
 * refuses to interpret a log containing one (see `gate-a-target.spec.ts` A4 and
 * docs/agents-plugin-plan.md §11.1.1). The sidecar therefore has to be
 * crash-safe on its own, and every failure mode must degrade to "identity
 * unknown" rather than to an exception that would abort session recovery.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CHILD_IDENTITY_VERSION,
  IdentityError,
  childIdentityPath,
  readChildIdentity,
  rollbackChildIdentity,
  writeChildIdentity,
} from '../identity.js'

const scratch: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'banbo-identity-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

const identity = (patch: Record<string, unknown> = {}) => ({
  version: CHILD_IDENTITY_VERSION,
  agentId: 'executor',
  mainAgentId: 'banbo',
  presetId: 'banbo',
  rootSessionId: 'session-root',
  generation: 'sha256:abc',
  ...patch,
})

function identityError(fn: () => unknown): IdentityError {
  try {
    fn()
  } catch (error) {
    if (error instanceof IdentityError) return error
    throw error
  }
  throw new Error('expected IdentityError, but nothing was thrown')
}

describe('round trip', () => {
  it('writes then reads back the exact identity', () => {
    const root = scratchDir()
    writeChildIdentity(root, 'child-a', identity())
    expect(readChildIdentity(root, 'child-a')).toEqual(identity())
  })

  it('detaches the value it stores and the value it returns', () => {
    const root = scratchDir()
    const source = identity()
    writeChildIdentity(root, 'child-detach', source)
    // Mutating the caller's object after the write must not alter what a later
    // reader sees: the sidecar is a durable record, not a live reference.
    source.agentId = 'mutated'
    const first = readChildIdentity(root, 'child-detach')
    expect(first!.agentId).toBe('executor')
    first!.agentId = 'also-mutated'
    expect(readChildIdentity(root, 'child-detach')!.agentId).toBe('executor')
  })

  it('derives the documented path', () => {
    expect(childIdentityPath('/root', 'child-a')).toBe('/root/.children/child-a.json')
  })

  it('creates the .children directory on first write', () => {
    const root = scratchDir()
    expect(readdirSync(root)).not.toContain('.children')
    writeChildIdentity(root, 'child-b', identity())
    expect(readdirSync(root)).toContain('.children')
  })
})

describe('write rejects a malformed identity before touching disk', () => {
  it('requires every field', () => {
    const root = scratchDir()
    for (const field of ['agentId', 'mainAgentId', 'presetId', 'rootSessionId', 'generation']) {
      const broken = identity()
      delete (broken as Record<string, unknown>)[field]
      const error = identityError(() => writeChildIdentity(root, 'child-x', broken as never))
      expect(error.code, field).toBe('bad-identity')
      expect(error.field).toBe(field)
    }
    // Nothing was written, so the child simply reads as unknown.
    expect(readChildIdentity(root, 'child-x')).toBeUndefined()
  })

  it('rejects an unknown version', () => {
    const root = scratchDir()
    const error = identityError(() => writeChildIdentity(root, 'child-y', identity({ version: 99 }) as never))
    expect(error.code).toBe('bad-identity')
  })

  it('rejects unknown fields rather than persisting them', () => {
    const root = scratchDir()
    const error = identityError(() => writeChildIdentity(root, 'child-z', identity({ sneaky: 1 }) as never))
    expect(error.code).toBe('unknown-field')
    expect(error.field).toBe('sneaky')
  })

  it('rejects a non-object identity', () => {
    const root = scratchDir()
    expect(identityError(() => writeChildIdentity(root, 'child-w', 'nope' as never)).code).toBe('bad-identity')
  })

  it('refuses a childId that would escape the .children directory', () => {
    const root = scratchDir()
    for (const childId of ['../escape', 'a/b', '', '.', '..']) {
      const error = identityError(() => writeChildIdentity(root, childId, identity()))
      expect(error.code, childId).toBe('bad-child-id')
    }
  })
})

describe('read degrades to "identity unknown" instead of throwing', () => {
  it('returns undefined for a child never written', () => {
    expect(readChildIdentity(scratchDir(), 'absent')).toBeUndefined()
  })

  it('returns undefined when the root itself does not exist', () => {
    expect(readChildIdentity(join(scratchDir(), 'no-such-root'), 'absent')).toBeUndefined()
  })

  it('returns undefined for a corrupt record', () => {
    const root = scratchDir()
    mkdirSync(join(root, '.children'), { recursive: true })
    writeFileSync(join(root, '.children', 'broken.json'), '{ not json')
    expect(readChildIdentity(root, 'broken')).toBeUndefined()
  })

  it('returns undefined for a record with an unsupported version', () => {
    const root = scratchDir()
    mkdirSync(join(root, '.children'), { recursive: true })
    writeFileSync(join(root, '.children', 'future.json'), `${JSON.stringify({ ...identity(), version: 99 })}\n`)
    // A future writer's record must not be reinterpreted under today's rules.
    expect(readChildIdentity(root, 'future')).toBeUndefined()
  })

  it('returns undefined for a record missing a field', () => {
    const root = scratchDir()
    mkdirSync(join(root, '.children'), { recursive: true })
    writeFileSync(join(root, '.children', 'partial.json'), `${JSON.stringify({ version: CHILD_IDENTITY_VERSION, agentId: 'x' })}\n`)
    expect(readChildIdentity(root, 'partial')).toBeUndefined()
  })

  it('returns undefined for a record carrying unknown fields', () => {
    const root = scratchDir()
    mkdirSync(join(root, '.children'), { recursive: true })
    writeFileSync(join(root, '.children', 'extra.json'), `${JSON.stringify({ ...identity(), extra: true })}\n`)
    // Strictness here is what keeps a hand-edited record from silently
    // changing authorization inputs.
    expect(readChildIdentity(root, 'extra')).toBeUndefined()
  })

  it('rejects a traversal childId on read as well', () => {
    expect(readChildIdentity(scratchDir(), '../escape')).toBeUndefined()
  })
})

describe('durability properties', () => {
  it('leaves no temp file behind after a successful write', () => {
    const root = scratchDir()
    writeChildIdentity(root, 'child-t', identity())
    expect(readdirSync(join(root, '.children')).filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0)
  })

  it('accepts a byte-identical rewrite as an idempotent retry', () => {
    const root = scratchDir()
    writeChildIdentity(root, 'child-same', identity({ agentId: 'one' }))
    expect(() => writeChildIdentity(root, 'child-same', identity({ agentId: 'one' }))).not.toThrow()
    expect(readChildIdentity(root, 'child-same')!.agentId).toBe('one')
    expect(readdirSync(join(root, '.children'))).toHaveLength(1)
  })

  it('refuses to overwrite an existing child record with different content', () => {
    // The reserved-child-id rule is enforced by the store, not merely assumed:
    // a reused id must fail loud instead of replacing another child's identity.
    const root = scratchDir()
    writeChildIdentity(root, 'child-same', identity({ agentId: 'one' }))
    const error = identityError(() => writeChildIdentity(root, 'child-same', identity({ agentId: 'two' })))
    expect(error.code).toBe('already-exists')
    expect(readChildIdentity(root, 'child-same')!.agentId).toBe('one')
    expect(readdirSync(join(root, '.children')).filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0)
  })

  it('rolls back only the exact record this attempt wrote', () => {
    const root = scratchDir()
    const mine = identity({ agentId: 'mine' })
    writeChildIdentity(root, 'child-mine', mine)
    expect(rollbackChildIdentity(root, 'child-mine', mine)).toBe(true)
    expect(readChildIdentity(root, 'child-mine')).toBeUndefined()
  })

  it('leaves a record alone when it is not the one this attempt wrote', () => {
    // A loser must never delete a winner's authoritative record.
    const root = scratchDir()
    writeChildIdentity(root, 'child-other', identity({ agentId: 'other' }))
    expect(rollbackChildIdentity(root, 'child-other', identity({ agentId: 'mine' }))).toBe(false)
    expect(readChildIdentity(root, 'child-other')!.agentId).toBe('other')
  })

  it('reports false for a rollback of an absent record', () => {
    const root = scratchDir()
    expect(rollbackChildIdentity(root, 'child-absent', identity())).toBe(false)
  })

  it('concurrent writes to distinct children never collide', async () => {
    const root = scratchDir()
    const ids = Array.from({ length: 32 }, (_, i) => `child-${i}`)
    await Promise.all(ids.map(async (id, index) => {
      await Promise.resolve()
      writeChildIdentity(root, id, identity({ agentId: `agent-${index}` }))
    }))
    for (const [index, id] of ids.entries()) {
      expect(readChildIdentity(root, id)!.agentId, id).toBe(`agent-${index}`)
    }
    expect(readdirSync(join(root, '.children')).filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0)
  })

  it('uses 0700 for the directory and 0600 for the record on POSIX', () => {
    if (process.platform === 'win32') return
    const root = scratchDir()
    writeChildIdentity(root, 'child-m', identity())
    expect(statSync(join(root, '.children')).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, '.children', 'child-m.json')).mode & 0o777).toBe(0o600)
  })

  it('a stale temp file never shadows a real record', () => {
    const root = scratchDir()
    writeChildIdentity(root, 'child-real', identity({ agentId: 'real' }))
    writeFileSync(join(root, '.children', 'child-real.json.999.deadbeef.tmp'), '{ half')
    expect(readChildIdentity(root, 'child-real')!.agentId).toBe('real')
  })
})
