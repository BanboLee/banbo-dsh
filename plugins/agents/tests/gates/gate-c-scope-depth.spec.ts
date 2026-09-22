/** Gate C — official scoped tools, child composition, and depth probes. */

import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  SubagentDepthError,
  applyChildComposition,
  delegationDepthOf,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} probe`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async () => ({}),
  }
}

async function scopedTools() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const host = await ctx.plugin({ name: 'gate-c-host', inject: ['tools', 'systemPrompt'], apply() {} })
  host.ctx.tools.register(tool('global_a'))
  host.ctx.tools.register(tool('global_b'))
  const parentKey = { id: 'parent' }
  const parent = createScope(host.ctx, parentKey)
  const childKey = { id: 'child' }
  // The chain is EXPLICIT: `createScope` does not infer parenthood from the
  // minting context, so without `parent` the child would inherit nothing from
  // the ancestor layer and this suite would only ever exercise the global one.
  const child = createScope(parent.ctx, childKey, { parent: parentKey })
  return { ctx, host, parent, parentKey, child, childKey }
}

describe('C1 — restrictions filter inherited tools, not own registrations', () => {
  it('keeps a child-owned tool visible while filtering global and ancestor rows', async () => {
    const fixture = await scopedTools()
    try {
      fixture.parent.ctx.tools.register(tool('ancestor_tool'))
      fixture.child.ctx.tools.register(tool('child_output'))

      // Proof the ancestor layer is genuinely inherited before any restriction:
      // this is what makes the filtered assertion below about ANCESTOR rows and
      // not merely about globals.
      expect(fixture.child.ctx.tools.schemas(fixture.childKey).map(({ name }) => name).sort())
        .toEqual(['ancestor_tool', 'child_output', 'global_a', 'global_b'])

      fixture.child.ctx.tools.restrict({ allow: ['global_a'] })

      expect(fixture.child.ctx.tools.schemas(fixture.childKey).map(({ name }) => name).sort())
        .toEqual(['child_output', 'global_a'])
      expect(fixture.parent.ctx.tools.schemas(fixture.parentKey).map(({ name }) => name).sort())
        .toEqual(['ancestor_tool', 'global_a', 'global_b'])
    } finally {
      await fixture.ctx.fiber.dispose()
    }
  })

  it('fails on a missing frozen name but accepts the same name while a shell is registered', async () => {
    const fixture = await scopedTools()
    try {
      expect(() => fixture.child.ctx.tools.restrict({ allow: ['retired_delegate'] }))
        .toThrow(/unknown global tool/i)
      fixture.host.ctx.tools.register(tool('retired_delegate'))
      expect(() => fixture.child.ctx.tools.restrict({ allow: ['retired_delegate'] })).not.toThrow()
      expect(fixture.child.ctx.tools.schemas(fixture.childKey).map(({ name }) => name))
        .toEqual(['retired_delegate'])
    } finally {
      await fixture.ctx.fiber.dispose()
    }
  })
})

describe('C2 — applyChildComposition is synchronous and complete', () => {
  it('joins first, then installs context, persona, and tool restriction before return', () => {
    const calls: string[] = []
    const parent = { ctx: { parent: true } }
    const childCtx = {
      get(name: string) {
        expect(name).toBe('agentPresets')
        return {
          composeFrom(actualChild: unknown, actualParent: unknown) {
            expect(actualChild).toBe(childCtx)
            expect(actualParent).toBe(parent.ctx)
            calls.push('composeFrom')
            return 'parent-preset'
          },
        }
      },
      systemPrompt: {
        getContextOrder(name: string) {
          expect(name).toBe('SUBAGENT_DELEGATION')
          return 10
        },
        context(value: { name: string, order: number, text: string }) {
          expect(value).toMatchObject({ name: 'subagent:delegation', order: 10 })
          expect(value.text.length).toBeGreaterThan(0)
          expect(value.text).toMatch(/delegat|subagent|child/i)
          calls.push('context')
        },
        getSectionOrder(name: string) {
          expect(name).toBe('DEPLOYMENT_PERSONA_PREFIX')
          return 20
        },
        section(value: { name: string, order: number, text: string }) {
          expect(value).toEqual({ name: 'deployment:persona-prefix', order: 20, text: '# Child persona' })
          calls.push('persona')
        },
      },
      tools: {
        restrict(value: unknown) {
          expect(value).toEqual({ allow: ['global_a'] })
          calls.push('restrict')
        },
      },
    }

    const result = applyChildComposition(childCtx as never, parent as never, {
      persona: '# Child persona', toolFilter: { allow: ['global_a'] },
    })
    expect(result).toBeUndefined()
    expect(calls).toEqual(['composeFrom', 'context', 'persona', 'restrict'])
  })
})

describe('C3 — resumed depth uses the durable monotone floor', () => {
  function agent(headerDepth: number | undefined, runtimeDepth?: number) {
    return {
      options: runtimeDepth === undefined ? {} : { subagentDepth: runtimeDepth },
      session: { header: headerDepth === undefined ? {} : { delegationDepth: headerDepth } },
    }
  }

  it('does not reset after a cold reconstruction and throws the public typed cap error', () => {
    const cold = agent(3)
    expect(delegationDepthOf(cold as never)).toBe(3)
    expect(resolveChildDepth(cold as never, 4)).toBe(4)
    expect(() => resolveChildDepth(cold as never, 3)).toThrow(SubagentDepthError)
    try {
      resolveChildDepth(cold as never, 3)
    } catch (error) {
      expect(error).toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 4, maxDepth: 3 })
    }
  })

  it('takes the greater persisted/runtime value instead of lowering depth', () => {
    expect(delegationDepthOf(agent(2, 5) as never)).toBe(5)
    expect(delegationDepthOf(agent(5, 2) as never)).toBe(5)
  })
})
