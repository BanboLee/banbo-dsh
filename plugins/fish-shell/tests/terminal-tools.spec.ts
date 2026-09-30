/**
 * Deterministic unit tests for the L2 `terminalTools` policy
 * (`terminal-tools.js`, fish-shell-tty-v3 F15 / D6 §7.1-7.2).
 *
 * The policy is the only entry this bundle adds for the interactive terminal
 * surface: `allow` (the default) must register nothing at all, while `deny`
 * must restrict EXACTLY the six explicitly enumerated `terminal_*` names —
 * never a `terminal_*` pattern — for every live agent, retry once the tools
 * are actually registered (the official `tools.restrict` rejects unknown
 * names), and lift every restriction on agent disposal and plugin teardown.
 *
 * Most cases drive `apply` through a scripted fake context so every
 * `restrict` call is observable verbatim; the last case mounts the real
 * `ToolRuntime` and the real `Context` to prove the same behavior on the
 * actual registry (including the unknown-name rejection and its retry).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as terminalTools from '../terminal-tools.js'

/** Spelled out here (not imported from the module) so this suite is an
 * independent contract on the enumeration, and the order is pinned. */
const SIX_TERMINAL_TOOLS = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
]

type PluginCtx = Parameters<typeof terminalTools.apply>[0]
type RestrictSpy = ReturnType<typeof vi.fn>

interface FakeAgent {
  id: string
  ctx: { tools: { restrict: RestrictSpy } }
}

interface FakeAgentHarness {
  agent: FakeAgent
  /** The agent-scoped `tools.restrict` spy (its `mock.calls` carry the filter). */
  restrict: RestrictSpy
  /** How many times the disposer returned by a successful restrict ran. */
  lifts(): number
}

/**
 * One agent as the policy sees it. `fail: 'first'` models the real
 * `tools.restrict` rejecting names that are not registered yet; `'always'`
 * keeps failing so the warn-once behavior can be observed. `onRestrict` /
 * `onLift` model the real registry's synchronous `tools/change`: it fires both
 * when a restriction is installed and when one is lifted.
 */
function fakeAgent(
  id: string,
  options: { fail?: 'first' | 'always', onRestrict?: () => void, onLift?: () => void } = {},
): FakeAgentHarness {
  const state = { calls: 0, lifts: 0 }
  const restrict = vi.fn(() => {
    state.calls += 1
    if (options.fail === 'always' || (options.fail === 'first' && state.calls === 1)) {
      throw new Error('tools.restrict() names unknown global tools "terminal_open", …')
    }
    options.onRestrict?.()
    return () => {
      state.lifts += 1
      options.onLift?.()
    }
  })
  return { agent: { id, ctx: { tools: { restrict } } }, restrict, lifts: () => state.lifts }
}

interface FakeCtxHarness {
  ctx: PluginCtx
  /** Dispatch one event to the listeners the plugin registered. */
  emit(event: string, payload?: unknown): void
  /** Run the disposer the plugin registered through `ctx.effect(...)` (the
   * plugin's own teardown). */
  teardown(): void
  /** The events the plugin subscribed to (empty for `allow`). */
  listeners: Map<string, Array<(payload?: unknown) => void>>
  /** The effect factories the plugin registered (empty for `allow`). */
  effects: Array<() => void>
}

/**
 * A scripted stand-in for the plugin context: only the members
 * `terminal-tools.js` reads. `agents` is captured by reference, so
 * `providedAgents.push(...)` adds an agent to the live list.
 */
function fakeCtx(providedAgents: FakeAgent[]): FakeCtxHarness {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>()
  const effects: Array<() => void> = []
  const ctx = {
    on(event: string, listener: (payload?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    effect(factory: () => () => void) {
      effects.push(factory())
      return () => {}
    },
    get(service: string) {
      return service === 'agents' ? { list: () => providedAgents } : undefined
    },
    tools: { restrict: vi.fn() },
  } as unknown as PluginCtx
  return {
    ctx,
    listeners,
    effects,
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
    },
    teardown() {
      for (const dispose of [...effects].reverse()) dispose()
    },
  }
}

describe('terminalTools policy (fake context)', () => {
  it('registers nothing and restricts nobody with the default allow', () => {
    const first = fakeAgent('a')
    const second = fakeAgent('b')
    for (const config of [undefined, { terminalTools: 'allow' } as const]) {
      const harness = fakeCtx([first.agent, second.agent])
      expect(() => terminalTools.apply(harness.ctx, config)).not.toThrow()
      // Returning before the first listener: zero runtime footprint.
      expect(harness.listeners.size).toBe(0)
      expect(harness.effects).toHaveLength(0)
    }
    expect(first.restrict).not.toHaveBeenCalled()
    expect(second.restrict).not.toHaveBeenCalled()
  })

  it('denies exactly the six explicit names, in order, for every live agent', () => {
    // The exported enumeration is the policy's single source of names.
    expect([...terminalTools.TERMINAL_TOOL_NAMES]).toEqual(SIX_TERMINAL_TOOLS)

    const first = fakeAgent('a')
    const second = fakeAgent('b')
    terminalTools.apply(fakeCtx([first.agent, second.agent]).ctx, { terminalTools: 'deny' })

    const expected = [[{ deny: SIX_TERMINAL_TOOLS }]]
    expect(first.restrict.mock.calls).toEqual(expected)
    expect(second.restrict.mock.calls).toEqual(expected)
  })

  it('restricts an agent announced later once, absorbing restrict’s own tools/change re-entry', () => {
    const live: FakeAgent[] = []
    const harness = fakeCtx(live)
    // tools.restrict synchronously fires tools/change; the guard must absorb
    // that nested dispatch instead of restricting the same agent twice.
    const agent = fakeAgent('a', { onRestrict: () => harness.emit('tools/change') })
    terminalTools.apply(harness.ctx, { terminalTools: 'deny' })
    live.push(agent.agent)

    harness.emit('agent/created', { agent: agent.agent })
    expect(agent.restrict).toHaveBeenCalledTimes(1)

    // Already restricted: any later change is a no-op for this agent.
    harness.emit('tools/change')
    harness.emit('tools/change')
    expect(agent.restrict).toHaveBeenCalledTimes(1)
    expect(agent.lifts()).toBe(0)
  })

  it('warns once, keeps running, and retries successfully on tools/change when the tools are unknown yet', () => {
    const live: FakeAgent[] = []
    const harness = fakeCtx(live)
    const agent = fakeAgent('a', { fail: 'first' })
    live.push(agent.agent)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The first attempt throws (the tools are not registered in this
      // profile): the policy must not leak the throw.
      expect(() => terminalTools.apply(harness.ctx, { terminalTools: 'deny' })).not.toThrow()
      expect(agent.restrict).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)

      // The registry announces every registration through tools/change.
      harness.emit('tools/change')
      expect(agent.restrict).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(1)

      // The retry succeeded, so further changes stop calling restrict.
      harness.emit('tools/change')
      expect(agent.restrict).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('warns once per agent and never throws when the tools never appear', () => {
    const live: FakeAgent[] = []
    const harness = fakeCtx(live)
    const agent = fakeAgent('a', { fail: 'always' })
    live.push(agent.agent)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => terminalTools.apply(harness.ctx, { terminalTools: 'deny' })).not.toThrow()
      expect(() => {
        harness.emit('tools/change')
        harness.emit('tools/change')
      }).not.toThrow()
      // Every round retries, but the agent is warned exactly once.
      expect(agent.restrict).toHaveBeenCalledTimes(3)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('lifts one agent’s restriction on agent/disposed and never resurrects it', () => {
    const live: FakeAgent[] = []
    const harness = fakeCtx(live)
    const disposed = fakeAgent('a')
    const surviving = fakeAgent('b')
    live.push(disposed.agent, surviving.agent)

    terminalTools.apply(harness.ctx, { terminalTools: 'deny' })
    expect(disposed.restrict).toHaveBeenCalledTimes(1)
    expect(disposed.lifts()).toBe(0)

    harness.emit('agent/disposed', { agent: disposed.agent })
    expect(disposed.lifts()).toBe(1)
    expect(surviving.lifts()).toBe(0)

    // A change fired while the agent is dying must not re-restrict it.
    harness.emit('tools/change')
    expect(disposed.restrict).toHaveBeenCalledTimes(1)
    expect(disposed.lifts()).toBe(1)
  })

  it('lifts every live restriction on plugin teardown and stays inert afterwards', () => {
    const live: FakeAgent[] = []
    const harness = fakeCtx(live)
    const first = fakeAgent('a')
    const second = fakeAgent('b')
    live.push(first.agent, second.agent)

    terminalTools.apply(harness.ctx, { terminalTools: 'deny' })
    harness.teardown()
    expect(first.lifts()).toBe(1)
    expect(second.lifts()).toBe(1)

    // The listeners are still attached in this scripted context; the disposed
    // guard must keep them from re-installing anything.
    const late = fakeAgent('c')
    harness.emit('tools/change')
    harness.emit('agent/created', { agent: late.agent })
    expect(first.restrict).toHaveBeenCalledTimes(1)
    expect(second.restrict).toHaveBeenCalledTimes(1)
    expect(late.restrict).not.toHaveBeenCalled()
  })

  it('keeps two deny mounts on one context independent across an interleaved teardown', () => {
    const live: FakeAgent[] = []
    const harness = fakeCtx(live)
    // Lifting a restriction synchronously fires tools/change (the real
    // registry does too), so the FIRST mount's teardown wakes the second
    // mount's listener while the first mount is still being torn down.
    const agent = fakeAgent('a', { onLift: () => harness.emit('tools/change') })
    live.push(agent.agent)
    /** Net restrictions still installed by the two mounts. */
    const active = () => agent.restrict.mock.calls.length - agent.lifts()

    // Two mounts of this module share one context (two bundle rows, two
    // profiles in one process): each mount owns one restriction, and neither
    // dedupes into the other's state — that sharing is what used to orphan the
    // second mount's restriction when the first one was torn down.
    terminalTools.apply(harness.ctx, { terminalTools: 'deny' })
    terminalTools.apply(harness.ctx, { terminalTools: 'deny' })
    expect(harness.effects).toHaveLength(2)
    expect(agent.restrict).toHaveBeenCalledTimes(2)
    expect(active()).toBe(2)

    // First mount down: exactly its own disposer runs, the second mount (still
    // mounted, and re-driven by the tools/change above) keeps its own.
    harness.effects[0]!()
    expect(agent.lifts()).toBe(1)
    expect(agent.restrict).toHaveBeenCalledTimes(2)
    expect(active()).toBe(1)

    // Second mount down: its OWN disposer runs as well — no restriction
    // outlives the mount that installed it. (Under shared module state the
    // first teardown cleared the second mount's agent set, so this stayed 1.)
    harness.effects[1]!()
    expect(agent.lifts()).toBe(2)
    expect(active()).toBe(0)

    // Nothing can resurrect a restriction once both mounts are gone.
    harness.emit('tools/change')
    harness.emit('agent/created', { agent: agent.agent })
    expect(agent.restrict).toHaveBeenCalledTimes(2)
    expect(agent.lifts()).toBe(2)
    expect(active()).toBe(0)
  })
})

function toolDefinition(name: string): {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>, render: () => Array<{ type: 'text', text: string }> }
  execute: () => Promise<unknown>
} {
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

function catalogNames(ctx: Context, scope: object): string[] {
  return ctx.tools.schemas(scope).map(schema => schema.name)
}

describe('terminalTools policy on the real tool registry', () => {
  it('takes the six tools away from a live agent, retries once they register, and restores them on teardown', async () => {
    const ctx = new Context()
    // ToolRuntime injects systemPrompt, so the prompt service must be mounted
    // first (the same composition as tests/policy.spec.ts).
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    const host = await ctx.plugin({ name: 'terminal-tools-spec-host', inject: ['tools'], apply() {} })
    // The agent object IS its scope key, exactly like dsh-agent-loop: composed
    // under a preset standing scope and carrying the scoped context the policy
    // restricts.
    const presetKey = {}
    createScope(host.ctx, presetKey)
    const agent = {} as { ctx: Context }
    agent.ctx = createScope(host.ctx, agent).ctx
    bindScopeParent(agent, presetKey)
    ctx.provide('agents', { list: () => [agent] })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Nothing is registered yet: the real restrict() rejects the six unknown
      // names, so mounting must warn and keep the profile alive.
      const plugin = await ctx.plugin(terminalTools, { terminalTools: 'deny' })
      expect(warn).toHaveBeenCalledTimes(1)

      // Registering fires tools/change synchronously: the retry succeeds and
      // the agent's catalog loses all six tools.
      for (const name of SIX_TERMINAL_TOOLS) ctx.tools.register(toolDefinition(name))
      expect(catalogNames(ctx, agent)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)

      // Unloading the policy (uninstall/disable/HMR) lifts the restriction.
      await (plugin.ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose()
      expect(catalogNames(ctx, agent).sort()).toEqual([...SIX_TERMINAL_TOOLS].sort())
    } finally {
      warn.mockRestore()
    }
  })
})
