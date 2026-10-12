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
import { goldensWritable, replaceGoldenRegion, specSource, updateGoldens } from './golden-writer.js'

/**
 * The COMPLETE model-visible schema of every shipped named tool: the whole tool
 * `description` plus EVERY parameter description, one entry per target.
 *
 * A per-target golden is the point: the guidance sentence differs per agent, and
 * two controlled experiments walked past the previous, narrower gate — appending
 * "but it may wait up to 30 minutes and return the result in this turn" to a kept
 * target's `run_in_background` parameter description (which kept the positive
 * phrase the local regex looked for), and appending "A foreground invocation
 * waits until this kept child answers in the same turn." to ANOTHER target's
 * guidance in `catalog/executor.yaml` (only the guidance-containing assertion
 * covered it, and containment is not equality). Pinning the whole schema closes
 * both.
 *
 * The only normalization is the live deadline number (`up to 30 minutes` →
 * `up to N minutes`); the `FOREGROUND call waits up to \d+ minutes` assertion
 * still proves that live value is rendered where it applies.
 *
 * Cost, stated plainly: any wording change to a named-tool clause or a target's
 * guidance REQUIRES regenerating this block in the same commit:
 *
 *   env NODE_ENV=development pnpm run test:agents:update-goldens
 *
 * See §14.1 item 17 and §16.16.
 */
type NamedToolSchema = {
  description: string
  /**
   * The WHOLE `parameters` JSON Schema of the tool, recursively key-sorted: the
   * surface is the contract, including the TOP-LEVEL `required` array (the
   * per-property `required` flag does not exist) and any `const` / `enum` /
   * `default` / `examples` / `title` the runtime adds.
   */
  parameters: Record<string, unknown>
}

// TOOL-SCHEMA-GOLDEN-BEGIN (generated: the full model-visible schema per shipped named tool)
const NAMED_TOOL_SCHEMAS_GOLDEN: Record<string, NamedToolSchema> = {
  "agent_executor": {
    "description": "Delegate one bounded task to the \"executor\" Agent. 当任务需要实际运行命令或做小范围机械改动时使用；不要使用它承担需要设计判断的实现。 Before creating a child of the same role, check for one first: a same-role child may be IDLE, may still be RUNNING, or may not exist at all, so call list_agents before you create. IDLE and reusable: reuse it with send_message, unless you can state one of the documented exceptions (an unrelated task; a context too long or polluted; needing a fresh, isolated child that does not carry the previous context; a previous turn that produced no conclusion). RUNNING and the new work belongs to the SAME workstream — the same piece of work, the same MR, the same module, or a continuation of the previous turn: do NOT create — fold the new work into that same task and append it with ONE send_message once its wake-up or settlement message arrives. RUNNING and the new work is UNRELATED to it: creating a new child is allowed, but you must still state which exception applies. NO same-role child exists: create. Whenever a same-role child already exists — idle or running — and you still create one, say which exception you are using and why. This Agent is ALWAYS KEPT: call it with run_in_background: true, because its work is meant to be followed up and a foreground call is refused. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — because this Agent is ALWAYS KEPT, run it in the background and end your turn: answer from its message or settlement notice when it wakes you.",
    "parameters": {
      "properties": {
        "description": {
          "description": "Short human-readable task label.",
          "type": "string"
        },
        "prompt": {
          "description": "Complete task instructions for the child Agent.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; \"I will also do this task myself\" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message. Exception — this Agent is ALWAYS KEPT: a foreground call is refused with background-required, so run_in_background must be true even when you need the result; end your turn and answer from the child's message or its settlement notice when it arrives.",
          "type": "boolean"
        }
      },
      "required": [
        "prompt",
        "description"
      ],
      "type": "object"
    }
  },
  "agent_explorer": {
    "description": "Delegate one bounded task to the \"explorer\" Agent. 当任务需要快速摸清本地代码结构或定位实现位置时使用；不要使用它运行命令或修改文件。 A FOREGROUND call waits up to N minutes for the child to settle — or for the foreground deadline, after which it returns a cancel_requested or cleanup_deferred status — and is never resumable afterwards: the child ends with the call. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — if you need the result now, stay in the foreground.",
    "parameters": {
      "properties": {
        "description": {
          "description": "Short human-readable task label.",
          "type": "string"
        },
        "prompt": {
          "description": "Complete task instructions for the child Agent.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; \"I will also do this task myself\" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message.",
          "type": "boolean"
        }
      },
      "required": [
        "prompt",
        "description"
      ],
      "type": "object"
    }
  },
  "agent_implement": {
    "description": "Delegate one bounded task to the \"implement\" Agent. 当任务需要按明确范围修改代码时使用；不要使用它顺手重构无关范围。 Before creating a child of the same role, check for one first: a same-role child may be IDLE, may still be RUNNING, or may not exist at all, so call list_agents before you create. IDLE and reusable: reuse it with send_message, unless you can state one of the documented exceptions (an unrelated task; a context too long or polluted; needing a fresh, isolated child that does not carry the previous context; a previous turn that produced no conclusion). RUNNING and the new work belongs to the SAME workstream — the same piece of work, the same MR, the same module, or a continuation of the previous turn: do NOT create — fold the new work into that same task and append it with ONE send_message once its wake-up or settlement message arrives. RUNNING and the new work is UNRELATED to it: creating a new child is allowed, but you must still state which exception applies. NO same-role child exists: create. Whenever a same-role child already exists — idle or running — and you still create one, say which exception you are using and why. This Agent is ALWAYS KEPT: call it with run_in_background: true, because its work is meant to be followed up and a foreground call is refused. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — because this Agent is ALWAYS KEPT, run it in the background and end your turn: answer from its message or settlement notice when it wakes you.",
    "parameters": {
      "properties": {
        "description": {
          "description": "Short human-readable task label.",
          "type": "string"
        },
        "prompt": {
          "description": "Complete task instructions for the child Agent.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; \"I will also do this task myself\" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message. Exception — this Agent is ALWAYS KEPT: a foreground call is refused with background-required, so run_in_background must be true even when you need the result; end your turn and answer from the child's message or its settlement notice when it arrives.",
          "type": "boolean"
        }
      },
      "required": [
        "prompt",
        "description"
      ],
      "type": "object"
    }
  },
  "agent_planner": {
    "description": "Delegate one bounded task to the \"planner\" Agent. 当任务需要先拆解成计划、或需要持续协调一个子项目时使用；不要使用它直接做大规模代码修改。 Before creating a child of the same role, check for one first: a same-role child may be IDLE, may still be RUNNING, or may not exist at all, so call list_agents before you create. IDLE and reusable: reuse it with send_message, unless you can state one of the documented exceptions (an unrelated task; a context too long or polluted; needing a fresh, isolated child that does not carry the previous context; a previous turn that produced no conclusion). RUNNING and the new work belongs to the SAME workstream — the same piece of work, the same MR, the same module, or a continuation of the previous turn: do NOT create — fold the new work into that same task and append it with ONE send_message once its wake-up or settlement message arrives. RUNNING and the new work is UNRELATED to it: creating a new child is allowed, but you must still state which exception applies. NO same-role child exists: create. Whenever a same-role child already exists — idle or running — and you still create one, say which exception you are using and why. This Agent is ALWAYS KEPT: call it with run_in_background: true, because its work is meant to be followed up and a foreground call is refused. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — because this Agent is ALWAYS KEPT, run it in the background and end your turn: answer from its message or settlement notice when it wakes you.",
    "parameters": {
      "properties": {
        "description": {
          "description": "Short human-readable task label.",
          "type": "string"
        },
        "prompt": {
          "description": "Complete task instructions for the child Agent.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; \"I will also do this task myself\" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message. Exception — this Agent is ALWAYS KEPT: a foreground call is refused with background-required, so run_in_background must be true even when you need the result; end your turn and answer from the child's message or its settlement notice when it arrives.",
          "type": "boolean"
        }
      },
      "required": [
        "prompt",
        "description"
      ],
      "type": "object"
    }
  },
  "agent_research": {
    "description": "Delegate one bounded task to the \"research\" Agent. 当任务需要检索和归纳外部或资料性信息、且不需要修改代码时使用；不要使用它修改或执行本地代码。 A FOREGROUND call waits up to N minutes for the child to settle — or for the foreground deadline, after which it returns a cancel_requested or cleanup_deferred status — and is never resumable afterwards: the child ends with the call. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — if you need the result now, stay in the foreground.",
    "parameters": {
      "properties": {
        "description": {
          "description": "Short human-readable task label.",
          "type": "string"
        },
        "prompt": {
          "description": "Complete task instructions for the child Agent.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; \"I will also do this task myself\" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message.",
          "type": "boolean"
        }
      },
      "required": [
        "prompt",
        "description"
      ],
      "type": "object"
    }
  },
  "agent_review": {
    "description": "Delegate one bounded task to the \"review\" Agent. 当任务需要独立审查一段改动、结论或方案时使用；不要使用它代替负责修改的 Implement。 Before creating a child of the same role, check for one first: a same-role child may be IDLE, may still be RUNNING, or may not exist at all, so call list_agents before you create. IDLE and reusable: reuse it with send_message, unless you can state one of the documented exceptions (an unrelated task; a context too long or polluted; needing a fresh, isolated child that does not carry the previous context; a previous turn that produced no conclusion). RUNNING and the new work belongs to the SAME workstream — the same piece of work, the same MR, the same module, or a continuation of the previous turn: do NOT create — fold the new work into that same task and append it with ONE send_message once its wake-up or settlement message arrives. RUNNING and the new work is UNRELATED to it: creating a new child is allowed, but you must still state which exception applies. NO same-role child exists: create. Whenever a same-role child already exists — idle or running — and you still create one, say which exception you are using and why. This Agent is ALWAYS KEPT: call it with run_in_background: true, because its work is meant to be followed up and a foreground call is refused. Set run_in_background to true to keep it: a one-shot Agent then returns a job id, and an Agent whose continuation is optional returns a durable child id (reachable with send_message when you have agent-control). A background child's outcome arrives later as a notice; there is no wait call, and sleeping in a shell is not a way to wait — because this Agent is ALWAYS KEPT, run it in the background and end your turn: answer from its message or settlement notice when it wakes you.",
    "parameters": {
      "properties": {
        "description": {
          "description": "Short human-readable task label.",
          "type": "string"
        },
        "prompt": {
          "description": "Complete task instructions for the child Agent.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Run in the background. Defaults to false. Set true ONLY when you have other, UNRELATED work to do while this child runs; \"I will also do this task myself\" is NOT a reason. If you need this result to answer the user, leave it false: a background child ends your turn without a result, and an optional Agent then returns a durable child id you can reach with send_message. Exception — this Agent is ALWAYS KEPT: a foreground call is refused with background-required, so run_in_background must be true even when you need the result; end your turn and answer from the child's message or its settlement notice when it arrives.",
          "type": "boolean"
        }
      },
      "required": [
        "prompt",
        "description"
      ],
      "type": "object"
    }
  }
}
// TOOL-SCHEMA-GOLDEN-END

/** Sentinel markers of the generated schema body; each must own its whole line. */
const TOOL_SCHEMA_GOLDEN_BEGIN = '// TOOL-SCHEMA-GOLDEN-BEGIN (generated: the full model-visible schema per shipped named tool)'
const TOOL_SCHEMA_GOLDEN_END = '// TOOL-SCHEMA-GOLDEN-END'

/**
 * The source the writer would produce for these schemas (pure).
 *
 * Regenerate with `env NODE_ENV=development pnpm run test:agents:update-goldens`;
 * a strict run only reads, and asserts that what is on disk is already exactly
 * this — so re-running the writer with no source change is a zero diff.
 */
function toolSchemaSource(source: string, schemas: Record<string, NamedToolSchema>): string {
  const body = `const NAMED_TOOL_SCHEMAS_GOLDEN: Record<string, NamedToolSchema> = ${JSON.stringify(schemas, null, 2)}`
  return replaceGoldenRegion(source, TOOL_SCHEMA_GOLDEN_BEGIN, TOOL_SCHEMA_GOLDEN_END, body)
}

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
      // §16.14: `review`, `implement` and `planner` declare `preferBackground`,
      // so the edges that target them run through the continuable path. The test
      // still has to exercise their capability resolution — refusing them would
      // prove the policy but not the resolution it exists to protect.
      const startContinuable = vi.fn(async (spec: { childId: string }) => ({
        childId: spec.childId,
        messageId: 'message-1',
      }))
      host.ctx.provide('banboAgents', service)
      host.ctx.provide('subagents', { start, startContinuable })
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

      let keptEdges = 0
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

        // A `preferBackground` target refuses the foreground outright, so the
        // edge is exercised the way production must call it.
        const keep = definitions.get(childId)!.child?.preferBackground === true
        if (keep) keptEdges += 1
        let started: unknown
        try {
          started = await named!.execute({ prompt: 'probe', description: 'probe', ...(keep ? { run_in_background: true } : {}) }, {
            agent: parentAgent as never,
            signal: new AbortController().signal,
          } as never)
        } catch (error) {
          throw new Error(`${callerId} -> ${childId} failed: ${String((error as Error)?.message ?? error)}`)
        }
        // A continuable child holds its concurrency slot until its `subagent/end`
        // arrives — real behaviour, and this test never produces one. Emit the
        // real event rather than reaching into the lease map, so the release path
        // under test is the production one.
        const keptChildId = (started as { childId?: string } | undefined)?.childId
        if (keep && keptChildId !== undefined) {
          preset.ctx.emit('subagent/end', { id: keptChildId, stopReason: 'completed' } as never)
        }
      }

      // One-shot edges reach `start`; the kept ones reach `startContinuable`.
      expect(start).toHaveBeenCalledTimes(edges.length - keptEdges)
      expect(startContinuable).toHaveBeenCalledTimes(keptEdges)
      expect(keptEdges, 'the shipped team must declare at least one always-kept Agent').toBeGreaterThan(0)
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
      // An Agent that is NOT kept is the one that keeps the foreground narration.
      const freeDescription = host.ctx.tools.get(deriveToolName('explorer'))?.description ?? ''
      // §16.16 — the WHOLE description is a golden, for both shapes. Four
      // negative regexes only refused four spellings: a controlled experiment
      // injected "A foreground invocation waits until the child answers.",
      // "A foreground invocation can return the result in this turn." and
      // "A foreground invocation has a deadline." into the kept description and
      // all three passed. A golden cannot be reworded around.
      //
      // Two halves, both needed: the golden pins the WORDING (with the live number
      // normalized to `N`, so a fixture budget change does not churn it), and the
      // exact-value assertion below pins the NUMBER against the live budget —
      // normalizing alone hid a `Math.round(...) + 7` that told the model 37
      // minutes while the budget stayed 30.
      const normalized = (value: string): string => value.replace(/up to \d+ minutes/, 'up to N minutes')
      // Deterministic serialization: object keys are sorted at every depth; array
      // order is kept (reordering `required` IS a change). The only rewriting of a
      // string is the live-deadline normalization, applied deeply so a number that
      // moves into a parameter description later cannot churn the baseline.
      const normalizeDeep = (value: unknown): unknown => {
        if (typeof value === 'string') return normalized(value)
        if (Array.isArray(value)) return value.map(normalizeDeep)
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeDeep(entry)]))
        }
        return value
      }
      const sortedDeep = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(sortedDeep)
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, sortedDeep(entry)]),
          )
        }
        return value
      }
      // Every shipped named tool, WHOLE schema: the tool description plus the
      // ENTIRE `parameters` JSON Schema — not a projection onto a hand-picked key
      // list. Projecting was bypassed twice: the per-property `required` flag does
      // not exist (the runtime puts `required` in the TOP-LEVEL array, so the
      // baseline recorded every parameter as optional and deleting `required: true`
      // from `prompt` changed nothing), and a `const: true` added to
      // `run_in_background` — a schema-level contradiction with the description —
      // was invisible. Whatever key the schema uses (`type`, `const`, `enum`,
      // `default`, `examples`, `title`, …) is now inside the baseline.
      const mainBudgetMs = definitions.get('banbo')?.main?.budget?.foregroundDeadlineMs
      expect(typeof mainBudgetMs, 'the fixture main must declare its foreground deadline').toBe('number')
      const expectedMinutes = Math.round(mainBudgetMs! / 60_000)
      let renderedDeadlines = 0
      const schemas = Object.fromEntries(
        [...definitions.values()]
          .filter((definition) => definition.child !== undefined)
          .map((definition) => {
            const toolName = deriveToolName(definition.id)
            const tool = host.ctx.tools.get(toolName)
            expect(tool, `${definition.id} must register its named tool`).toBeDefined()
            const description = tool!.description ?? ''
            // The live deadline must be the REAL number, checked on the raw text
            // before any normalization, for every target that renders it.
            if (description.includes('A FOREGROUND call waits')) {
              expect(description, `${toolName} must render the LIVE foreground deadline (${expectedMinutes} minutes)`)
                .toContain(`up to ${expectedMinutes} minutes`)
              renderedDeadlines += 1
            }
            return [toolName, {
              description: normalized(description),
              parameters: sortedDeep(normalizeDeep(tool!.parameters ?? {})),
            }]
          })
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ) as Record<string, NamedToolSchema>
      expect(Object.keys(schemas).length, 'every shipped named tool must be in the schema baseline').toBe(6)
      expect(renderedDeadlines, 'at least one foreground-capable target must render the live deadline').toBeGreaterThan(0)
      // The parameter KEY SET is part of the contract: added, removed or renamed
      // parameters must fail here even before the baseline comparison.
      for (const [toolName, schema] of Object.entries(schemas)) {
        const properties = (schema.parameters.properties ?? {}) as Record<string, unknown>
        expect(Object.keys(properties).sort(), `${toolName} must expose exactly the documented parameters`)
          .toEqual(['description', 'prompt', 'run_in_background'])
      }
      // Same opt-in contract as the D12 goldens: a strict run only reads, and
      // proves the block on disk is already exactly what the writer emits — the
      // automated zero-diff check for this baseline.
      updateGoldens(import.meta.url, (current) => toolSchemaSource(current, schemas))
      expect(toolSchemaSource(specSource(import.meta.url), schemas), 'the schema baseline must be exactly what the writer emits (idempotent regeneration)')
        .toBe(specSource(import.meta.url))
      // In update mode the constant is the PRE-write value (the module was
      // imported before the file changed), so the file — just verified against the
      // live renderer above — is the thing being updated. The strict run is the gate.
      if (!goldensWritable(process.env)) {
        expect(schemas, 'the full model-visible schema of every named tool must equal the baseline').toEqual(NAMED_TOOL_SCHEMAS_GOLDEN)
      }
      expect(freeDescription, 'foreground must be stated as not resumable').toMatch(/FOREGROUND[\s\S]*never resumable/)
      expect(freeDescription, 'the foreground path is deadline-bounded').toMatch(/foreground deadline/)
      // A caller cannot judge "will this fit in the foreground?" without the
      // actual deadline, and a real session chose background purely to dodge a
      // deadline it could not see. The clause must carry the LIVE value — on a
      // target that can be called in the foreground at all.
      expect(freeDescription, 'the foreground deadline must be stated in minutes').toMatch(/FOREGROUND call waits up to \d+ minutes/)
      // §16.14 vs §16.16: a kept Agent is refused in the foreground BEFORE any
      // deadline is consulted, so the whole foreground narration ("waits up to
      // N minutes", "or for the foreground deadline", "never resumable") is a
      // fact about a call it cannot make. It is skipped for kept targets — a
      // description that printed it next to "a foreground call is refused"
      // contradicted itself.
      for (const foregroundFact of [/A FOREGROUND call waits/, /foreground deadline/, /never resumable/, /stay in the foreground/]) {
        expect(description, `a kept Agent must not carry the foreground fact ${String(foregroundFact)}`)
          .not.toMatch(foregroundFact)
      }
      expect(description, 'background must name both terminal shapes').toMatch(/run_in_background[\s\S]*job id/)
      expect(description).toMatch(/durable child id/)
      expect(description, 'send_message needs agent-control').toMatch(/send_message when you have agent-control/)
      expect(description, 'a background child has no wait call').toMatch(/no wait call/)
      expect(description, 'shell sleep is not a way to wait').toMatch(/sleeping in a shell is not a way to wait/)
      // §16.14: `review` is always kept, and the declaration is rendered at the
      // moment the model chooses the flag rather than left to the persona.
      expect(description, 'an always-kept Agent must say so in its own description').toMatch(/ALWAYS KEPT/)
      expect(description).toMatch(/ALWAYS KEPT[\s\S]*run_in_background: true/)
      expect(freeDescription, 'a foreground-friendly Agent must not claim to be kept').not.toMatch(/ALWAYS KEPT/)
      // §16.16 — the FOUR states, not one. The first wording only said "look
      // for an IDLE child … create when there is no match": while a same-role
      // child was RUNNING there was never an idle match, so the description
      // granted exactly the creation the persona forbids. Every state is pinned
      // by name, and the workstream is spelled out so a caller cannot relabel a
      // continuation as a new one.
      const reuseStates: Array<[string, RegExp]> = [
        ['the look before creating', /Before creating a child of the same role[\s\S]*call list_agents before you create/],
        ['the idle state', /IDLE and reusable: reuse it with send_message/],
        ['the running, same-workstream state', /RUNNING and the new work belongs to the SAME workstream[\s\S]*do NOT create[\s\S]*ONE send_message/],
        ['the running, unrelated state', /RUNNING and the new work is UNRELATED to it: creating a new child is allowed/],
        ['the absent state', /NO same-role child exists: create/],
        ['the stated reason', /say which exception you are using and why/],
      ]
      for (const [state, pattern] of reuseStates) {
        expect(description, `reuse-first must cover ${state}`).toMatch(pattern)
      }
      expect(description, 'a running same-workstream child must not be re-created')
        .toMatch(/SAME workstream[\s\S]*the same MR[\s\S]*continuation of the previous turn[\s\S]*do NOT create/)
      // Only an `optional` target can ever have a reusable child, so a one-shot
      // target must not be taught a rule that cannot apply to it (§5.1).
      expect(freeDescription, 'a one-shot target must not claim a reusable child')
        .not.toMatch(/Before creating a child of the same role|IDLE and reusable|NO same-role child exists/)
      // §16.14 vs §16.16: a kept Agent refuses a foreground call, so the tail
      // must tell it to end its turn instead (the negative for the foreground
      // wording is the `foregroundFact` loop above).
      expect(description, 'a kept Agent must be told to end its turn instead')
        .toMatch(/ALWAYS KEPT, run it in the background and end your turn[\s\S]*message or settlement notice/)
      expect(freeDescription, 'a foreground-friendly Agent keeps the original tail')
        .toContain('if you need the result now, stay in the foreground')

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
      // §16.14 vs the flag description: "leave it false" was a blanket rule, but
      // a foreground call for an ALWAYS KEPT Agent is refused — the model was
      // told to do the one thing that fails. The exception must be stated where
      // the flag is SET, and only for the Agents it applies to.
      expect(backgroundParameter, 'an always-kept Agent must override leave-it-false')
        .toMatch(/ALWAYS KEPT[\s\S]*must be true even when you need the result/i)
      const freeParameter = (host.ctx.tools.get(deriveToolName('explorer'))?.parameters as any)
        ?.properties?.run_in_background?.description ?? ''
      expect(freeParameter, 'a foreground-friendly Agent must not claim the override')
        .not.toMatch(/ALWAYS KEPT/)

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

  it.skipIf(goldensWritable(process.env))('keeps the schema baseline opt-in, deterministic and a zero-diff no-op', () => {
    // Strict-only: the update run cannot assert this (its constant is the
    // pre-write value), and the point of the check is that a reader — CI, a
    // single-file `vitest run` — can never move this file.
    expect(goldensWritable({}), 'the strict suite must never write').toBe(false)
    expect(goldensWritable({ UPDATE_GOLDENS: '0' }), 'any other value must not write').toBe(false)
    expect(goldensWritable({ UPDATE_GOLDENS: '1' }), 'the explicit opt-in must write').toBe(true)
    const source = specSource(import.meta.url)
    expect(toolSchemaSource(source, NAMED_TOOL_SCHEMAS_GOLDEN), 'regenerating with no change must be a zero diff').toBe(source)
    expect(toolSchemaSource(source, NAMED_TOOL_SCHEMAS_GOLDEN), 'the writer must be deterministic')
      .toBe(toolSchemaSource(source, NAMED_TOOL_SCHEMAS_GOLDEN))
  })
})
