/**
 * Capability resolution against the composition — plan §5.1/§5.2/§10.1, §16.5.
 *
 * A child's tool surface is compiled from the child's OWN definition, resolved
 * against what the standing COMPOSITION registers. It is NOT inherited from the
 * caller's filter: `Planner → Review` (Review needs `exec`, Planner has none)
 * and `Review → Research` (Research needs `web`, Review has none) are shipped
 * edges that a caller-view resolution can never satisfy.
 *
 * The registry therefore comes from the unrestricted surface `main-runtime`
 * captures at main-agent activation. Two rejected alternatives are pinned here
 * so nobody reintroduces them:
 *
 *   - `schemas(parent)` — the caller's FROZEN filter. Fails the two edges above.
 *   - `schemas(scopeOf(ctx))` — `dsh-scope` tags scopes with the module-private
 *     symbol `Symbol("dsh.scope")` (not `Symbol.for`), so a `link:` install that
 *     resolves its own copy of that module reads the tag as `undefined` and the
 *     lookup degrades to the GLOBAL layer. Even `Banbo → Explorer` then dies
 *     with `capability "read" ... does not register`. Verified in a real
 *     dsh-tui session. Never depend on cross-package module identity here.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { loadCatalog } from '../catalog.js'
import delegationRuntime from '../delegation.js'
import { CHILD_IDENTITY_VERSION, writeChildIdentity } from '../identity.js'
import { CAPABILITY_TOOLS, compileAllowlist } from '../tool-surface.js'
import { deriveToolName } from '../schema.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtinDir = join(pluginRoot, 'catalog')

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'banbo-surface-'))
  scratch.push(root)
  return root
}

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

/** Every runtime tool name the shipped capability table can reach. */
function everyCapabilityTool(): string[] {
  const names = new Set<string>()
  for (const surface of Object.values(CAPABILITY_TOOLS)) {
    for (const group of [surface.all, surface.prefer, surface.optional]) {
      for (const name of group ?? []) names.add(name)
    }
  }
  // `exec` is platform-shaped: register every shell so the composition surface
  // is identical on every platform this suite runs on.
  names.add('fish')
  names.add('bash')
  names.add('pwsh')
  return [...names].sort()
}

const definitions = loadCatalog({ rootDir: emptyRoot(), builtinDir }).definitions

/**
 * The standing composition's surface: every capability tool PLUS the named
 * `agent_<id>` tools and `delegate_batch`, which the delegation runtime itself
 * registers in that scope (so production sees them in the same set).
 */
function compositionSurface(): Set<string> {
  const names = new Set(everyCapabilityTool())
  for (const definition of definitions.values()) names.add(deriveToolName(definition.id))
  names.add('delegate_batch')
  return names
}

/** Every shipped edge: caller id → the child ids its definition authorises. */
const edges = [...definitions.values()].flatMap((definition) =>
  definition.allowedChildren.map((childId) => ({ callerId: definition.id, childId })),
)

describe('a child capability resolves against the composition, not the caller filter', () => {
  it('ships at least the two edges that need a tool their caller lacks', () => {
    // The regression this suite exists for. Keep the premise explicit so a
    // future catalog edit cannot silently make the suite vacuous.
    const planner = definitions.get('planner')!
    const review = definitions.get('review')!
    expect(planner.main!.tools).not.toContain('exec')
    expect(review.child!.tools).toContain('exec')
    expect(review.child!.tools).not.toContain('web')
    expect(definitions.get('research')!.child!.tools).toContain('web')
    expect(planner.allowedChildren).toContain('review')
    expect(review.allowedChildren).toContain('research')
  })

  it('resolves EVERY shipped §5.1 edge from the composition snapshot', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      const host = await ctx.plugin({ name: 'surface-host', inject: ['tools'], apply() {} })
      for (const name of everyCapabilityTool()) host.ctx.tools.register(tool(name))

      const service = {
        rootDir: emptyRoot(),
        generation: 'surface-generation',
        definitions,
        personas: loadCatalog({ rootDir: emptyRoot(), builtinDir }).personas,
        // The snapshot `main-runtime` publishes before it restricts the main
        // agent. Production always has this; the fallback is for embedders that
        // do not publish it.
        compositionTools: new Map<string, Set<string>>(),
        abi: {
          agents: [...definitions.values()].map((definition) => ({
            id: definition.id,
            toolName: deriveToolName(definition.id),
            ...(definition.main === undefined ? {} : { hasMain: true, presetId: definition.main.presetId }),
            ...(definition.child === undefined ? {} : { hasChild: true }),
          })),
        },
        settings: {
          policy(agentId: string) {
            const definition = definitions.get(agentId)
            return {
              agentId,
              definition,
              exists: definition !== undefined,
              retired: false,
              effectiveEnabled: definition !== undefined,
              model: definition?.child?.model,
            }
          },
        },
      }
      const start = vi.fn(async () => ({
        id: 'child-run',
        localAgent: undefined,
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        dispose: vi.fn(async () => {}),
      }))
      host.ctx.provide('banboAgents', service)
      host.ctx.provide('subagents', { start })
      host.ctx.provide('agents', { get: () => undefined })
      host.ctx.provide('jobs', { start: vi.fn() })

      let currentPreset = 'banbo'
      host.ctx.provide('agentPresets', { composedPreset: () => currentPreset })

      // One preset standing scope per main agent, each with its own delegation
      // runtime instance — the shape the roster produces.
      const scopes = new Map<string, { key: object, ctx: Context }>()
      for (const mainId of ['banbo', 'planner']) {
        const key = { id: `preset-${mainId}` }
        const scope = createScope(host.ctx, key)
        await scope.ctx.plugin(delegationRuntime, { agentId: mainId })
        scopes.set(mainId, { key, ctx: scope.ctx })
      }

      for (const { callerId, childId } of edges) {
        const caller = definitions.get(callerId)!
        const isMain = caller.main !== undefined
        const mainId = isMain ? callerId : 'banbo'
        const composedPreset = isMain ? caller.main!.presetId : 'banbo'
        const form = isMain ? caller.main! : caller.child!
        const preset = scopes.get(mainId)!
        currentPreset = composedPreset
        service.compositionTools.set(composedPreset, compositionSurface())

        const parentId = isMain ? `root-${callerId}` : `${callerId}-session`
        // The AGENT OBJECT is the scope key in production (`createScope(ctx,
        // agent)`), and the runtime looks tools up by that exact object.
        const parentAgent = {
          id: parentId,
          options: {},
          ctx: undefined as unknown as Context,
          session: {
            header: isMain
              ? { agentPreset: composedPreset }
              : { origin: 'subagent', agentPreset: composedPreset, delegationDepth: 1 },
          },
        }
        const agent = createScope(preset.ctx, parentAgent, { parent: preset.key })
        parentAgent.ctx = agent.ctx

        // The caller's REAL frozen surface: its capabilities, plus the named
        // tools the runtime grants it for its authorised children. This is the
        // view that must NOT decide the child's capabilities.
        const allow = compileAllowlist({
          capabilities: form.tools,
          extraTools: form.extraTools ?? [],
          registered: compositionSurface(),
        })
        for (const allowed of caller.allowedChildren) allow.push(deriveToolName(allowed))
        if (isMain || caller.allowedChildren.length > 0) allow.push('delegate_batch')
        agent.ctx.tools.restrict({ allow })

        if (!isMain) {
          // A child caller resolves its identity from the durable sidecar.
          writeChildIdentity(service.rootDir, parentId, {
            version: CHILD_IDENTITY_VERSION,
            agentId: callerId,
            mainAgentId: mainId,
            presetId: composedPreset,
            rootSessionId: `root-${mainId}`,
            generation: 'surface-generation',
          })
        }

        const named = preset.ctx.tools.get(deriveToolName(childId), parentAgent)
        expect(named, `${callerId} -> ${childId}: the named tool must be visible to the caller`).toBeDefined()

        try {
          await named!.execute({ prompt: 'probe', description: 'probe' }, {
            agent: parentAgent as never,
            signal: new AbortController().signal,
          } as never)
        } catch (error) {
          throw new Error(`${callerId} -> ${childId} failed: ${String((error as Error)?.message ?? error)}`)
        }
      }

      expect(start).toHaveBeenCalledTimes(edges.length)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still fails closed when the snapshot is absent and the caller lacks the tool', async () => {
    // Without the published snapshot the runtime falls back to the caller's
    // view, which cannot satisfy `Planner → Review`. Failing loudly is the
    // documented behaviour; silently granting a smaller surface is not.
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      const host = await ctx.plugin({ name: 'fallback-host', inject: ['tools'], apply() {} })
      for (const name of everyCapabilityTool()) host.ctx.tools.register(tool(name))

      const service = {
        rootDir: emptyRoot(),
        generation: 'fallback-generation',
        definitions,
        personas: loadCatalog({ rootDir: emptyRoot(), builtinDir }).personas,
        // Deliberately NO compositionTools slot.
        abi: {
          agents: [...definitions.values()].map((definition) => ({
            id: definition.id,
            toolName: deriveToolName(definition.id),
            ...(definition.main === undefined ? {} : { hasMain: true, presetId: definition.main.presetId }),
            ...(definition.child === undefined ? {} : { hasChild: true }),
          })),
        },
        settings: {
          policy(agentId: string) {
            const definition = definitions.get(agentId)
            return {
              agentId,
              definition,
              exists: definition !== undefined,
              retired: false,
              effectiveEnabled: definition !== undefined,
              model: definition?.child?.model,
            }
          },
        },
      }
      host.ctx.provide('banboAgents', service)
      host.ctx.provide('subagents', { start: vi.fn() })
      host.ctx.provide('agents', { get: () => undefined })
      host.ctx.provide('jobs', { start: vi.fn() })
      host.ctx.provide('agentPresets', { composedPreset: () => 'planner' })

      const key = { id: 'preset-planner' }
      const scope = createScope(host.ctx, key)
      await scope.ctx.plugin(delegationRuntime, { agentId: 'planner' })

      const parentAgent = {
        id: 'root-planner',
        options: {},
        ctx: undefined as unknown as Context,
        session: { header: { agentPreset: 'planner' } },
      }
      const agent = createScope(scope.ctx, parentAgent, { parent: key })
      parentAgent.ctx = agent.ctx
      const planner = definitions.get('planner')!
      const allow = compileAllowlist({
        capabilities: planner.main!.tools,
        extraTools: [],
        registered: compositionSurface(),
      })
      for (const allowed of planner.allowedChildren) allow.push(deriveToolName(allowed))
      allow.push('delegate_batch')
      agent.ctx.tools.restrict({ allow })

      const named = scope.ctx.tools.get(deriveToolName('review'), parentAgent)
      await expect(named!.execute({ prompt: 'probe', description: 'probe' }, {
        agent: parentAgent as never,
        signal: new AbortController().signal,
      } as never)).rejects.toThrow(/capability "exec" needs one of fish, bash, pwsh/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the delegation runtime plugin still mounts with a real registry', () => {
  it('registers the shipped named tools without throwing', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      const host = await ctx.plugin({ name: 'mount-host', inject: ['tools'], apply() {} })
      // Only the capability tools: the runtime registers the named `agent_*`
      // tools and `delegate_batch` itself, and duplicates throw.
      for (const name of everyCapabilityTool()) host.ctx.tools.register(tool(name))
      host.ctx.provide('banboAgents', {
        rootDir: emptyRoot(),
        generation: 'g',
        definitions,
        personas: new Map(),
        compositionTools: new Map(),
        abi: {
          agents: [...definitions.values()].map((definition) => ({
            id: definition.id,
            toolName: deriveToolName(definition.id),
            ...(definition.main === undefined ? {} : { hasMain: true, presetId: definition.main.presetId }),
            ...(definition.child === undefined ? {} : { hasChild: true }),
          })),
        },
        settings: { policy: () => ({ exists: false, retired: false, effectiveEnabled: false, model: undefined }) },
      })
      host.ctx.provide('agentPresets', { composedPreset: () => undefined })
      host.ctx.provide('subagents', { start: vi.fn() })
      host.ctx.provide('agents', { get: () => undefined })
      host.ctx.provide('jobs', { start: vi.fn() })

      await host.ctx.plugin(delegationRuntime, { agentId: 'banbo' })
      const registered = host.ctx.tools.schemas().map((schema) => schema.name)
      expect(registered).toContain(deriveToolName('review'))
      expect(registered).toContain('delegate_batch')

      // The two OPERATIVE clauses of the model-facing contract. Real-profile
      // testing found a top model reading the old wording and expecting a
      // FOREGROUND call to an `optional` Agent to be resumable, then hitting
      // `has no supported continuation state and cannot be resumed`. Lock the
      // clauses rather than the whole sentence, so wording may still improve.
      const description = host.ctx.tools.get(deriveToolName('review'))?.description ?? ''
      expect(description, 'foreground must be stated as not resumable').toMatch(/FOREGROUND[\s\S]*never resumable/)
      expect(description, 'the foreground path is deadline-bounded').toMatch(/foreground deadline/)
      expect(description, 'background must name both terminal shapes').toMatch(/run_in_background[\s\S]*job id/)
      expect(description).toMatch(/durable child id/)
      expect(description, 'send_message needs agent-control').toMatch(/send_message when you have agent-control/)
      // A caller cannot judge "will this fit in the foreground?" without the
      // actual deadline, and a real session chose background purely to dodge a
      // deadline it could not see. The clause must carry the LIVE value.
      expect(description, 'the foreground deadline must be stated in minutes').toMatch(/FOREGROUND call waits up to \d+ minutes/)
      expect(description, 'a background child has no wait call').toMatch(/no wait call/)
      expect(description, 'shell sleep is not a way to wait').toMatch(/sleeping in a shell is not a way to wait/)

      // Batch always executes every item through the one-shot path, so its
      // description must say that a target's `continuation` does not apply
      // here. Without that clause a coordinator batches an `optional` Agent and
      // then tries to resume a child that was never created as continuable.
      const batchDescription = host.ctx.tools.get('delegate_batch')?.description ?? ''
      expect(batchDescription, 'batch must state that items run one-shot regardless of continuation')
        .toMatch(/one-shot run regardless of[\s\S]*continuation/i)
      expect(batchDescription, 'batch must point follow-up work at a single background call')
        .toMatch(/background[\s\S]*agent_<id>/i)

      // The delegation rule belongs where the model SETS the flag, not only in
      // the tool description it may skim.
      const backgroundParameter = (host.ctx.tools.get(deriveToolName('review'))?.parameters as any)
        ?.properties?.run_in_background?.description ?? ''
      expect(backgroundParameter, 'run_in_background must declare its default')
        .toMatch(/defaults to false/i)
      expect(backgroundParameter, 'run_in_background requires UNRELATED concurrent work')
        .toMatch(/UNRELATED work/i)
      expect(backgroundParameter, 'a needed result must keep the call foreground')
        .toMatch(/need this result[\s\S]*leave it false/i)

      // The definition's `guidance` — "when to use this expert, and when NOT
      // to" — must reach the model. It was validated and stored but rendered
      // NOWHERE, so a coordinator had only the tool NAME to guess from and
      // reviewed work itself instead of calling `agent_review`.
      for (const definition of definitions.values()) {
        // `guidance` belongs to the CHILD form — the named tool always delegates
        // to a child, so that is the sentence a caller needs.
        const guidance = definition.child?.guidance
        const text = host.ctx.tools.get(deriveToolName(definition.id))?.description ?? ''
        if (typeof guidance === 'string' && guidance !== '') {
          expect(text, `${definition.id}: its guidance must be in the tool description`).toContain(guidance)
        }
      }
      expect(host.ctx.tools.get(deriveToolName('review'))?.description).toContain('"review"')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
