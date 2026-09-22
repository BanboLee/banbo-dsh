/**
 * MainRuntime activation gate — docs/agents-plugin-plan.md §9.3/§9.4.
 *
 * Pure policy cases identify precise failures; the integration cases mount the
 * real ToolRuntime/SystemPrompt scoped registries. No AgentLoop, model or I/O.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

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

function service(options: { disabledMain?: boolean; disabledChild?: boolean } = {}) {
  const defs = definitions()
  return {
    generation: 'gen-test',
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
    session: { header: { agentPreset: string }; snapshotEvents: ReturnType<typeof vi.fn> }
  }
}

async function realHarness(options: { ownTool?: string } = {}): Promise<RealHarness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'global persona' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const host = await ctx.plugin({ name: 'main-runtime-spec-host', inject: ['tools', 'systemPrompt'], apply() {} })

  for (const tool of REGISTERED) host.ctx.tools.register(toolDefinition(tool) as never)
  // This tool proves an own-layer registration cannot be filtered and therefore
  // must make the post-install exact-set self-check fail.
  const agent: RealHarness['agent'] = {
    id: 'session-1',
    ctx: undefined as never,
    options: { provider: 'official', model: 'selected-model' },
    session: { header: { agentPreset: 'lead-preset' }, snapshotEvents: vi.fn(() => []) },
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
    expect(harness.agent.session.snapshotEvents).toHaveBeenCalledTimes(2)
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
