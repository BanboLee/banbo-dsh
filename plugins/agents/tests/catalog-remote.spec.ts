/** Product contract for the read-only CatalogRemote (§12.2). */

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { BanboAgentsCatalog } from '../lib/catalog-remote.js'

const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  let settings = {
    includeDefaults: true,
    agents: {
      worker: { enabled: false, model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
    },
  }
  const definitions = new Map([
    ['lead', {
      id: 'lead', displayName: 'Lead', description: 'Coordinates.', allowedChildren: ['worker'],
      main: {
        tools: ['read', 'goal'],
        maxDepth: 2,
        budget: {
          maxConcurrentChildren: 8,
          maxBatchWidth: 2,
          foregroundDeadlineMs: 600_000,
          backgroundDeadlineMs: 1_200_000,
          batchDeadlineMs: 300_000,
          drainGraceMs: 5_000,
        },
      },
    }],
    ['worker', {
      id: 'worker', displayName: 'Worker', description: 'Implements.', allowedChildren: [],
      child: { tools: ['read', 'write'], model: { default: true } },
    }],
  ])
  ctx.provide('banboAgents', Object.freeze({
    generation: 'sha256-probe',
    rootDir: '/must/not/leak',
    packageRoot: '/must/not/leak/package',
    definitions,
    builtinIds: new Set(['lead']),
    personas: new Map([['prompts/lead.md', 'SECRET PERSONA']]),
    abi: { agents: [
      { id: 'lead', hasMain: true, hasChild: false },
      { id: 'worker', hasMain: false, hasChild: true },
      { id: 'gone', displayName: 'Gone', description: 'Retired.', hasMain: false, hasChild: true, retired: true, retiredReason: 'definition-file-missing', toolCapabilities: ['read'] },
    ] },
    settings: { get: () => settings },
  }))
  const service = new BanboAgentsCatalog(ctx)
  return {
    service,
    update(next: typeof settings) { settings = next },
  }
}

describe('BanboAgentsCatalog', () => {
  it('publishes exactly one typed list Remote marker', () => {
    const { service } = fixture()
    expect(service.name).toBe('banboAgentsCatalog')
    expect(remoteMethods(service).map((marker) => marker.method)).toEqual(['list'])
  })

  it('projects current and retired rows without sensitive Host fields', async () => {
    const { service } = fixture()
    const view = await service.list()
    expect(view).toEqual({
      generation: 'sha256-probe',
      agents: [
        {
          id: 'gone', displayName: 'Gone', description: 'Retired.', forms: ['child'], source: 'retired',
          retiredReason: 'definition-file-missing', defaultEnabled: false, modelEditable: false,
          allowedChildren: [], toolCapabilities: ['read'],
        },
        {
          id: 'lead', displayName: 'Lead', description: 'Coordinates.', forms: ['main'], source: 'built-in',
          defaultEnabled: true, modelEditable: false, allowedChildren: ['worker'], toolCapabilities: ['read', 'goal'],
          // The card's budget row must show the real guard, not just maxDepth:
          // the concurrency and deadline values live in the nested `budget`.
          mainBudgetSummary: {
            backgroundDeadlineMs: 1_200_000,
            batchDeadlineMs: 300_000,
            drainGraceMs: 5_000,
            foregroundDeadlineMs: 600_000,
            maxBatchWidth: 2,
            maxConcurrentChildren: 8,
            maxDepth: 2,
          },
        },
        {
          id: 'worker', displayName: 'Worker', description: 'Implements.', forms: ['child'], source: 'user-file',
          defaultEnabled: true, modelEditable: true,
          allowedChildren: [], toolCapabilities: ['read', 'write'],
        },
      ],
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('SECRET PERSONA')
    expect(serialized).not.toContain('/must/not/leak')
  })

  it('stays startup-static when live settings change', async () => {
    const { service, update } = fixture()
    const before = await service.list()
    update({ includeDefaults: true, agents: { worker: { enabled: true, model: { default: true } } } } as never)
    expect(await service.list()).toEqual(before)
  })
})
