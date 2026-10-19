/**
 * The durable child-authority record — docs/agents-plugin-plan.md §5.2/§16.12.
 *
 * 0.2.1's `subagent/descriptor` carries no persona and no toolFilter, so a cold
 * continuable resume restores the preset's FULL surface unless this bundle keeps
 * its own copy of the authorization. These cases pin the two properties that make
 * that copy safe:
 *
 *   - the payload round-trips through the real plugin-record API (a fake Session
 *     would not prove the record survives a log write/read cycle);
 *   - every deviation from the exact schema is REJECTED, because partial
 *     acceptance is how an authorization record becomes an authorization hole.
 */

import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'

import {
  CHILD_AUTHORITY_RECORD,
  CHILD_AUTHORITY_VERSION,
  childAuthority,
  emptyComposition,
  parseChildAuthority,
  readChildAuthority,
  writeChildAuthority,
} from '../child-authority.js'

async function sessionFixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(undefined, { meta: { cwd: process.cwd(), origin: 'subagent' } })
  return { ctx, session }
}

describe('the child authority payload', () => {
  it('records the definition, the persona text and the exact allowlist', () => {
    const authority = childAuthority({
      agentId: 'worker',
      mainAgentId: 'lead',
      persona: '# Worker\n',
      toolFilter: { allow: ['read', 'read_image'] },
    })
    expect(authority).toEqual({
      version: CHILD_AUTHORITY_VERSION,
      agentId: 'worker',
      mainAgentId: 'lead',
      persona: '# Worker\n',
      allow: ['read', 'read_image'],
    })
    // NOT frozen: the official `appendPluginRecord` snapshots its argument and
    // rejects a frozen object graph as "non-JSON-serializable". Immutability is
    // provided by the committed record itself (`deepFreeze` runs on the stored
    // copy), so a freeze here would only break the write — which is exactly the
    // bug this assertion prevents from coming back.
    expect(Object.isFrozen(authority)).toBe(false)
    expect(Object.isFrozen(authority.allow)).toBe(false)
  })

  it('refuses to build a record that is missing the owning main', () => {
    // `mainAgentId` is the value a cold resume binds the child to, so it must be
    // known at creation time — never silently `undefined` (which the official
    // serializer would reject with an opaque "non-JSON-serializable" error).
    expect(() => childAuthority({
      agentId: 'worker', persona: '# Worker\n', toolFilter: { allow: ['read'] },
    } as never)).toThrow(/mainAgentId/)
    expect(() => childAuthority({
      agentId: '', mainAgentId: 'lead', persona: '', toolFilter: { allow: ['read'] },
    } as never)).toThrow(/agentId/)
  })

  it('rejects every deviation from the exact schema', () => {
    const good = {
      version: CHILD_AUTHORITY_VERSION,
      agentId: 'worker',
      mainAgentId: 'lead',
      persona: '# Worker\n',
      allow: ['read'],
    }
    expect(parseChildAuthority(good)).toMatchObject({ agentId: 'worker' })

    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['a future version', { ...good, version: CHILD_AUTHORITY_VERSION + 1 }],
      ['a missing field', { version: good.version, agentId: 'worker', mainAgentId: 'lead', persona: '', }],
      ['an extra field', { ...good, extra: true }],
      ['an empty agentId', { ...good, agentId: '' }],
      ['a non-string persona', { ...good, persona: 42 }],
      ['a non-array allow', { ...good, allow: 'read' }],
      ['an empty allow', { ...good, allow: [] }],
      ['a duplicate allow entry', { ...good, allow: ['read', 'read'] }],
      ['a non-string allow entry', { ...good, allow: ['read', 7] }],
      ['a null payload', null],
      ['an array payload', []],
    ]
    for (const [label, value] of cases) {
      expect(parseChildAuthority(value), label).toBeUndefined()
    }
  })

  it('fails closed to an EMPTY surface, never to "no restriction"', () => {
    const composition = emptyComposition('worker')
    expect(composition.toolFilter.allow).toEqual([])
    expect(composition.persona).toBe('')
    expect(composition.untrusted).toBe(true)
  })
})

describe('reading and writing the record through the real session log', () => {
  it('round-trips a valid record', async () => {
    const { ctx, session } = await sessionFixture()
    try {
      writeChildAuthority(
        session,
        childAuthority({ agentId: 'worker', mainAgentId: 'lead', persona: '# Worker\n', toolFilter: { allow: ['read'] } }),
        appendPluginRecord,
      )
      const read = readChildAuthority(session, pluginRecordOf)
      expect(read.state).toBe('valid')
      expect(read.authority).toMatchObject({ agentId: 'worker', persona: '# Worker\n', allow: ['read'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports `absent` for a session with no record of this type', async () => {
    const { ctx, session } = await sessionFixture()
    try {
      expect(readChildAuthority(session, pluginRecordOf).state).toBe('absent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports `invalid` — not `absent` — for a corrupt record', async () => {
    // The difference decides whether the child keeps the harness-restored surface
    // or is narrowed to nothing, so it is asserted directly.
    const { ctx, session } = await sessionFixture()
    try {
      // The record TYPE is declared, the payload is not: this is exactly the
      // "a record exists but cannot be trusted" case a restored log can hold.
      appendPluginRecord(session, CHILD_AUTHORITY_RECORD as never, { version: 999, agentId: 'worker' } as never)
      const read = readChildAuthority(session, pluginRecordOf)
      expect(read.state).toBe('invalid')
      expect(read.authority).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('treats an unreadable log as `invalid`, never as `absent`', async () => {
    const broken = {
      snapshotEvents() { throw new Error('log unreadable') },
    }
    expect(readChildAuthority(broken as never, pluginRecordOf).state).toBe('invalid')
  })

  it('refuses to publish a child whose authority cannot be persisted', async () => {
    // The write is the ONLY durable copy, so a failure here must veto publication
    // rather than start a child that would come back unrestricted.
    const { ctx, session } = await sessionFixture()
    try {
      const failing = () => { throw new Error('record commit rejected') }
      expect(() => writeChildAuthority(
        session,
        childAuthority({ agentId: 'worker', mainAgentId: 'lead', persona: '', toolFilter: { allow: ['read'] } }),
        failing as never,
      )).toThrow(/cannot persist the composition authority/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
