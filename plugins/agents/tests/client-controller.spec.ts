/** Web card state/mutation contract without DOM or network (§12.2–12.4). */

import { describe, expect, it, vi } from 'vitest'

import {
  AgentsSettingsController,
  decodeAgentSettings,
  type AgentSettingsSection,
} from '../src/client/controller.js'

function scopeFixture(initial: AgentSettingsSection = { includeDefaults: true, agents: {} }) {
  let snapshot = {
    status: 'ready' as const,
    value: initial,
    base: { includeDefaults: true, agents: {} },
    user: undefined,
    revision: 7,
    writable: true,
    mode: 'host' as const,
  }
  const listeners = new Set<() => void>()
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: vi.fn(async (ops: any[], expectedRevision?: number) => {
      void expectedRevision
      const next = structuredClone(snapshot.value!) as any
      for (const op of ops) {
        let parent = next
        for (const segment of op.path.slice(0, -1)) parent = parent[segment] ??= {}
        const key = op.path.at(-1)!
        if (op.op === 'set') parent[key] = structuredClone(op.value)
        else delete parent[key]
      }
      snapshot = { ...snapshot, value: next, revision: snapshot.revision! + 1 }
      for (const listener of listeners) listener()
    }),
    set: vi.fn(),
    unset: vi.fn(),
    update(next: Partial<typeof snapshot>) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
  return scope
}

const catalog = {
  generation: 'sha256-client',
  agents: [
    {
      id: 'lead', displayName: 'Lead', description: 'Coordinates.', forms: ['main'] as const,
      source: 'built-in' as const, defaultEnabled: true, modelEditable: false,
      allowedChildren: ['worker'], toolCapabilities: ['read'], mainBudgetSummary: { maxDepth: 2 },
    },
    {
      id: 'worker', displayName: 'Worker', description: 'Implements.', forms: ['child'] as const,
      source: 'user-file' as const, defaultEnabled: true, modelEditable: true,
      defaultModel: { provider: 'p', model: 'default' }, allowedChildren: [], toolCapabilities: ['write'],
    },
    {
      id: 'gone', displayName: 'Gone', description: 'Retired.', forms: ['child'] as const,
      source: 'retired' as const, retiredReason: 'definition-file-missing', defaultEnabled: false,
      modelEditable: false, allowedChildren: [], toolCapabilities: [],
    },
  ],
}

describe('decodeAgentSettings', () => {
  it('accepts only the settings section shapes the Host validator understands', () => {
    expect(decodeAgentSettings({
      includeDefaults: false,
      agents: {
        worker: { enabled: true, model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
      },
    })).toEqual({
      includeDefaults: false,
      agents: {
        worker: { enabled: true, model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
      },
    })
    expect(decodeAgentSettings({ includeDefaults: 'yes', agents: {} })).toBeUndefined()
    expect(decodeAgentSettings({ includeDefaults: true, agents: { worker: { model: { provider: 'p' } } } })).toBeUndefined()
    expect(decodeAgentSettings({ includeDefaults: true, agents: { worker: { extra: true } } })).toBeUndefined()
  })
})

describe('AgentsSettingsController', () => {
  it('joins startup-static catalog with the official live settings scope', () => {
    const scope = scopeFixture({
      includeDefaults: false,
      agents: { worker: { enabled: false, model: { provider: 'p2', model: 'fast' } } },
    })
    const controller = new AgentsSettingsController(scope as never, catalog)
    expect(controller.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      includeDefaults: false,
      dirty: false,
      rows: [
        { id: 'lead', enabled: false, enabledEditable: true, modelEditable: false },
        { id: 'worker', enabled: false, enabledEditable: true, modelEditable: true, model: { provider: 'p2', model: 'fast' } },
        { id: 'gone', enabled: false, enabledEditable: false, modelEditable: false },
      ],
    })
    controller.dispose()
  })

  it('rejects edits to retired/model-ineligible rows', () => {
    const controller = new AgentsSettingsController(scopeFixture() as never, catalog)
    expect(() => controller.stageEnabled('gone', true)).toThrow(/retired|read-only/i)
    expect(() => controller.stageModel('lead', { provider: 'p', model: 'm' })).toThrow(/model|read-only/i)
    expect(() => controller.stageEnabled('ghost', true)).toThrow(/unknown/i)
    controller.dispose()
  })

  it('saves all staged fields in one revision-fenced mutation', async () => {
    const scope = scopeFixture()
    const controller = new AgentsSettingsController(scope as never, catalog)
    controller.stageIncludeDefaults(false)
    controller.stageEnabled('worker', false)
    controller.stageModel('worker', { provider: 'p2', model: 'fast', reasoningEffort: 'high' })
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, includeDefaults: false })

    await controller.save()

    expect(scope.mutate).toHaveBeenCalledTimes(1)
    expect(scope.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['includeDefaults'], value: false },
      { op: 'set', path: ['agents', 'worker', 'enabled'], value: false },
      { op: 'set', path: ['agents', 'worker', 'model'], value: { provider: 'p2', model: 'fast', reasoningEffort: 'high' } },
    ], 7)
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, failed: false, conflicted: false })
    controller.dispose()
  })

  it('unsets a model override to inherit the startup catalog default', async () => {
    const scope = scopeFixture({
      includeDefaults: true,
      agents: { worker: { model: { provider: 'custom', model: 'slow' } } },
    })
    const controller = new AgentsSettingsController(scope as never, catalog)
    controller.stageModel('worker', undefined)
    await controller.save()
    expect(scope.mutate).toHaveBeenCalledWith([
      { op: 'unset', path: ['agents', 'worker', 'model'] },
    ], 7)
    expect(controller.getSnapshot().rows[1]?.model).toEqual({ provider: 'p', model: 'default' })
    controller.dispose()
  })

  it('keeps a stale draft and refuses to overwrite a newer revision', async () => {
    const scope = scopeFixture()
    const controller = new AgentsSettingsController(scope as never, catalog)
    controller.stageEnabled('worker', false)
    scope.update({ revision: 8, value: { includeDefaults: true, agents: { worker: { enabled: true } } } })

    await controller.save()

    expect(scope.mutate).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, conflicted: true })
    controller.dispose()
  })

  it('unsubscribes and suppresses late save settlement after dispose', async () => {
    let settle!: () => void
    const scope = scopeFixture()
    scope.mutate.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
    const controller = new AgentsSettingsController(scope as never, catalog)
    controller.stageEnabled('worker', false)
    const saving = controller.save()
    expect(controller.getSnapshot().saving).toBe(true)
    controller.dispose()
    expect(scope.listenerCount()).toBe(0)
    settle()
    await saving
    expect(controller.getSnapshot().saving).toBe(true)
  })
})
