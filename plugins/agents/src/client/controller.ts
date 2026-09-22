import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

import type { AgentCatalogRow, AgentCatalogView, AgentModelView } from '@banbolee/dsh-agents/catalog-remote'

export interface AgentSettingsOverride {
  readonly enabled?: boolean
  readonly model?: AgentModelView | { readonly default: true }
}

export interface AgentSettingsSection {
  readonly includeDefaults: boolean
  readonly agents: Readonly<Record<string, AgentSettingsOverride>>
}

export type AgentSettingsScope = SettingsScope<AgentSettingsSection>
type SettingsPathOp = SettingsPathOpView

export interface AgentSettingsRow extends AgentCatalogRow {
  readonly enabled: boolean
  readonly enabledEditable: boolean
  readonly model?: AgentModelView
}

export interface AgentsSettingsSnapshot {
  readonly available: boolean
  readonly writable: boolean
  readonly includeDefaults: boolean
  readonly rows: readonly AgentSettingsRow[]
  readonly generation: string
  readonly dirty: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly conflicted: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function decodeModel(value: unknown): AgentSettingsOverride['model'] | undefined {
  if (!isRecord(value)) return undefined
  if (value.default === true && hasOnly(value, ['default'])) return { default: true }
  if (!hasOnly(value, ['provider', 'model', 'reasoningEffort'])) return undefined
  if (typeof value.provider !== 'string' || value.provider === '') return undefined
  if (typeof value.model !== 'string' || value.model === '') return undefined
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || value.reasoningEffort === '')) {
    return undefined
  }
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  }
}

/** Narrow the official settings mirror to the Host-owned section contract. */
export function decodeAgentSettings(value: unknown): AgentSettingsSection | undefined {
  if (!isRecord(value) || !hasOnly(value, ['includeDefaults', 'agents'])) return undefined
  if (typeof value.includeDefaults !== 'boolean' || !isRecord(value.agents)) return undefined
  const agents: Record<string, AgentSettingsOverride> = {}
  for (const [agentId, raw] of Object.entries(value.agents)) {
    if (!isRecord(raw) || !hasOnly(raw, ['enabled', 'model'])) return undefined
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined
    const model = raw.model === undefined ? undefined : decodeModel(raw.model)
    if (raw.model !== undefined && model === undefined) return undefined
    agents[agentId] = {
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
      ...(model === undefined ? {} : { model }),
    }
  }
  return { includeDefaults: value.includeDefaults, agents }
}

function concreteModel(value: AgentSettingsOverride['model']): AgentModelView | undefined {
  return value === undefined || 'default' in value ? undefined : value
}

function modelWire(value: AgentModelView): Record<string, string> {
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Staged, revision-fenced editor joining static catalog rows with live settings. */
export class AgentsSettingsController {
  private readonly listeners = new Set<() => void>()
  private readonly staged = new Map<string, SettingsPathOp>()
  private readonly unsubscribe: () => void
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private snapshot: AgentsSettingsSnapshot

  constructor(
    private readonly scope: AgentSettingsScope,
    private readonly catalog: AgentCatalogView,
  ) {
    this.snapshot = this.project()
    this.unsubscribe = scope.subscribe(() => {
      if (this.disposed) return
      if (!this.saving && this.staged.size > 0 && scope.getSnapshot().revision !== this.draftRevision) {
        this.conflicted = true
      }
      this.publish()
    })
  }

  getSnapshot = (): AgentsSettingsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.saveGeneration += 1
    this.unsubscribe()
    this.listeners.clear()
  }

  stageIncludeDefaults(value: boolean): void {
    this.stage({ op: 'set', path: ['includeDefaults'], value })
  }

  stageEnabled(agentId: string, value: boolean): void {
    const row = this.requireRow(agentId)
    if (row.source === 'retired') throw new Error(`banbo-agents: retired agent "${agentId}" is read-only`)
    this.stage({ op: 'set', path: ['agents', agentId, 'enabled'], value })
  }

  stageModel(agentId: string, value: AgentModelView | undefined): void {
    const row = this.requireRow(agentId)
    if (row.source === 'retired' || !row.modelEditable) {
      throw new Error(`banbo-agents: model for agent "${agentId}" is read-only`)
    }
    this.stage(value === undefined
      ? { op: 'unset', path: ['agents', agentId, 'model'] }
      : { op: 'set', path: ['agents', agentId, 'model'], value: modelWire(value) })
  }

  discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  async save(): Promise<void> {
    if (this.disposed || this.saving || this.staged.size === 0) return
    const current = this.scope.getSnapshot()
    if (current.status !== 'ready' || !current.writable) return
    if (current.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }

    const operations = [...this.staged.values()].map((operation) => structuredClone(operation))
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    try {
      await this.scope.mutate(operations, this.draftRevision)
    } catch {
      if (generation !== this.saveGeneration) return
      this.saving = false
      this.failed = true
      this.publish()
      return
    }
    if (generation !== this.saveGeneration) return

    this.saving = false
    if (this.landed(operations)) {
      this.clearDraft()
    } else {
      this.failed = true
    }
    this.publish()
  }

  private requireRow(agentId: string): AgentCatalogRow {
    const row = this.catalog.agents.find((candidate) => candidate.id === agentId)
    if (row === undefined) throw new Error(`banbo-agents: unknown agent "${agentId}"`)
    return row
  }

  private stage(operation: SettingsPathOp): void {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    if (this.staged.size === 0) this.draftRevision = snapshot.revision
    this.staged.set(operation.path.join('\0'), operation)
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private clearDraft(): void {
    this.staged.clear()
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private effectiveSection(): AgentSettingsSection {
    const source = this.scope.getSnapshot().value ?? { includeDefaults: true, agents: {} }
    const next = structuredClone(source) as {
      includeDefaults: boolean
      agents: Record<string, { enabled?: boolean, model?: AgentSettingsOverride['model'] }>
    }
    for (const operation of this.staged.values()) {
      if (operation.path[0] === 'includeDefaults' && operation.op === 'set') {
        next.includeDefaults = operation.value as boolean
        continue
      }
      const agentId = operation.path[1]
      const field = operation.path[2]
      if (agentId === undefined || field === undefined) continue
      const target = next.agents[agentId] ??= {}
      if (operation.op === 'unset') delete target[field as 'model']
      else if (field === 'enabled') target.enabled = operation.value as boolean
      else {
        const model = decodeModel(operation.value)
        if (model !== undefined) target.model = model
      }
    }
    return next
  }

  private project(): AgentsSettingsSnapshot {
    const scope = this.scope.getSnapshot()
    const section = this.effectiveSection()
    return Object.freeze({
      available: scope.status !== 'unavailable',
      writable: scope.status === 'ready' && scope.writable,
      includeDefaults: section.includeDefaults,
      rows: this.catalog.agents.map((row) => {
        const override = section.agents[row.id]
        const retired = row.source === 'retired'
        const defaultEnabled = row.source === 'built-in' ? section.includeDefaults : row.defaultEnabled
        const model = row.modelEditable
          ? concreteModel(override?.model) ?? row.defaultModel
          : undefined
        return Object.freeze({
          ...row,
          enabled: retired ? false : (override?.enabled ?? defaultEnabled),
          enabledEditable: !retired,
          ...(model === undefined ? {} : { model: structuredClone(model) }),
        })
      }),
      generation: this.catalog.generation,
      dirty: this.staged.size > 0,
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
    })
  }

  private publish(): void {
    this.snapshot = this.project()
    for (const listener of this.listeners) listener()
  }

  private landed(operations: readonly SettingsPathOp[]): boolean {
    const section = this.scope.getSnapshot().value
    if (section === undefined) return false
    for (const operation of operations) {
      if (operation.path[0] === 'includeDefaults') {
        if (operation.op !== 'set' || section.includeDefaults !== operation.value) return false
        continue
      }
      const agentId = operation.path[1]
      const field = operation.path[2]
      if (agentId === undefined || field === undefined) return false
      const actual = section.agents[agentId]?.[field as keyof AgentSettingsOverride]
      if (operation.op === 'unset' ? actual !== undefined : !sameValue(actual, operation.value)) return false
    }
    return true
  }
}
