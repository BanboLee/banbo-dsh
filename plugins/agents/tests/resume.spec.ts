/** Cold-resumed continuable child delegation — plan §11.1/§11.1.1. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { delegationDepthOf, resolveChildDepth } from '@deepseek-ai/dsh-subagent'

import { RootBudgetRegistry } from '../budget.js'
import { delegateOne } from '../delegation.js'
import { HolderRegistry } from '../holder-registry.js'
import { CHILD_IDENTITY_VERSION, childIdentityPath, writeChildIdentity } from '../identity.js'

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function fixture(options: { edge?: boolean; enabled?: boolean } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'banbo-resume-'))
  scratch.push(rootDir)
  const definitions = new Map<string, any>([
    ['lead', {
      id: 'lead', allowedChildren: ['worker'],
      main: {
        presetId: 'lead-preset', persona: 'lead.md', tools: ['read'], maxDepth: 3,
        budget: {
          maxConcurrentChildren: 2, maxBatchWidth: 2,
          foregroundDeadlineMs: 100, backgroundDeadlineMs: 200,
          batchDeadlineMs: 150, drainGraceMs: 10,
        },
      },
    }],
    ['worker', {
      id: 'worker', allowedChildren: options.edge === false ? [] : ['leaf'],
      child: {
        model: { default: true }, persona: 'worker.md', guidance: 'Work.',
        tools: ['read'], continuation: 'optional',
      },
    }],
    ['leaf', {
      id: 'leaf', allowedChildren: [],
      child: {
        model: { default: true }, persona: 'leaf.md', guidance: 'Leaf.',
        tools: ['read'], continuation: 'one-shot',
      },
    }],
  ])
  const service = {
    rootDir,
    generation: 'new-generation-after-unrelated-edit',
    definitions,
    personas: new Map([['worker.md', '# Worker'], ['leaf.md', '# Leaf']]),
    abi: { agents: [
      { id: 'lead', toolName: 'agent_lead', hasMain: true, presetId: 'lead-preset' },
      { id: 'worker', toolName: 'agent_worker', hasChild: true },
      { id: 'leaf', toolName: 'agent_leaf', hasChild: true },
    ] },
    settings: {
      policy(agentId: string) {
        const definition = definitions.get(agentId)
        return {
          agentId, definition, exists: definition !== undefined, retired: false,
          effectiveEnabled: definition !== undefined && (agentId !== 'leaf' || options.enabled !== false),
          model: definition?.child?.model,
        }
      },
    },
  }
  writeChildIdentity(rootDir, 'resumed-worker', {
    version: CHILD_IDENTITY_VERSION,
    agentId: 'worker',
    mainAgentId: 'lead',
    presetId: 'lead-preset',
    rootSessionId: 'root-session',
    generation: 'very-old-generation',
  })
  const result = Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'leaf done' }] })
  const dispose = vi.fn(async () => {})
  const subagents = {
    start: vi.fn(async () => ({ id: 'leaf-run', localAgent: undefined, result, dispose })),
  }
  const runtime = {
    service,
    subagents,
    budgets: new RootBudgetRegistry(),
    holders: new HolderRegistry(),
    liveIdentities: new Map(),
    continuableLeases: new Map(),
    configuredMainAgentId: 'lead',
    composedPreset: 'lead-preset',
    registered: new Set(['read', 'read_image', 'agent_leaf', 'delegate_batch']),
    isToolVisible: () => true,
  }
  const parent = {
    id: 'resumed-worker',
    options: { provider: 'p', model: 'm' },
    session: {
      header: { origin: 'subagent', agentPreset: 'lead-preset', delegationDepth: 1 },
    },
  }
  return { rootDir, runtime, parent, subagents, dispose }
}

function delegate(value: ReturnType<typeof fixture>) {
  return delegateOne(value.runtime as never, {
    parent: value.parent as never,
    targetAgentId: 'leaf',
    prompt: 'research',
    description: 'resumed delegation',
    runInBackground: false,
    signal: new AbortController().signal,
  })
}

describe('cold resume reads the persisted depth floor, not a hand-built header', () => {
  it('survives a real persistence round-trip through the official JSONL backend', async () => {
    // The Gate C3 probe proves the depth ARITHMETIC against a header-shaped
    // object. This proves the other half the plan's upgrade fixture needs: the
    // delegation depth really is on the stored header, so a resumed child
    // cannot silently become top-level again.
    const root = mkdtempSync(join(tmpdir(), 'banbo-cold-'))
    scratch.push(root)
    const childId = 'cold-child'

    // Write side: a real Session, persisted by the official backend.
    const writer = new Context()
    try {
      await writer.plugin(SessionStore)
      await writer.plugin(JsonlSessionPersistence, { root } as never)
      const session = writer.sessions.create(childId as never, {
        meta: {
          cwd: process.cwd(),
          origin: 'subagent',
          parentSession: 'root-session' as never,
          delegationDepth: 2,
          agentPreset: 'lead-preset',
        },
      })
      const handle = await writer.sessionPersistence.create(session.header)
      await handle.flush()
      await handle.close()
    } finally {
      await writer.fiber.dispose()
    }

    // Read side: a fresh context, exactly like a new Host process.
    const reader = new Context()
    try {
      await reader.plugin(SessionStore)
      await reader.plugin(JsonlSessionPersistence, { root } as never)
      const handle = await reader.sessionPersistence.open(childId as never, 'read')
      try {
        expect(handle.header.delegationDepth).toBe(2)
        expect(handle.header.parentSession).toBe('root-session')
        expect(handle.header.agentPreset).toBe('lead-preset')

        // The official monotone arithmetic reads that persisted floor: a
        // resumed child at depth 2 is still refused a third level.
        const resumed = { options: {}, session: { header: handle.header } }
        expect(delegationDepthOf(resumed as never)).toBe(2)
        expect(resolveChildDepth(resumed as never, 3)).toBe(3)
        expect(() => resolveChildDepth(resumed as never, 2)).toThrow()
      } finally {
        await handle.close()
      }
    } finally {
      await reader.fiber.dispose()
    }
  })
})

describe('cold-resume authorization', () => {
  it('allows an old-generation identity when current definition, edge and settings allow it', async () => {
    const value = fixture()
    await expect(delegate(value)).resolves.toMatchObject({
      agentId: 'leaf', status: 'completed', result: 'leaf done',
    })
    expect(value.subagents.start).toHaveBeenCalledTimes(1)
    expect(value.dispose).toHaveBeenCalledTimes(1)
    expect(value.runtime.budgets.running('root-session')).toBe(0)
  })

  it('rejects a currently removed edge before provider start', async () => {
    const value = fixture({ edge: false })
    await expect(delegate(value)).rejects.toThrow(/allowedChildren|authoris/i)
    expect(value.subagents.start).not.toHaveBeenCalled()
  })

  it('rejects a currently disabled target before provider start', async () => {
    const value = fixture({ enabled: false })
    await expect(delegate(value)).rejects.toThrow(/disabled/i)
    expect(value.subagents.start).not.toHaveBeenCalled()
  })

  it('fails closed for corrupt or unsupported sidecars without blocking ordinary tools', async () => {
    for (const text of ['not json', '{"version":999}']) {
      const value = fixture()
      writeFileSync(childIdentityPath(value.rootDir, 'resumed-worker'), text)
      await expect(delegate(value)).rejects.toThrow(/identity|sidecar/i)
      expect(value.subagents.start).not.toHaveBeenCalled()
      // The delegation layer installs no global ordinary-tool guard: the
      // rejection is scoped to this call and leaves no budget, holder or
      // identity behind, so the very next healthy delegation still works.
      expect(value.runtime.budgets.running('root-session')).toBe(0)
      expect(value.runtime.holders.size).toBe(0)
      expect(value.runtime.liveIdentities.size).toBe(0)

      // Identity publication is create-only, so the corrupt record must be
      // cleared before a healthy one can be written.
      rmSync(childIdentityPath(value.rootDir, 'resumed-worker'))
      writeChildIdentity(value.rootDir, 'resumed-worker', {
        version: CHILD_IDENTITY_VERSION,
        agentId: 'worker',
        mainAgentId: 'lead',
        presetId: 'lead-preset',
        rootSessionId: 'root-session',
        generation: 'very-old-generation',
      })
      await expect(delegate(value)).resolves.toMatchObject({ agentId: 'leaf', status: 'completed' })
    }
  })
})
