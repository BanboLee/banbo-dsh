/**
 * Gate A — target-version platform probes for `@banbolee/dsh-agents`.
 *
 * Scope (see `docs/agents-plugin-plan.md` §15): this file answers ONLY
 * platform questions — "does the installed DSH expose this, and what is its
 * boundary behaviour". It deliberately does NOT test product behaviour
 * (naming tools, authorisation graphs, depth arithmetic, batch state
 * machines); those belong to the stage-2 acceptance suites.
 *
 * Probes:
 *   A1  dependency family is uniformly one prerelease (no rc.1/rc.2 mixing)
 *   A2  the public API surface the design depends on actually exists
 *   A3  `tools.restrict()` hard-fails on an unknown tool name — the single
 *       reason `RetiredToolShell` exists
 *   A4  a third-party Session event type CANNOT be marked `ignorable`, and
 *       persistence refuses to interpret a log containing it — the finding
 *       that retired the private-Session-event identity design
 *   A5  the sidecar identity store's contract (atomic temp+rename,
 *       concurrent writes to distinct children, missing-file detection)
 *       is achievable with plain `node:fs`
 *
 * Everything here is deterministic: no network, no real binaries, no models.
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as subagent from '@deepseek-ai/dsh-subagent'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')
const repoRoot = resolve(pluginRoot, '..', '..')

/** `Object.hasOwn` is ES2022; the repo's TS lib target predates it. */
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Scratch directories created by a probe, removed after each test. */
const scratch: string[] = []

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `banbo-gate-a-${prefix}-`))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ A1 --- */

describe('A1 — dependency family is uniform', () => {
  it('the workspace lockfile resolves no 0.1.5-rc.1 package alongside 0.1.5-rc.2', () => {
    const lock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
    const rc1 = lock.match(/0\.1\.5-rc\.1/g) ?? []
    const rc2 = lock.match(/0\.1\.5-rc\.2/g) ?? []
    // Mixing prereleases inside one family is the exact failure this probe
    // exists to catch: `^0.1.5-rc.1` cannot express "stay on rc.1", so a
    // caret range silently drifts to the newest rc.x.
    expect(rc1).toHaveLength(0)
    expect(rc2.length).toBeGreaterThan(0)
  })

  it('this plugin declares the same family for every @deepseek-ai dependency', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const family = [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {}),
      ...Object.entries(manifest.devDependencies ?? {}),
    ].filter(([name]) => name.startsWith('@deepseek-ai/dsh-') && name !== '@deepseek-ai/dsh-brand')

    expect(family.length).toBeGreaterThan(0)
    for (const [name, range] of family) {
      expect(`${name}@${range}`).toMatch(/^@deepseek-ai\/dsh-[a-z0-9-]+@\^0\.1\.5-rc\.2$/)
    }
  })
})

/* ------------------------------------------------------------------ A2 --- */

describe('A2 — required public API surface exists', () => {
  it('the subagent seam exports the functions the delegation runtime calls', () => {
    const required = [
      'applyChildComposition',
      'delegationDepthOf',
      'resolveChildDepth',
      'SubagentDepthError',
      'SubagentRunId',
      'SUBAGENT_DESCRIPTOR_VERSION',
      'foldSubagentDescriptor',
      'settleRun',
    ] as const
    for (const name of required) {
      expect(typeof (subagent as Record<string, unknown>)[name], `missing export ${name}`).not.toBe('undefined')
    }
    // Regression lock: an earlier draft of the plan listed a `completions`
    // member that has never existed. Probing a name that is not exported is
    // itself a Gate failure, so assert the negative explicitly.
    expect((subagent as Record<string, unknown>)['completions']).toBeUndefined()
  })

  it('the subagent runtime class exposes start / startContinuable / interrupt', () => {
    const runtime = subagent.SubagentRuntime as unknown as { prototype: Record<string, unknown> }
    for (const method of ['start', 'startContinuable', 'registerProvider', 'getProvider', 'list', 'sendMessage', 'interrupt']) {
      expect(typeof runtime.prototype[method], `missing SubagentRuntime#${method}`).toBe('function')
    }
  })

  it('an Agent exposes whenIdle(), and a Session exposes append() plus its header', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create()
      expect(typeof session.append).toBe('function')
      expect(typeof session.snapshotEvents).toBe('function')
      // The header is what persistence validation is keyed on (probe A4).
      expect(typeof session.header).toBe('object')
      expect(session.header.id).toBe(session.id)
      expect(session.header.isSeeded).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/* ------------------------------------------------------------------ A3 --- */

describe('A3 — tools.restrict() hard-fails on an unknown tool name', () => {
  it('ToolRuntime stays silently unregistered unless systemPrompt is mounted first', async () => {
    // Platform fact worth locking: `ctx.plugin(ToolRuntime)` RESOLVES without
    // throwing when its injected `systemPrompt` service is absent, and the
    // registry is simply never published. A composition that forgets the
    // prompt service therefore gets a silently empty tool registry rather
    // than a load error.
    const bare = new Context()
    try {
      await bare.plugin(ToolRuntime, {})
      expect(bare.get('tools')).toBeUndefined()
    } finally {
      await bare.fiber.dispose()
    }

    const wired = new Context()
    try {
      await wired.plugin(SystemPrompt, {})
      await wired.plugin(ToolRuntime, {})
      expect(wired.get('tools')).toBeDefined()
    } finally {
      await wired.fiber.dispose()
    }
  })

  it('throws instead of warning, which is the only reason RetiredToolShell exists', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, {})
      const host = await ctx.plugin({ name: 'gate-a-host', inject: ['tools'], apply() {} })
      ctx.tools.register({
        name: 'known_tool',
        description: 'probe tool',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text' as const, text: 'ok' }] },
        execute: async () => ({}),
      })

      const key = {}
      const scope = createScope(host.ctx, key)

      // Positive control: a name that IS visible restricts cleanly.
      expect(() => scope.ctx.tools.restrict({ allow: ['known_tool'] })).not.toThrow()

      // The load-bearing fact: an unknown name is a hard error, so a frozen
      // child `toolFilter` naming a deleted agent would make the child
      // unresumable unless a shell keeps the name registered.
      expect(() => scope.ctx.tools.restrict({ deny: ['agent_absent'] })).toThrow(/unknown global tool/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/* ------------------------------------------------------------------ A4 --- */

describe('A4 — private Session event types are unusable (design pivot lock)', () => {
  it('append() builds an envelope with no way to set ignorable', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create()
      // `append` is typed against the merge-extensible SessionEventMap; a
      // third-party type is only reachable through a cast, which is exactly
      // the situation a plugin writing its own event type is in. It must stay
      // bound to the session (`this.log` is private state).
      const append = session.append.bind(session) as unknown as (type: string, data: unknown) => { readonly [key: string]: unknown }
      const event = append('banbo-agent/identity', { version: 1, agentId: 'probe' })

      expect(event['type']).toBe('banbo-agent/identity')
      expect(hasOwn(event, 'data')).toBe(true)
      // The envelope is exactly {type, seq, time, data, surfaceOp?,
      // sourceEventSeqs?}. `ignorable` is never written by any caller.
      expect(hasOwn(event, 'ignorable')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persistence refuses to interpret a log containing that event', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create()
      const append = session.append.bind(session) as unknown as (type: string, data: unknown) => unknown
      append('banbo-agent/identity', { version: 1, agentId: 'probe' })

      const events = [...session.snapshotEvents()] as never[]
      expect(events).toHaveLength(1)
      expect(() => validateStoredEvents(session.header, events)).toThrow(/unknown to this harness and not marked ignorable/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a harness-known log-only event type passes the same validation (positive control)', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create()
      // `sandbox/mode` is a real, log-only event declared in this repository,
      // so it is a member of the generated KNOWN_SESSION_EVENT_TYPES set. The
      // cast is needed only because the module that augments SessionEventMap
      // with it is not imported here.
      const appendKnown = session.append.bind(session) as unknown as (type: string, data: unknown) => unknown
      appendKnown('sandbox/mode', { mode: 'read-only', source: 'delegation' })
      const events = [...session.snapshotEvents()] as never[]
      expect(() => validateStoredEvents(session.header, events)).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/* ------------------------------------------------------------------ A5 --- */

/**
 * The sidecar contract §11.1.1 specifies, implemented here as a probe so the
 * Gate proves the mechanism is reachable with plain `node:fs` before any
 * product code depends on it. Stage 1 owns the real implementation.
 */
function writeIdentityFile(root: string, childId: string, payload: Record<string, unknown>): void {
  const dir = join(root, '.children')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `${childId}.json`)
  const temp = `${target}.${process.pid}.${createHash('sha256').update(childId).digest('hex').slice(0, 8)}.tmp`
  writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
  renameSync(temp, target)
}

function readIdentityFile(root: string, childId: string): Record<string, unknown> | undefined {
  const target = join(root, '.children', `${childId}.json`)
  if (!existsSync(target)) return undefined
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

describe('A5 — sidecar identity store contract', () => {
  const identity = (agentId: string) => ({
    version: 1,
    agentId,
    mainAgentId: 'banbo',
    presetId: 'banbo',
    rootSessionId: 'session-root',
    generation: 'sha256:probe',
  })

  it('writes atomically and reads back byte-identical data', () => {
    const root = makeScratch('sidecar-basic')
    writeIdentityFile(root, 'child-a', identity('executor'))
    expect(readIdentityFile(root, 'child-a')).toEqual(identity('executor'))
    // No temp residue survives a completed write.
    expect(readdirSync(join(root, '.children')).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('leaves no partial file when the write is interrupted before rename', () => {
    const root = makeScratch('sidecar-partial')
    const dir = join(root, '.children')
    mkdirSync(dir, { recursive: true })
    // Simulate a crash after the temp write but before the rename.
    writeFileSync(join(dir, 'child-b.json.1234.deadbeef.tmp'), '{ "version": 1')
    // The reader keys strictly on `<childId>.json`, so the half-written temp
    // is invisible and the child reads as "identity unknown" rather than as
    // corrupt data.
    expect(readIdentityFile(root, 'child-b')).toBeUndefined()
  })

  it('concurrent writes to distinct children never collide', async () => {
    const root = makeScratch('sidecar-concurrent')
    const ids = Array.from({ length: 24 }, (_, i) => `child-${i}`)
    await Promise.all(ids.map(async (id) => {
      await Promise.resolve()
      writeIdentityFile(root, id, identity(`agent-${id}`))
    }))
    for (const id of ids) {
      expect(readIdentityFile(root, id), `missing ${id}`).toEqual(identity(`agent-${id}`))
    }
    expect(readdirSync(join(root, '.children')).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('distinguishes missing from corrupt without throwing', () => {
    const root = makeScratch('sidecar-corrupt')
    mkdirSync(join(root, '.children'), { recursive: true })
    expect(readIdentityFile(root, 'never-written')).toBeUndefined()

    writeFileSync(join(root, '.children', 'child-broken.json'), '{ not json')
    // Corrupt resolves to the same "identity unknown" outcome the fail-closed
    // policy consumes; it must not propagate a parse error.
    expect(readIdentityFile(root, 'child-broken')).toBeUndefined()
  })

  it('uses the documented 0700 directory / 0600 file modes on POSIX', () => {
    if (process.platform === 'win32') return
    const root = makeScratch('sidecar-modes')
    writeIdentityFile(root, 'child-m', identity('review'))
    const dirMode = (statSync(join(root, '.children')).mode & 0o777).toString(8)
    const fileMode = (statSync(join(root, '.children', 'child-m.json')).mode & 0o777).toString(8)
    expect(dirMode).toBe('700')
    expect(fileMode).toBe('600')
  })
})

/* ------------------------------------------------------------------ A6 --- */

describe('A6 — depth arithmetic the standing tool graph depends on', () => {
  it('resolveChildDepth counts one level below the parent and enforces a numeric cap', () => {
    // `delegationDepthOf` reads the runtime `options.subagentDepth` and the
    // durable `session.header.delegationDepth`, taking the max — the persisted
    // header is the monotone floor a resumed child cannot drop below.
    const fakeAgent = (headerDepth: number | undefined, runtimeDepth?: number) => ({
      options: runtimeDepth === undefined ? {} : { subagentDepth: runtimeDepth },
      session: { header: headerDepth === undefined ? {} : { delegationDepth: headerDepth } },
    })
    // A top-level agent has depth 0; its child is 1; that child's child is 2.
    expect(subagent.delegationDepthOf(fakeAgent(undefined) as never)).toBe(0)
    expect(subagent.resolveChildDepth(fakeAgent(undefined) as never, 2)).toBe(1)
    expect(subagent.resolveChildDepth(fakeAgent(1) as never, 2)).toBe(2)
    // Exceeding the cap is a typed, loud failure rather than a silent clamp.
    assert.throws(() => subagent.resolveChildDepth(fakeAgent(2) as never, 2), subagent.SubagentDepthError)
    // The runtime stamp participates through the max(), so a resumed parent
    // whose header lost depth still cannot delegate as if it were top-level.
    expect(subagent.delegationDepthOf(fakeAgent(undefined, 3) as never)).toBe(3)
  })
})

/* ------------------------------------------------------------------ A7 --- */

describe('A7 — agent/created is a vetoable publication boundary', () => {
  async function registryHost() {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const host = await ctx.plugin({ name: 'gate-a7-host', inject: ['agents'], apply() {} })
    return { ctx, host }
  }

  function fakeAgent(id: string) {
    return { id, session: { id, header: { id } } }
  }

  it('publishes on a clean creation dispatch and announces the created agent', async () => {
    const { ctx, host } = await registryHost()
    try {
      const seen: string[] = []
      host.ctx.on('agent/created', (payload) => { seen.push(payload.agent.id) })
      host.ctx.agents.register(fakeAgent('clean-child') as never)
      expect(seen).toEqual(['clean-child'])
      expect(host.ctx.agents.get('clean-child' as never)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses publication when a synchronous creation listener throws', async () => {
    const { ctx, host } = await registryHost()
    try {
      // The platform fact the standing-scope design depends on: `agent/created`
      // is composition-only, so a synchronous throw from one of our listeners
      // must abort the create rather than leave a half-composed agent live.
      host.ctx.on('agent/created', () => { throw new Error('gate-a7 veto') })
      expect(() => host.ctx.agents.register(fakeAgent('veto-child') as never)).toThrow(/gate-a7 veto/)
      expect(host.ctx.agents.get('veto-child' as never)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/* ------------------------------------------------------------------ A8 --- */

describe('A8 — agent/created precedes agent/session-start', () => {
  it('emits created before session-start for one production agent', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      const harness = await mountAgentLoopTestHarness(ctx)
      const order: string[] = []
      ctx.on('agent/created', () => { order.push('created') })
      ctx.on('agent/session-start', () => { order.push('session-start') })

      await harness.create('a8-child' as never, { provider: 'gate-a8', model: 'gate-a8' })

      // The activation gate in §9.3 is a synchronous `agent/created` listener,
      // so the platform must publish BEFORE the startup-driving extension point
      // (`agent/session-start`) runs; otherwise the gate could not install the
      // persona/restriction before the first turn.
      expect(order).toContain('created')
      expect(order).toContain('session-start')
      expect(order.indexOf('created')).toBeLessThan(order.indexOf('session-start'))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/* ------------------------------------------------------------------ A9 --- */

describe('A9 — one-shot run identity and its post-start keying window', () => {
  it('returns a local run whose id is the published child session id, still unacted', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      const harness = await mountAgentLoopTestHarness(ctx)
      await ctx.plugin(subagent.SubagentRuntime)
      // The official in-process spawn provider is the one-shot backend the
      // identity design keys on (§11.1.1). Its plugin id registers `spawn`.
      await ctx.plugin(spawnProvider as never, { providerName: 'spawn' } as never)
      const parent = await harness.create(
        'a9-parent' as never,
        { provider: 'gate-a9', model: 'gate-a9' },
        { cwd: process.cwd() },
      )

      const controller = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        parent,
        prompt: [{ type: 'text', text: 'gate-a9 prompt' }],
        signal: controller.signal,
      } as never)

      // The seam contract: a local run's `id` MUST equal the child session id.
      expect(run.localAgent).toBeDefined()
      expect(run.id).toBe(run.localAgent!.session.id)
      expect(run.id).toBe(run.localAgent!.id)

      // The window the live map relies on: when `start()` has returned, the
      // child is published but has not yet executed a tool call, so a key
      // written now is readable before the child can read its own identity.
      const events = run.localAgent!.session.snapshotEvents()
      expect(events.some((event) => event.type === 'tool/call')).toBe(false)

      controller.abort('gate-a9 done')
      await run.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


