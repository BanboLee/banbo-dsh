/**
 * Deterministic unit tests for the `@banbolee/dsh-fish-shell` per-agent fish
 * policy (`policy.js`): every agent composed under any preset must see the
 * host-global `fish` tool and never the preset's inherited `bash` tool, and
 * the preset's `tool:bash` prompt guidance must be shadowed by an empty
 * agent-scoped section.
 *
 * The suite mounts the REAL `SystemPrompt` and `ToolRuntime` services on a
 * real Cordis `Context` and composes real scopes (`createScope` +
 * `bindScopeParent`), exactly like the harness does — no mocks of the
 * registry machinery, no harness boot, no network.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as policy from '../policy.js'

const BASH_GUIDANCE = 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'

/** The dsh-agent announce path emits `agent/created` / `tools/change` with a
 * payload object; cast the strictly-typed Cordis event surface away. */
function emit(ctx: Context, name: string, payload?: unknown): void {
  ;(ctx.emit as (event: string, ...args: unknown[]) => void)(name, ...(payload === undefined ? [] : [payload]))
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: () => Array<{ type: 'text'; text: string }>
  }
  execute: () => Promise<unknown>
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string', description: 'The command to run.' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { type: 'string', const: 'foreground' } },
      },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({ kind: 'foreground' }),
  }
}

/** The official `@deepseek-ai/dsh-tool-bash-persistent` shape: parameters is
 * a property map holding ONLY `command` and the output schema is a plain
 * string — the signature the policy detects to swap in persistent fish. */
function persistentBashDefinition(name: string): ToolDefinition {
  return {
    name,
    description: 'Run commands in a persistent bash shell.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run.' },
    },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => 'ok',
  }
}

interface Assembly {
  sections: Array<{ name: string; text: string }>
  tools: Array<{ name: string }>
}

interface Harness {
  ctx: Context
  /** Host plugin context used to create additional standing preset scopes. */
  hostCtx: Context
  /** The preset standing scope key, used by recompose tests. */
  presetKey: object
  /** The preset standing scope ctx (bash tool + tool:bash section live there). */
  presetCtx: Context
  /** The binding that can re-link this agent to another preset scope. */
  binding: { rebind(parent: object): void }
  /** The agent object, which is also its scope key (as in dsh-agent-loop). */
  agent: object
  agentCtx: Context
  /** Additional agents composed under the same preset scope (multi-agent). */
  extraAgents: object[]
}

/** Compose one agent scope; the agent object IS the scope key and carries
 * its scoped ctx, exactly like dsh-agent-loop. The caller binds it under a
 * preset scope (and keeps the binding when re-linking is needed). */
function createAgentUnder(hostCtx: Context): { agent: object; agentCtx: Context } {
  const agent: { ctx?: Context } = {}
  const agentScope = createScope(hostCtx, agent)
  agent.ctx = agentScope.ctx
  return { agent, agentCtx: agentScope.ctx }
}

/** Mount the real services, then compose a preset scope and an agent scope
 * bound under it — the exact shape the harness builds per session. Scopes are
 * created from a host plugin ctx that injects tools/systemPrompt, mirroring
 * how dsh-agent-loop's scoped agent ctx resolves host services through its
 * loop fiber's inject store. */
async function composeHarness(options: {
  presetBash?: boolean
  persistentBash?: boolean
  presetDeniesFish?: boolean
  agentBash?: boolean
  /** Agent-scoped `tool:bash` section (a third-party agent's own shadow). */
  agentToolBashSection?: boolean
  /** How many extra agents to compose under the same preset scope. */
  extraAgents?: number
} = {}): Promise<Harness> {
  const {
    presetBash = true,
    persistentBash = false,
    presetDeniesFish = false,
    agentBash = false,
    agentToolBashSection = false,
    extraAgents = 0,
  } = options
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const host = await ctx.plugin({ name: 'policy-spec-host', inject: ['tools', 'systemPrompt'], apply() {} })
  const hostCtx = host.ctx

  // Host-global fish tool (this bundle's tool.js registers it on the host).
  ctx.tools.register(toolDefinition('fish'))

  const presetKey = {}
  const preset = createScope(hostCtx, presetKey)
  // The standard/minimal preset standing scope registers the bash tool and
  // its static prompt guidance (dsh-tool-bash does exactly this); minimal
  // registers the persistent-bash variant (dsh-tool-bash-persistent).
  if (presetBash) {
    preset.ctx.tools.register(persistentBash ? persistentBashDefinition('bash') : toolDefinition('bash'))
    preset.ctx.systemPrompt.section({
      name: 'tool:bash',
      order: preset.ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
      text: BASH_GUIDANCE,
    })
  }
  // A preset allowlist that excludes the host-global fish tool.
  if (presetDeniesFish) preset.ctx.tools.restrict({ deny: ['fish'] })

  // The agent is the scope key (dsh-agent-loop: createScope(loopCtx, this));
  // its scope is bound under the preset standing scope, and the loop assigns
  // `this.ctx = this.scope.ctx` in its constructor — mirror that here. The
  // binding is retained so tests can re-link exactly like AgentPresets.recompose.
  const { agent, agentCtx } = createAgentUnder(hostCtx)
  const binding = bindScopeParent(agent, presetKey)
  if (agentBash) {
    ;(agent as { ctx: Context }).ctx.tools.register(toolDefinition('bash'))
  }
  if (agentToolBashSection) {
    ;(agent as { ctx: Context }).ctx.systemPrompt.section({
      name: 'tool:bash',
      order: (agent as { ctx: Context }).ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
      text: 'third-party agent bash guidance',
    })
  }
  const extraAgentsList: object[] = []
  for (let index = 0; index < extraAgents; index += 1) {
    const extra = createAgentUnder(hostCtx)
    bindScopeParent(extra.agent, presetKey)
    extraAgentsList.push(extra.agent)
  }
  return {
    ctx,
    hostCtx,
    presetKey,
    presetCtx: preset.ctx,
    binding,
    agent,
    agentCtx,
    extraAgents: extraAgentsList,
  }
}

async function assembledSections(ctx: Context, agent: object): Promise<Assembly> {
  return (await ctx.systemPrompt.assemble({ scope: agent })) as unknown as Assembly
}

function catalogNames(ctx: Context, agent: object): string[] {
  return ctx.tools.schemas(agent).map((schema) => schema.name)
}

function fishIsPersistent(ctx: Context, agent: object): boolean {
  const fish = ctx.tools.get('fish', agent)
  return (fish?.output.schema as { type?: string } | undefined)?.type === 'string'
}

describe('installFishPolicy', () => {
  it('hides the preset-inherited bash tool and shadows its prompt guidance for an agent under a bash preset', async () => {
    const { ctx, agent } = await composeHarness()

    policy.installFishPolicy(ctx, agent)

    // The agent's catalog is fish-only: bash (inherited from the preset
    // standing scope) is denied, the host-global fish tool stays.
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(ctx.tools.get('fish', agent)).toBeDefined()
    expect(catalogNames(ctx, agent)).toEqual(['fish'])

    // The preset's static tool:bash guidance is shadowed by an empty
    // agent-scoped section, so assembly no longer carries the bash text.
    const assembly = await assembledSections(ctx, agent)
    const bashSection = assembly.sections.find((section) => section.name === 'tool:bash')
    expect(bashSection?.text).toBe('')
    expect(assembly.sections.some((section) => section.text.includes('bash result'))).toBe(false)
    expect(assembly.tools.map((tool) => tool.name)).toEqual(['fish'])
  })

  it('registers a persistent fish tool (shadowing one-shot fish) when the preset bash is the persistent form, then hides bash', async () => {
    const { ctx, agent } = await composeHarness({ persistentBash: true })
    const oneShotFish = ctx.tools.get('fish', agent)

    policy.installFishPolicy(ctx, agent)

    // The agent-scope `fish` is now the persistent tool: defineTool
    // normalizes the `{ command }` property map into a JSON schema whose
    // `properties` hold ONLY `command`, and the output schema is a plain
    // string — the one-shot host-global fish tool is shadowed at the agent
    // scope (different definition object, persistent description).
    const fish = ctx.tools.get('fish', agent)
    expect(fish).toBeDefined()
    expect(fish).not.toBe(oneShotFish)
    expect(Object.keys((fish?.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['command'])
    expect((fish?.output.schema as { type?: string }).type).toBe('string')
    expect(fish?.description).toContain('persistent fish')
    // bash is hidden and the prompt guidance shadowed as before.
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
    const assembly = await assembledSections(ctx, agent)
    expect(assembly.sections.some((section) => section.text.includes('bash result'))).toBe(false)
  })

  it('keeps the one-shot fish tool when the preset bash is the one-shot form', async () => {
    const { ctx, agent } = await composeHarness()
    const oneShotFish = ctx.tools.get('fish', agent)

    policy.installFishPolicy(ctx, agent)

    // The agent-scope `fish` is still the SAME host-global one-shot
    // definition (no persistent registration happened).
    expect(ctx.tools.get('fish', agent)).toBe(oneShotFish)
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
  })

  it('leaves a persistent-form bash in place and warns once when the preset allowlist filters fish out', async () => {
    const { ctx, agent } = await composeHarness({ persistentBash: true, presetDeniesFish: true })
    expect(ctx.tools.get('fish', agent)).toBeUndefined()
    expect(ctx.tools.get('bash', agent)).toBeDefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      policy.installFishPolicy(ctx, agent)
      policy.installFishPolicy(ctx, agent)

      // No persistent fish tool is registered (the allowlist is respected),
      // bash stays visible, and the agent is warned exactly once.
      expect(ctx.tools.get('fish', agent)).toBeUndefined()
      expect(ctx.tools.get('bash', agent)).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('is a no-op for an agent under a preset with no bash tool', async () => {
    const { ctx, agent } = await composeHarness({ presetBash: false })

    expect(() => policy.installFishPolicy(ctx, agent)).not.toThrow()

    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(ctx.tools.get('fish', agent)).toBeDefined()
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
  })

  it('leaves bash visible and warns once when a preset allowlist filters the global fish tool out', async () => {
    const { ctx, agent } = await composeHarness({ presetDeniesFish: true })
    expect(ctx.tools.get('fish', agent)).toBeUndefined()
    expect(ctx.tools.get('bash', agent)).toBeDefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      policy.installFishPolicy(ctx, agent)
      policy.installFishPolicy(ctx, agent)

      // The policy does not hide bash (fish is unavailable) and warns once.
      expect(ctx.tools.get('bash', agent)).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('applies the policy once per agent and stays idempotent for repeat calls', async () => {
    const { ctx, agent } = await composeHarness()

    policy.installFishPolicy(ctx, agent)
    // A second call (e.g. a tools/change reconcile) must not re-register or
    // throw — a duplicate agent-scoped tool:bash section would throw.
    expect(() => policy.installFishPolicy(ctx, agent)).not.toThrow()

    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
    const assembly = await assembledSections(ctx, agent)
    const bashSections = assembly.sections.filter((section) => section.name === 'tool:bash')
    expect(bashSections).toHaveLength(1)
    expect(bashSections[0]?.text).toBe('')
  })

  it('recomputes the fish surface when an agent switches between one-shot and persistent presets', async () => {
    const { ctx, hostCtx, presetKey, binding, agent } = await composeHarness()
    const minimalKey = {}
    const minimal = createScope(hostCtx, minimalKey)
    minimal.ctx.tools.register(persistentBashDefinition('bash'))
    minimal.ctx.systemPrompt.section({
      name: 'tool:bash',
      order: minimal.ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
      text: BASH_GUIDANCE,
    })

    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(false)
    expect(catalogNames(ctx, agent)).toEqual(['fish'])

    binding.rebind(minimalKey)
    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(true)
    expect(catalogNames(ctx, agent)).toEqual(['fish'])

    binding.rebind(presetKey)
    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(false)
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
  })

  it('swallows a restriction failure (agent-owned bash) with a warning and keeps the agent catalog intact', async () => {
    const { ctx, agent } = await composeHarness({ presetBash: false, agentBash: true })
    // The agent registers its OWN bash variant. Own-layer registrations are
    // visible but NOT restrictable (restrictions only filter inherited
    // tools), so tools.restrict({ deny: ['bash'] }) throws for this agent.
    expect(ctx.tools.get('bash', agent)).toBeDefined()
    expect(ctx.tools.get('fish', agent)).toBeDefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => policy.installFishPolicy(ctx, agent)).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }

    // The agent still sees its full catalog; bash is merely not hidden.
    expect(ctx.tools.get('bash', agent)).toBeDefined()
    expect(ctx.tools.get('fish', agent)).toBeDefined()
  })

  it('rolls back a newly-created restriction when the prompt shadow collides with a third-party agent section', async () => {
    const { ctx, agent } = await composeHarness({ agentToolBashSection: true })
    // The third-party agent registered its OWN tool:bash section at the
    // agent scope, so the policy's agent-scoped shadow throws on install.
    expect(ctx.tools.get('bash', agent)).toBeDefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      policy.installFishPolicy(ctx, agent)
      // The failed install rolled back its restriction: inherited bash stays
      // visible (no half-installed policy leaks) and the failure was warned.
      expect(ctx.tools.get('bash', agent)).toBeDefined()
      expect(ctx.tools.get('fish', agent)).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(1)

      // Retrying does not stack leaked restrictions: bash stays visible and
      // exactly one more warning is emitted.
      policy.installFishPolicy(ctx, agent)
      expect(ctx.tools.get('bash', agent)).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('switching from minimal to a deny-fish third-party preset leaves bash visible (own persistent fish must not mask the probe)', async () => {
    const { ctx, hostCtx, binding, agent } = await composeHarness({ persistentBash: true })
    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(true)
    expect(ctx.tools.get('bash', agent)).toBeUndefined()

    // Third-party preset: persistent bash PLUS an allowlist denying fish.
    const denyKey = {}
    const deny = createScope(hostCtx, denyKey)
    deny.ctx.tools.register(persistentBashDefinition('bash'))
    deny.ctx.tools.restrict({ deny: ['fish'] })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      binding.rebind(denyKey)
      policy.installFishPolicy(ctx, agent)
      // The probe must NOT count the policy's own previous persistent fish as
      // inherited fish visibility: the deny-fish preset leaves bash visible
      // with exactly one warning.
      expect(ctx.tools.get('fish', agent)).toBeUndefined()
      expect(ctx.tools.get('bash', agent)).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a fresh agent entering the same deny-fish third-party preset gets the identical result', async () => {
    const { ctx, hostCtx } = await composeHarness({ persistentBash: true })
    const denyKey = {}
    const deny = createScope(hostCtx, denyKey)
    deny.ctx.tools.register(persistentBashDefinition('bash'))
    deny.ctx.tools.restrict({ deny: ['fish'] })

    const fresh = createAgentUnder(hostCtx)
    bindScopeParent(fresh.agent, denyKey)
    expect(ctx.tools.get('fish', fresh.agent)).toBeUndefined()
    expect(ctx.tools.get('bash', fresh.agent)).toBeDefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      policy.installFishPolicy(ctx, fresh.agent)
      // Identical outcome to the switched agent: no fish, bash stays, one warn.
      expect(ctx.tools.get('fish', fresh.agent)).toBeUndefined()
      expect(ctx.tools.get('bash', fresh.agent)).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('switching back from minimal to the standard preset restores the one-shot fish policy', async () => {
    // Standard preset scope: one-shot bash.
    const { ctx, hostCtx, presetKey, binding, agent } = await composeHarness()
    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(false)

    // Minimal preset: persistent bash, fish visible.
    const minimalKey = {}
    const minimal = createScope(hostCtx, minimalKey)
    minimal.ctx.tools.register(persistentBashDefinition('bash'))
    binding.rebind(minimalKey)
    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(true)

    // Deny-fish third-party preset: persistent bash + allowlist denying fish.
    const denyKey = {}
    const deny = createScope(hostCtx, denyKey)
    deny.ctx.tools.register(persistentBashDefinition('bash'))
    deny.ctx.tools.restrict({ deny: ['fish'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      binding.rebind(denyKey)
      policy.installFishPolicy(ctx, agent)
      expect(ctx.tools.get('bash', agent)).toBeDefined()
    } finally {
      warn.mockRestore()
    }

    // Back on the standard preset (one-shot bash): fish becomes one-shot
    // again and bash is hidden.
    binding.rebind(presetKey)
    policy.installFishPolicy(ctx, agent)
    expect(fishIsPersistent(ctx, agent)).toBe(false)
    expect(ctx.tools.get('fish', agent)).toBeDefined()
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
  })
})

describe('policy plugin apply()', () => {
  it('loads through the real namespace object and installs the policy for agents announced via agent/created', async () => {
    const { ctx, agent } = await composeHarness()

    await ctx.plugin(policy)

    // The dsh-agent announce path emits agent/created with the payload object.
    emit(ctx, 'agent/created', { agent })

    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
    const assembly = await assembledSections(ctx, agent)
    expect(assembly.sections.some((section) => section.text.includes('bash result'))).toBe(false)
  })

  it('reconciles preset recompose on tools/change and swaps fish tool shape both ways', async () => {
    const { ctx, hostCtx, presetKey, binding, agent } = await composeHarness()
    const minimalKey = {}
    const minimal = createScope(hostCtx, minimalKey)
    minimal.ctx.tools.register(persistentBashDefinition('bash'))
    ctx.provide('agents', { list: () => [agent] })

    await ctx.plugin(policy)
    emit(ctx, 'agent/created', { agent })
    expect(fishIsPersistent(ctx, agent)).toBe(false)

    binding.rebind(minimalKey)
    emit(ctx, 'tools/change')
    expect(fishIsPersistent(ctx, agent)).toBe(true)
    expect(catalogNames(ctx, agent)).toEqual(['fish'])

    binding.rebind(presetKey)
    emit(ctx, 'tools/change')
    expect(fishIsPersistent(ctx, agent)).toBe(false)
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
  })

  it('reconciles on tools/change and never lets a broken agent break the dispatch', async () => {
    const { ctx, agent } = await composeHarness()
    // A second agent whose ctx carries no tools/systemPrompt services at all.
    const broken = { ctx: {} }
    // The real agents registry is not mounted in this suite; provide the
    // minimal surface the reconcile path reads (agents.list()).
    ctx.provide('agents', { list: () => [agent] })

    await ctx.plugin(policy)

    // The apply-time reconcile covers agents that already exist.
    expect(ctx.tools.get('bash', agent)).toBeUndefined()

    // tools/change reconciles again (idempotent), and a broken agent must
    // not propagate out of either dispatch.
    expect(() => emit(ctx, 'tools/change')).not.toThrow()
    expect(() => emit(ctx, 'agent/created', { agent: broken })).not.toThrow()

    // The well-formed agent still got its policy through the listener.
    expect(catalogNames(ctx, agent)).toEqual(['fish'])
  })

  it('keeps tools/change dispatch bounded across many agents instead of cascading', async () => {
    const { ctx, agent, extraAgents } = await composeHarness({ extraAgents: 4 })
    const agents = [agent, ...extraAgents]
    ctx.provide('agents', { list: () => agents })

    let dispatches = 0
    ctx.on('tools/change', () => {
      dispatches += 1
    })
    await ctx.plugin(policy)

    // One external change must not fan out: every agent already has a policy
    // under the same preset parent, so reconcile fast-paths them all instead
    // of dispose/register churning each one (which used to cascade
    // factorially: 1..6 agents → 3/13/79/633/6331/75973 dispatches).
    const afterLoad = dispatches
    emit(ctx, 'tools/change')
    expect(dispatches - afterLoad).toBeLessThan(50)
    expect(dispatches).toBeLessThan(50)

    // All agents still carry the correct policy.
    for (const live of agents) {
      expect(ctx.tools.get('bash', live)).toBeUndefined()
      expect(ctx.tools.get('fish', live)).toBeDefined()
    }
  })

  it('does not reset the persistent fish tool on an unrelated tools/change within the same preset', async () => {
    const { ctx, agent } = await composeHarness({ persistentBash: true })
    ctx.provide('agents', { list: () => [agent] })
    await ctx.plugin(policy)
    emit(ctx, 'agent/created', { agent })
    const persistentFish = ctx.tools.get('fish', agent)
    expect(fishIsPersistent(ctx, agent)).toBe(true)

    emit(ctx, 'tools/change')

    // The very same definition object: the persistent registration (and its
    // PTY) was not disposed and re-registered by an unrelated change.
    expect(ctx.tools.get('fish', agent)).toBe(persistentFish)
    expect(fishIsPersistent(ctx, agent)).toBe(true)
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
  })

  it('strips every live-agent registration when the policy plugin is disposed', async () => {
    const { ctx, agent } = await composeHarness({ persistentBash: true })
    ctx.provide('agents', { list: () => [agent] })
    const plugin = await ctx.plugin(policy)
    emit(ctx, 'agent/created', { agent })
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    expect(fishIsPersistent(ctx, agent)).toBe(true)

    // Unload the policy plugin only (uninstall/disable/HMR): its teardown
    // effect must strip the bash restriction, the tool:bash shadow, and the
    // persistent fish registration from the live agent.
    await (plugin.ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose()

    expect(ctx.tools.get('bash', agent)).toBeDefined()
    expect(fishIsPersistent(ctx, agent)).toBe(false)
    expect(ctx.tools.get('fish', agent)).toBeDefined()
    const assembly = await assembledSections(ctx, agent)
    const bashSection = assembly.sections.find((section) => section.name === 'tool:bash')
    expect(bashSection?.text).toBe(BASH_GUIDANCE)
  })
})
