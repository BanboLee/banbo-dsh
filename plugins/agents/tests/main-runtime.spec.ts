/**
 * MainRuntime activation gate — docs/agents-plugin-plan.md §9.3/§9.4.
 *
 * Pure policy cases identify precise failures; the integration cases mount the
 * real ToolRuntime/SystemPrompt scoped registries. No AgentLoop, model or I/O.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Session, SessionStore, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'

import mainRuntime, {
  Config,
  IDENTITY_SECTION,
  IDENTITY_TEXT,
  MainActivationError,
  activateMainAgent,
  buildMainAllowlist,
  delegationGuardReason,
  inject,
  installIdentitySection,
  name,
} from '../main-runtime.js'
import { reserveChildComposition, takeChildComposition } from '../child-composition.js'
import { CHILD_AUTHORITY_RECORD } from '../child-authority.js'
import { CHILD_IDENTITY_VERSION, readChildIdentity, readChildIdentityState, writeChildIdentity } from '../identity.js'

interface Definition {
  id: string
  allowedChildren: string[]
  main?: {
    presetId: string
    persona: string
    tools: string[]
    extraTools?: string[]
    maxDepth: number
  }
  child?: { model: Record<string, unknown> }
}

function definitions(): Map<string, Definition> {
  return new Map([
    ['lead', {
      id: 'lead',
      allowedChildren: ['helper', 'disabled-child'],
      main: {
        presetId: 'lead-preset',
        persona: 'prompts/lead.md',
        tools: ['read'],
        maxDepth: 1,
      },
    }],
    ['helper', { id: 'helper', allowedChildren: [], child: { model: { default: true } } }],
    ['disabled-child', { id: 'disabled-child', allowedChildren: [], child: { model: { default: true } } }],
    ['depth-zero', {
      id: 'depth-zero',
      allowedChildren: ['helper'],
      main: {
        presetId: 'depth-zero',
        persona: 'prompts/zero.md',
        tools: ['read'],
        maxDepth: 0,
      },
    }],
  ])
}

/** One temp root per test process; the sidecars are tiny and never inspected by path. */
const scratchRoots: string[] = []
function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'banbo-main-runtime-'))
  scratchRoots.push(root)
  return root
}
afterAll(() => {
  while (scratchRoots.length > 0) rmSync(scratchRoots.pop()!, { recursive: true, force: true })
})

function service(options: { disabledMain?: boolean; disabledChild?: boolean } = {}) {
  const defs = definitions()
  return {
    generation: 'gen-test',
    // A real data root: a cold-resume child is identified by its sidecar, so the
    // binding checks need a directory the test can actually write to.
    rootDir: scratchRoot(),
    definitions: defs,
    personas: new Map([
      ['prompts/lead.md', '# Role\n\nLead the work.\n'],
      ['prompts/zero.md', '# Role\n\nDo not delegate.\n'],
    ]),
    abi: {
      agents: [
        { id: 'lead', toolName: 'agent_lead', hasMain: true, presetId: 'lead-preset' },
        { id: 'helper', toolName: 'agent_helper', hasChild: true },
        { id: 'disabled-child', toolName: 'agent_disabled_child', hasChild: true },
        { id: 'retired', toolName: 'agent_retired', hasChild: true, retired: true },
      ],
    },
    settings: {
      policy(agentId: string) {
        const definition = defs.get(agentId)
        return {
          agentId,
          definition,
          exists: definition !== undefined,
          retired: agentId === 'retired',
          effectiveEnabled: agentId === 'lead'
            ? !options.disabledMain
            : agentId === 'disabled-child'
              ? !options.disabledChild
              : definition !== undefined,
          model: definition?.child?.model,
        }
      },
    },
  }
}

const REGISTERED = new Set([
  'read', 'read_image', 'agent_helper', 'agent_disabled_child',
  'agent_retired', 'delegate_batch',
])

function fakeAgent(origin?: 'subagent') {
  return {
    id: 'session-1',
    options: { provider: 'provider-from-official-selector', model: 'model-from-official-selector' },
    session: {
      header: { agentPreset: 'lead-preset', ...(origin === undefined ? {} : { origin }) },
      snapshotEvents: vi.fn(() => []),
    },
  }
}

function toolDefinition(name: string) {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({}),
  }
}

describe('plugin metadata', () => {
  it('declares the preset runtime identity and strict agentId config', () => {
    expect(name).toBe('banbo-main-runtime')
    expect(inject).toEqual(expect.arrayContaining(['banboAgents', 'agentPresets', 'tools', 'systemPrompt']))
    expect(Config['~standard'].validate({ agentId: 'my-lead' }).value).toEqual({ agentId: 'my-lead' })
    expect(() => Config['~standard'].validate({ agentId: 'Bad_Id' })).toThrow()
    expect(typeof mainRuntime).toBe('function')
  })
})

describe('buildMainAllowlist', () => {
  it('combines ordinary tools with direct named children and delegate_batch', () => {
    expect(buildMainAllowlist(service() as never, 'lead', REGISTERED)).toEqual([
      'read', 'read_image', 'agent_helper', 'agent_disabled_child', 'delegate_batch',
    ])
  })

  it('exposes no delegation tool when maxDepth is zero', () => {
    expect(buildMainAllowlist(service() as never, 'depth-zero', REGISTERED)).toEqual(['read', 'read_image'])
  })

  it('fails before restriction when a derived standing tool is absent', () => {
    expect(() => buildMainAllowlist(service() as never, 'lead', new Set(['read', 'read_image'])))
      .toThrow(/agent_helper|register/i)
  })
})

describe('activation failures', () => {
  it('rejects a missing, retired, or main-less configured definition', () => {
    for (const agentId of ['missing', 'retired', 'helper']) {
      expect(() => buildMainAllowlist(service() as never, agentId, REGISTERED), agentId)
        .toThrow(MainActivationError)
    }
  })

  it('rejects a disabled main agent before any model request', () => {
    expect(() => buildMainAllowlist(service({ disabledMain: true }) as never, 'lead', REGISTERED))
      .toThrow(/disabled|enable/i)
  })

  it('rejects a composition whose preset does not map to configured mainAgentId', async () => {
    const harness = await realHarness()
    expect(() => activateMainAgent({
      agent: harness.agent as never,
      service: service() as never,
      configuredAgentId: 'lead',
      composedPreset: 'some-other-preset',
    })).toThrow(/preset|mapping/i)
  })

  it('rejects a missing preloaded persona instead of reading during the listener', async () => {
    const harness = await realHarness()
    const state = service()
    state.personas.delete('prompts/lead.md')
    expect(() => activateMainAgent({
      agent: harness.agent as never,
      service: state as never,
      configuredAgentId: 'lead',
      composedPreset: 'lead-preset',
    })).toThrow(/persona|preloaded/i)
  })
})

interface RealHarness {
  ctx: Context
  agent: {
    id: string
    ctx: Context
    options: Record<string, string>
    // A real Session: the composition authority is persisted through the official
    // plugin-record API, which requires the real receiver.
    session: Session
  }
}

async function realHarness(options: { ownTool?: string } = {}): Promise<RealHarness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'global persona' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  // A REAL Session: the delegated-child path now persists the composition
  // authority into the child's own log, so a stub would make the write throw.
  await ctx.plugin(SessionStore)
  const host = await ctx.plugin({ name: 'main-runtime-spec-host', inject: ['tools', 'systemPrompt'], apply() {} })

  for (const tool of REGISTERED) host.ctx.tools.register(toolDefinition(tool) as never)
  // This tool proves an own-layer registration cannot be filtered and therefore
  // must make the post-install exact-set self-check fail.
  const agent: RealHarness['agent'] = {
    id: 'session-1',
    ctx: undefined as never,
    options: { provider: 'official', model: 'selected-model' },
    // A real Session, created through the official store so the plugin-record
    // write and read in this bundle run against the real API.
    session: ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } }),
  }
  const scoped = createScope(host.ctx, agent)
  agent.ctx = scoped.ctx
  if (options.ownTool !== undefined) agent.ctx.tools.register(toolDefinition(options.ownTool) as never)
  return { ctx, agent }
}

describe('activateMainAgent — real scoped registries', () => {
  it('installs persona, exact restriction, and guard synchronously without touching model selection', async () => {
    const harness = await realHarness()
    const optionsBefore = structuredClone(harness.agent.options)
    const eventsBefore = harness.agent.session.snapshotEvents()

    const result = activateMainAgent({
      agent: harness.agent as never,
      service: service() as never,
      configuredAgentId: 'lead',
      composedPreset: 'lead-preset',
    })

    expect(result.allow).toEqual([
      'read', 'read_image', 'agent_helper', 'agent_disabled_child', 'delegate_batch',
    ])
    expect(harness.agent.ctx.tools.schemas(harness.agent as never).map((tool) => tool.name)).toEqual(result.allow)
    const assembly = await harness.agent.ctx.systemPrompt.assemble({ scope: harness.agent as never })
    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: 'deployment:persona-prefix',
      text: '# Role\n\nLead the work.\n',
    }))
    expect(harness.agent.options).toEqual(optionsBefore)
    expect(harness.agent.session.snapshotEvents()).toEqual(eventsBefore)
    // `snapshotEvents` is the real Session method now, not a spy: assert the
    // observable fact (no event was appended) instead of a call count.
    expect(harness.agent.session.snapshotEvents()).toEqual(eventsBefore)
  })

  it('fails the exact-set self-check when an agent-own tool bypasses inherited restrictions', async () => {
    const harness = await realHarness({ ownTool: 'unexpected-own-tool' })
    expect(() => activateMainAgent({
      agent: harness.agent as never,
      service: service() as never,
      configuredAgentId: 'lead',
      composedPreset: 'lead-preset',
    })).toThrow(/unexpected-own-tool|self-check|visible/i)
  })
})

describe('delegated child composition in the creation window', () => {
  /**
   * A REAL Session carrying a subagent header.
   *
   * The composition authority is persisted into the child's own log through the
   * official plugin-record API, which validates its receiver, so a plain object
   * stand-in cannot exercise this path. `origin: 'subagent'` is what routes the
   * `agent/created` listener into the delegated-child branch.
   */
  function subagentSession(ctx: Context): RealHarness['agent']['session'] {
    return ctx.sessions.create(undefined, { meta: { cwd: process.cwd(), origin: 'subagent' } })
  }

  /** Capture the `agent/created` listener the preset entry registers. */
  function listenerHarness(state: ReturnType<typeof service>, configuredMain = 'lead') {
    let listener: ((payload: { agent: RealHarness['agent'] }) => void) | undefined
    const ctx = {
      banboAgents: state,
      agentPresets: { composedPreset: () => 'lead-preset' },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      on: (event: string, callback: never) => { if (event === 'agent/created') listener = callback },
    }
    mainRuntime(ctx as never, { agentId: configuredMain })
    return (agent: RealHarness['agent']) => listener?.({ agent })
  }

  it('applies the parked persona and tool surface to a fresh delegated child', async () => {
    // 0.2.1 dropped `persona`/`toolFilter` from the start request, so the child
    // arrives with neither and this bundle must install both before the child's
    // first model request.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    const child = {
      ...harness.agent,
      id: 'delegated-child',
      session: subagentSession(harness.ctx),
    }
    // Scoped under the agent that already carries the host's `tools`/
    // `systemPrompt` inject declarations, exactly like a real delegated child.
    const scoped = createScope(harness.agent.ctx, child)
    child.ctx = scoped.ctx

    reserveChildComposition('delegated-child', {
      agentId: 'helper',
      mainAgentId: 'lead',
      persona: '# Helper\n',
      toolFilter: { allow: ['read'] },
    })
    fire(child as never)

    const assembly = await child.ctx.systemPrompt.assemble({ scope: child as never })
    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: 'deployment:persona-prefix',
      text: '# Helper\n',
    }))
    expect(child.ctx.tools.schemas(child as never).map((tool) => tool.name)).toEqual(['read'])
    // Consumed, so a later resume of the same id cannot re-apply a stale form.
    expect(takeChildComposition('delegated-child')).toBeUndefined()
  })

  it('falls back to the sidecar path for a resumed child with no parked composition', async () => {
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    const child = {
      ...harness.agent,
      id: 'resumed-child',
      session: subagentSession(harness.ctx),
    }
    const scoped = createScope(harness.agent.ctx, child)
    child.ctx = scoped.ctx

    // No reservation: a resumed child is identified by its sidecar instead, and
    // an unknown one must not throw (it simply gets no extra restriction).
    expect(() => fire(child as never)).not.toThrow()
    expect(takeChildComposition('resumed-child')).toBeUndefined()
  })

  /**
   * COLD RESUME — the regression this suite exists for.
   *
   * 0.2.1's `subagent/descriptor` carries no persona and no toolFilter (verified
   * in `@deepseek-ai/dsh-subagent@0.2.1-rc.2`: the local-child descriptor is
   * built from mode/provider/label/agentOptions only). The harness therefore
   * rebuilds an idle continuable child with the preset's FULL surface. A child
   * that was delegated with `read` only must come back with `read` only, its
   * persona, and its write-scope guard — never with `write`/`edit` re-granted.
   */
  it('re-applies persona, allowlist and write guard on a cold resume, from the child log', async () => {
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)

    // ── creation window: a real child is composed and the record is written ──
    const created = {
      ...harness.agent,
      id: 'cold-child',
      session: subagentSession(harness.ctx),
    }
    created.ctx = createScope(harness.agent.ctx, created).ctx
    reserveChildComposition('cold-child', {
      agentId: 'helper',
      mainAgentId: 'lead',
      persona: '# Helper\n',
      toolFilter: { allow: ['read'] },
    })
    fire(created as never)

    // The authority is now durable IN THE CHILD'S OWN LOG — the only source a
    // later process can read, because the sidecar records identity, not surface.
    const records = created.session.snapshotEvents().map((event) => pluginRecordOf(event))
    expect(records.some((record) => record?.type === CHILD_AUTHORITY_RECORD)).toBe(true)

    // A continuable child ALSO has a durable identity sidecar; the resume-time
    // binding checks compare the record against it, so a cold resume without one
    // is a different (fail-closed) case covered separately below.
    writeChildIdentity(state.rootDir, 'cold-child', {
      version: CHILD_IDENTITY_VERSION,
      agentId: 'helper',
      mainAgentId: 'lead',
      presetId: 'lead-preset',
      rootSessionId: 'root-session',
      generation: 'gen-test',
    })

    // ── cold resume: a FRESH agent object, same session log, no reservation ──
    const resumed = {
      ...harness.agent,
      id: 'cold-child',
      session: created.session,
    }
    resumed.ctx = createScope(harness.agent.ctx, resumed).ctx

    // The harness restored the full preset surface, exactly as 0.2.1 does.
    expect(resumed.ctx.tools.schemas(resumed as never).map((tool) => tool.name).sort())
      .toEqual([...REGISTERED].sort())

    fire(resumed as never)

    // Persona re-applied from the record.
    const assembly = await resumed.ctx.systemPrompt.assemble({ scope: resumed as never })
    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: 'deployment:persona-prefix',
      text: '# Helper\n',
    }))
    // …and the surface is narrowed back to the authorised set, not the preset's.
    expect(resumed.ctx.tools.schemas(resumed as never).map((tool) => tool.name)).toEqual(['read'])
  })

  it('fails closed to an EMPTY surface when the authority record is corrupt', async () => {
    // A record that cannot be validated must never read as "no restriction".
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    const child = {
      ...harness.agent,
      id: 'corrupt-child',
      session: subagentSession(harness.ctx),
    }
    child.ctx = createScope(harness.agent.ctx, child).ctx

    // Write a record of the right TYPE with an unusable payload: no `allow`, a
    // future version, and an extra field. Each is independently invalid.
    appendPluginRecord(child.session, CHILD_AUTHORITY_RECORD as never, {
      version: 999,
      agentId: 'helper',
      mainAgentId: 'lead',
      persona: '# Helper\n',
      extra: true,
    } as never)

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  /* ------------------------------------------- ownership and binding --- */

  /** Write one child's durable identity sidecar under the test data root. */
  function sidecar(state: ReturnType<typeof service>, childId: string, overrides: Record<string, string> = {}) {
    writeChildIdentity(state.rootDir, childId, {
      version: CHILD_IDENTITY_VERSION,
      agentId: 'helper',
      mainAgentId: 'lead',
      presetId: 'lead-preset',
      rootSessionId: 'root-session',
      generation: 'gen-test',
      ...overrides,
    })
  }

  /** Build a fresh subagent agent bound to one session. */
  function childAgent(harness: Awaited<ReturnType<typeof realHarness>>, id: string, session?: Session) {
    const child = {
      ...harness.agent,
      id,
      session: session ?? subagentSession(harness.ctx),
    }
    child.ctx = createScope(harness.agent.ctx, child).ctx
    return child
  }

  it('fails closed for a KNOWN child whose authority record is absent', async () => {
    // The sidecar proves this bundle created the child, so a missing authority
    // record means the authorisation was LOST — not that the child is a
    // third-party subagent. Falling through to "leave it alone" would hand a
    // durable banbo child the harness-restored preset surface.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    sidecar(state, 'known-child')
    const child = childAgent(harness, 'known-child')

    expect(child.ctx.tools.schemas(child as never).map((tool) => tool.name).sort())
      .toEqual([...REGISTERED].sort())

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('leaves a child with NEITHER a record NOR a sidecar untouched', async () => {
    // The only genuinely third-party case: no durable evidence at all.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    const child = childAgent(harness, 'foreign-child')

    const before = child.ctx.tools.schemas(child as never).map((tool) => tool.name).sort()
    fire(child as never)

    expect(child.ctx.tools.schemas(child as never).map((tool) => tool.name).sort()).toEqual(before)
  })

  /* ------------------------------- sidecar tri-state (real files) --- */

  /**
   * A sidecar that EXISTS but cannot be trusted must fail closed, exactly like a
   * missing authority record on a known child. The three ways that happens are
   * exercised against REAL files, because the distinction lives in the read:
   * `ENOENT` is absence, every other outcome is "a record is there and I cannot
   * use it".
   */
  it.each([
    ['corrupt JSON', 'not json at all'],
    ['a future version', '{"version":999,"agentId":"helper","mainAgentId":"lead","presetId":"p","rootSessionId":"r","generation":"g"}'],
    ['an unknown key set', '{"version":1,"agentId":"helper","mainAgentId":"lead","presetId":"p","rootSessionId":"r","generation":"g","extra":1}'],
    ['an empty file', ''],
  ])('fails closed when the sidecar holds %s and no authority record exists', async (_label, payload) => {
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    const childId = `damaged-sidecar-${_label.replace(/[^a-z0-9]+/gi, '-')}`
    mkdirSync(join(state.rootDir, '.children'), { recursive: true })
    writeFileSync(join(state.rootDir, '.children', `${childId}.json`), payload)
    const child = childAgent(harness, childId)

    // The harness-restored surface is the full preset set.
    expect(child.ctx.tools.schemas(child as never).map((tool) => tool.name).sort())
      .toEqual([...REGISTERED].sort())

    fire(child as never)

    // NOT untouched: a damaged sidecar is a KNOWN child, so the surface is empty.
    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('fails closed when the sidecar path cannot be read (a directory, not a file)', async () => {
    // A read error that is NOT ENOENT: the record may exist but is uninspectable.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    mkdirSync(join(state.rootDir, '.children', 'unreadable-child.json'), { recursive: true })
    const child = childAgent(harness, 'unreadable-child')

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('distinguishes the three sidecar states directly', () => {
    // The predicate the composition path relies on, asserted without an agent.
    const rootDir = scratchRoot()
    expect(readChildIdentityState(rootDir, 'never-written')).toEqual({ state: 'absent' })

    mkdirSync(join(rootDir, '.children'), { recursive: true })
    writeFileSync(join(rootDir, '.children', 'corrupt.json'), 'nope')
    expect(readChildIdentityState(rootDir, 'corrupt').state).toBe('invalid')

    writeChildIdentity(rootDir, 'good-child', {
      version: CHILD_IDENTITY_VERSION,
      agentId: 'helper',
      mainAgentId: 'lead',
      presetId: 'lead-preset',
      rootSessionId: 'root',
      generation: 'gen',
    })
    expect(readChildIdentityState(rootDir, 'good-child').state).toBe('valid')
    // The legacy reader still collapses invalid to `undefined`, which is why the
    // composition path uses the tri-state one.
    expect(readChildIdentity(rootDir, 'corrupt')).toBeUndefined()
    expect(readChildIdentity(rootDir, 'never-written')).toBeUndefined()
  })

  it('fails closed when the record names a different agent than the sidecar', async () => {
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    sidecar(state, 'mismatched-child', { agentId: 'disabled-child' })
    const child = childAgent(harness, 'mismatched-child')
    // A record for `helper` on a child whose sidecar says `disabled-child`.
    appendPluginRecord(child.session, CHILD_AUTHORITY_RECORD as never, {
      version: 1, agentId: 'helper', mainAgentId: 'lead', persona: '# Helper\n', allow: ['read'],
    } as never)

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('fails closed when the record names a different OWNING main than the sidecar', async () => {
    // A record transplanted from another deployment would otherwise be honoured
    // and grant that deployment's allowlist here.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    sidecar(state, 'foreign-main-child', { mainAgentId: 'other-main' })
    const child = childAgent(harness, 'foreign-main-child')
    appendPluginRecord(child.session, CHILD_AUTHORITY_RECORD as never, {
      version: 1, agentId: 'helper', mainAgentId: 'other-main', persona: '# Helper\n', allow: ['read'],
    } as never)

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('fails closed when the recorded main is not THIS process configured main', async () => {
    // Both durable facts agree with each other but name a main this process does
    // not run: the record belongs to another deployment and must not apply.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    sidecar(state, 'other-deployment-child', { mainAgentId: 'lead' })
    const child = childAgent(harness, 'other-deployment-child')
    appendPluginRecord(child.session, CHILD_AUTHORITY_RECORD as never, {
      version: 1, agentId: 'helper', mainAgentId: 'lead', persona: '# Helper\n', allow: ['read'],
    } as never)

    // This runtime is mounted for a DIFFERENT main, so `lead` is not configured.
    const otherMain = listenerHarness(state, 'some-other-main')
    otherMain(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('fails closed when the recorded definition no longer exists', async () => {
    // A valid record whose Agent was deleted (a supported action) must not be
    // re-applied: the surface it authorised belongs to a definition nobody runs.
    const state = service()
    const harness = await realHarness()
    const fire = listenerHarness(state)
    sidecar(state, 'removed-definition-child')
    const child = childAgent(harness, 'removed-definition-child')
    appendPluginRecord(child.session, CHILD_AUTHORITY_RECORD as never, {
      version: 1, agentId: 'helper', mainAgentId: 'lead', persona: '# Helper\n', allow: ['read'],
    } as never)

    // Delete the definition from the live catalog.
    state.definitions.delete('helper')

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })

  it('fails closed when the recorded definition is disabled', async () => {
    const state = service({ disabledChild: true })
    const harness = await realHarness()
    const fire = listenerHarness(state)
    sidecar(state, 'disabled-definition-child', { agentId: 'disabled-child' })
    const child = childAgent(harness, 'disabled-definition-child')
    appendPluginRecord(child.session, CHILD_AUTHORITY_RECORD as never, {
      version: 1, agentId: 'disabled-child', mainAgentId: 'lead', persona: '# Disabled\n', allow: ['read'],
    } as never)

    fire(child as never)

    expect(child.ctx.tools.schemas(child as never)).toEqual([])
  })
})

describe('delegation execution guard', () => {
  it('does not deny ordinary tools when a running main agent is later disabled', () => {
    expect(delegationGuardReason(service({ disabledMain: true }) as never, 'lead', {
      name: 'read', arguments: {},
    } as never)).toBeUndefined()
  })

  it('denies subsequent delegation when the main or target is disabled', () => {
    expect(delegationGuardReason(service({ disabledMain: true }) as never, 'lead', {
      name: 'agent_helper', arguments: {},
    } as never)).toMatch(/lead.*disabled|disabled.*lead/i)
    expect(delegationGuardReason(service({ disabledChild: true }) as never, 'lead', {
      name: 'agent_disabled_child', arguments: {},
    } as never)).toMatch(/disabled-child.*disabled|disabled.*disabled-child/i)
  })

  it('fails closed for retired, unknown, or unauthorised stable tool names', () => {
    for (const tool of ['agent_retired', 'agent_unknown', 'agent_lead']) {
      expect(delegationGuardReason(service() as never, 'lead', { name: tool, arguments: {} } as never), tool)
        .toMatch(/retired|unknown|not authoris|not allow/i)
    }
  })
})

describe('plugin listener boundary', () => {
  it('ignores subagents and synchronously propagates a top-level activation failure', () => {
    let listener: ((payload: { agent: ReturnType<typeof fakeAgent> }) => void) | undefined
    const section = vi.fn(() => () => {})
    const ctx = {
      banboAgents: service({ disabledMain: true }),
      agentPresets: { composedPreset: () => 'lead-preset' },
      systemPrompt: { section, getSectionOrder: vi.fn(() => 0) },
      on: vi.fn((event, callback) => {
        if (event === 'agent/created') listener = callback
      }),
    }
    mainRuntime(ctx as never, { agentId: 'lead' })
    // The preset-scope identity line is installed once, before any agent exists.
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: IDENTITY_SECTION, text: IDENTITY_TEXT }))
    expect(listener).toBeTypeOf('function')
    expect(() => listener?.({ agent: fakeAgent('subagent') })).not.toThrow()
    expect(() => listener?.({ agent: fakeAgent() })).toThrow(/disabled/i)
  })
})

describe('the identity line survives per-agent persona shadowing', () => {
  /** Preset scope (template's `dsh-persona` + our identity) under an agent scope. */
  async function layeredHarness() {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const host = await ctx.plugin({ name: 'identity-host', inject: ['systemPrompt'], apply() {} })

    const presetKey = { id: 'preset' }
    const preset = createScope(host.ctx, presetKey)
    preset.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: preset.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: 'PRESET-PERSONA-SHADOWED',
    })
    installIdentitySection(preset.ctx)

    const agentKey = { id: 'agent' }
    // A scope chain is explicit: `createScope` does not infer parenthood from
    // the minting context, exactly as `agentPresets.mount()` binds the agent
    // key under the standing preset key in production.
    const agent = createScope(preset.ctx, agentKey, { parent: presetKey })
    agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: 'AGENT-PERSONA',
    })
    return { ctx, agentKey, agent }
  }

  it('keeps the identity line while the agent persona shadows the preset prefix', async () => {
    const { ctx, agentKey, agent } = await layeredHarness()
    try {
      const assembly = await agent.ctx.systemPrompt.assemble({ scope: agentKey as never })
      const texts = assembly.sections.map((section) => section.text)

      expect(texts).toContain(IDENTITY_TEXT)
      expect(texts).toContain('AGENT-PERSONA')
      // A scoped section shadows the same name from an outer scope — the
      // platform behaviour that made parking the identity line in the preset's
      // persona prefix a silent loss.
      expect(texts).not.toContain('PRESET-PERSONA-SHADOWED')
      // Identity reads first, then the agent's own persona.
      expect(texts.indexOf(IDENTITY_TEXT)).toBeLessThan(texts.indexOf('AGENT-PERSONA'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers exactly one identity section per preset scope', async () => {
    const { ctx, agentKey, agent } = await layeredHarness()
    try {
      const assembly = await agent.ctx.systemPrompt.assemble({ scope: agentKey as never })
      const mine = assembly.sections.filter((section) => section.name === IDENTITY_SECTION)
      expect(mine).toHaveLength(1)
      expect(mine[0]!.text).toBe(IDENTITY_TEXT)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
