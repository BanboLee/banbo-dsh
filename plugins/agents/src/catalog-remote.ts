/** Read-only startup catalog exposed to the Web settings card (§12.2). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export interface AgentModelView {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentCatalogRow {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly forms: readonly ('main' | 'child')[]
  readonly source: 'built-in' | 'user-file' | 'retired'
  readonly retiredReason?: string
  readonly defaultEnabled: boolean
  readonly modelEditable: boolean
  readonly defaultModel?: AgentModelView
  readonly allowedChildren: readonly string[]
  readonly toolCapabilities: readonly string[]
  readonly mainBudgetSummary?: Readonly<Record<string, number>>
}

export interface AgentCatalogView {
  readonly agents: readonly AgentCatalogRow[]
  readonly generation: string
}

interface AgentDefinition {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly allowedChildren: readonly string[]
  readonly main?: { readonly tools: readonly string[], readonly maxDepth: number, readonly [key: string]: unknown }
  readonly child?: { readonly tools: readonly string[], readonly model: unknown }
}

interface AbiRecord {
  readonly id: string
  readonly displayName?: string
  readonly description?: string
  readonly hasMain?: boolean
  readonly hasChild?: boolean
  readonly retired?: boolean
  readonly retiredReason?: string
  readonly toolCapabilities?: readonly string[]
}

interface BanboAgentsState {
  readonly generation: string
  readonly definitions: ReadonlyMap<string, AgentDefinition>
  readonly builtinIds: ReadonlySet<string>
  readonly abi: { readonly agents: readonly AbiRecord[] }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly banboAgents: BanboAgentsState
  }
}

/**
 * Remote-only service projecting the startup-static catalog.
 * @typert service banboAgentsCatalog
 */
export class BanboAgentsCatalog extends TypertRemoteService {
  static inject = ['banboAgents']

  constructor(ctx: Context) {
    super(ctx, 'banboAgentsCatalog')
  }

  @Remote('list')
  async list(): Promise<AgentCatalogView> {
    const state = this.ctx.banboAgents
    const rows = new Map<string, AgentCatalogRow>()

    for (const definition of state.definitions.values()) {
      const forms: ('main' | 'child')[] = []
      if (definition.main !== undefined) forms.push('main')
      if (definition.child !== undefined) forms.push('child')
      const model = definition.child === undefined ? undefined : concreteModel(definition.child.model)
      const capabilities = new Set([
        ...(definition.main?.tools ?? []),
        ...(definition.child?.tools ?? []),
      ])
      rows.set(definition.id, {
        id: definition.id,
        displayName: definition.displayName,
        description: definition.description,
        forms,
        source: state.builtinIds.has(definition.id) ? 'built-in' : 'user-file',
        defaultEnabled: true,
        modelEditable: definition.child !== undefined,
        ...(model === undefined ? {} : { defaultModel: model }),
        allowedChildren: [...definition.allowedChildren],
        toolCapabilities: [...capabilities],
        ...(definition.main === undefined ? {} : {
          mainBudgetSummary: numericBudget(definition.main),
        }),
      })
    }

    for (const record of state.abi.agents) {
      if (rows.has(record.id) || record.retired !== true) continue
      const forms: ('main' | 'child')[] = []
      if (record.hasMain === true) forms.push('main')
      if (record.hasChild === true) forms.push('child')
      rows.set(record.id, {
        id: record.id,
        displayName: record.displayName ?? record.id,
        description: record.description ?? '',
        forms,
        source: 'retired',
        ...(record.retiredReason === undefined ? {} : { retiredReason: record.retiredReason }),
        defaultEnabled: false,
        modelEditable: false,
        allowedChildren: [],
        toolCapabilities: [...(record.toolCapabilities ?? [])],
      })
    }

    return {
      agents: [...rows.values()].sort((left, right) => left.id.localeCompare(right.id)),
      generation: state.generation,
    }
  }
}

/** Keep only the supported concrete child-model shape; default stays absent. */
function concreteModel(value: unknown): AgentModelView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const model = value as Record<string, unknown>
  if (model.default === true) return undefined
  if (typeof model.provider !== 'string' || typeof model.model !== 'string') return undefined
  return {
    provider: model.provider,
    model: model.model,
    ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
  }
}

/**
 * Project the main agent's numeric budget without leaking unrelated config.
 *
 * The delegation budgets live in the nested `main.budget` object, so scanning
 * `main` shallowly reported only `maxDepth`: the card's "main-agent budget" row
 * displayed a depth cap while hiding every concurrency and deadline value the
 * user needs in order to reason about the guard (§12.1).
 */
function numericBudget(main: Readonly<Record<string, unknown>>): Readonly<Record<string, number>> {
  const result: Record<string, number> = {}
  const collect = (source: unknown): void => {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    }
  }
  collect(main)
  collect(main.budget)
  return Object.freeze(
    Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))),
  )
}

export default BanboAgentsCatalog
