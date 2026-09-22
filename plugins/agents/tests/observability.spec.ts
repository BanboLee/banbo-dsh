/** Minimal Host-only observability — plan §13.1. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BudgetError, RootBudgetRegistry } from '../budget.js'
import {
  DelegationError,
  delegateBatch,
  delegateOne,
  rejectionReason,
} from '../delegation.js'
import { HolderRegistry } from '../holder-registry.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'banbo-observe-secret-path-'))
  scratch.push(rootDir)
  const result = deferred<any>()
  const definitions = new Map<string, any>([
    ['lead', {
      id: 'lead', allowedChildren: ['worker'],
      main: {
        presetId: 'lead-preset', persona: 'lead.md', tools: ['read'], maxDepth: 2,
        budget: {
          maxConcurrentChildren: 2, maxBatchWidth: 2,
          foregroundDeadlineMs: 100, backgroundDeadlineMs: 200,
          batchDeadlineMs: 150, drainGraceMs: 10,
        },
      },
    }],
    ['worker', {
      id: 'worker', allowedChildren: [],
      child: {
        model: { default: true }, persona: 'worker.md', guidance: 'guide-secret',
        tools: ['read'], continuation: 'one-shot',
      },
    }],
  ])
  const service = {
    rootDir,
    generation: 'new-generation',
    definitions,
    personas: new Map([['worker.md', '# persona-secret']]),
    abi: { agents: [
      { id: 'lead', toolName: 'agent_lead', hasMain: true, presetId: 'lead-preset' },
      { id: 'worker', toolName: 'agent_worker', hasChild: true },
    ] },
    settings: {
      policy(agentId: string) {
        const definition = definitions.get(agentId)
        return { agentId, definition, exists: definition !== undefined, retired: false, effectiveEnabled: true, model: definition?.child?.model }
      },
    },
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  const runtime = {
    service,
    logger,
    now: vi.fn(() => 1_000),
    subagents: {
      start: vi.fn(async () => ({
        id: 'child-1', localAgent: undefined, result: result.promise,
        dispose: vi.fn(async () => {}),
      })),
    },
    budgets: new RootBudgetRegistry(),
    holders: new HolderRegistry({ logger }),
    liveIdentities: new Map(),
    continuableLeases: new Map(),
    configuredMainAgentId: 'lead',
    composedPreset: 'lead-preset',
    registered: new Set(['read', 'read_image', 'agent_worker', 'delegate_batch']),
    isToolVisible: () => true,
  }
  const parent = {
    id: 'root-session', options: {},
    session: { header: { agentPreset: 'lead-preset' } },
  }
  return { runtime, parent, result, logger, rootDir }
}

function serializedCalls(spy: ReturnType<typeof vi.fn>) {
  return JSON.stringify(spy.mock.calls)
}

describe('rejection reason taxonomy', () => {
  it('maps the six independent policy paths to stable reasons', () => {
    expect(rejectionReason(new DelegationError('target-disabled', 'x'))).toBe('disabled')
    expect(rejectionReason(new DelegationError('edge-unauthorised', 'x'))).toBe('edge-denied')
    expect(rejectionReason(new DelegationError('depth-exceeded', 'x'))).toBe('depth')
    expect(rejectionReason(new BudgetError('concurrency-exceeded', 'x'))).toBe('budget')
    expect(rejectionReason(new DelegationError('target-retired', 'x'))).toBe('retired')
    expect(rejectionReason(new DelegationError('identity-unknown', 'x'))).toBe('identity-missing')
  })

  it('emits the mapped reason from real call sites, not only from hand-built errors', async () => {
    // The map above proves the table; this proves the CALL SITES actually raise
    // those codes. Without it a wrong code would silently suppress the whole
    // `delegation/rejected` record, because `logRejected` emits nothing when it
    // cannot classify the error.
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['not-allowed', 'edge-denied', 'edge-unauthorised'],
      ['retired', 'retired', 'target-retired'],
    ]
    for (const [targetAgentId, reason, code] of cases) {
      const value = fixture()
      if (targetAgentId === 'retired') {
        // Reachable only when the edge survives the deletion — the realistic
        // RetiredToolShell shape. `not-allowed` deliberately stays OUTSIDE
        // allowedChildren so the edge check is the one that refuses it.
        const lead = value.runtime.service.definitions.get('lead') as { allowedChildren: string[] }
        lead.allowedChildren = ['worker', 'retired']
        const abi = value.runtime.service.abi as { agents: Array<Record<string, unknown>> }
        abi.agents.push({ id: 'retired', toolName: 'agent_retired', hasChild: true, retired: true })
      }

      let caught: unknown
      try {
        await delegateOne(value.runtime as never, {
          parent: value.parent as never,
          targetAgentId,
          prompt: 'REAL_PATH_PROMPT_SECRET',
          description: 'REAL_PATH_DESCRIPTION_SECRET',
          runInBackground: false,
          signal: new AbortController().signal,
        })
      } catch (error) {
        caught = error
      }

      expect((caught as DelegationError).code, targetAgentId).toBe(code)
      expect(value.logger.info, targetAgentId).toHaveBeenCalledWith('banbo-agents: delegation/rejected', {
        agentId: targetAgentId, reason,
      })
      expect(serializedCalls(value.logger.info)).not.toMatch(/REAL_PATH_PROMPT_SECRET|REAL_PATH_DESCRIPTION_SECRET/)
    }
  })
})

describe('delegation lifecycle records', () => {
  it('logs structured start/end fields without prompt, output, persona, credentials, or paths', async () => {
    const value = fixture()
    const pending = delegateOne(value.runtime as never, {
      parent: value.parent as never,
      targetAgentId: 'worker',
      prompt: 'PROMPT_SECRET api_key=SECRET_TOKEN',
      description: 'DESCRIPTION_SECRET',
      runInBackground: false,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(value.runtime.subagents.start).toHaveBeenCalled())
    value.runtime.now.mockReturnValue(1_275)
    value.result.resolve({
      stopReason: 'completed', output: [{ type: 'text', text: 'OUTPUT_SECRET' }],
    })
    await pending

    expect(value.logger.info).toHaveBeenCalledWith('banbo-agents: delegation/start', {
      rootSessionId: 'root-session', childId: 'child-1', agentId: 'worker',
      mode: 'one-shot', depth: 1, background: false,
    })
    expect(value.logger.info).toHaveBeenCalledWith('banbo-agents: delegation/end', {
      rootSessionId: 'root-session', childId: 'child-1', agentId: 'worker',
      mode: 'one-shot', depth: 1, background: false,
      stopReason: 'completed', durationMs: 275, outcome: 'completed',
    })
    const logs = serializedCalls(value.logger.info)
    for (const secret of ['PROMPT_SECRET', 'SECRET_TOKEN', 'DESCRIPTION_SECRET', 'OUTPUT_SECRET', 'persona-secret', value.rootDir]) {
      expect(logs).not.toContain(secret)
    }
  })

  it('logs a classified rejection without prompt or exception text', async () => {
    const value = fixture()
    value.runtime.service.settings.policy = (agentId: string) => ({
      agentId,
      definition: value.runtime.service.definitions.get(agentId),
      exists: true,
      retired: false,
      effectiveEnabled: agentId !== 'worker',
      model: undefined,
    })
    await expect(delegateOne(value.runtime as never, {
      parent: value.parent as never,
      targetAgentId: 'worker',
      prompt: 'REJECTED_PROMPT_SECRET',
      description: 'REJECTED_DESCRIPTION_SECRET',
      runInBackground: false,
      signal: new AbortController().signal,
    })).rejects.toThrow(/disabled/i)
    expect(value.logger.info).toHaveBeenCalledWith('banbo-agents: delegation/rejected', {
      agentId: 'worker', reason: 'disabled',
    })
    expect(serializedCalls(value.logger.info)).not.toMatch(/REJECTED_PROMPT_SECRET|REJECTED_DESCRIPTION_SECRET/)
  })

  it('logs one batch settlement without item prompts or outputs', async () => {
    const value = fixture()
    const pending = delegateBatch(value.runtime as never, {
      parent: value.parent as never,
      tasks: [{ agentId: 'worker', prompt: 'BATCH_PROMPT_SECRET', description: 'BATCH_DESCRIPTION_SECRET' }],
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(value.runtime.subagents.start).toHaveBeenCalled())
    value.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'BATCH_OUTPUT_SECRET' }] })
    await pending
    expect(value.logger.info).toHaveBeenCalledWith('banbo-agents: batch/settled', {
      rootSessionId: 'root-session', itemCount: 1, status: 'completed', deadlineMs: 150,
    })
    expect(serializedCalls(value.logger.info)).not.toMatch(/BATCH_PROMPT_SECRET|BATCH_DESCRIPTION_SECRET|BATCH_OUTPUT_SECRET/)
  })
})

describe('orphan diagnostics', () => {
  it('emits one bounded holder/orphaned record per unresolved holder', async () => {
    const grace = deferred<void>()
    const logger = { info: vi.fn(), warn: vi.fn() }
    let now = 100
    const registry = new HolderRegistry({ logger, now: () => now, delay: () => grace.promise })
    const long = `worker: ${'界'.repeat(100)}`
    const holder = registry.reserve(long)
    holder.attach({
      id: 'hung', result: new Promise(() => {}), dispose: () => new Promise(() => {}),
    } as never)
    now = 500
    const draining = registry.drain({ graceMs: 30 })
    grace.resolve()
    await draining

    expect(logger.warn).toHaveBeenCalledWith('banbo-agents: holder/orphaned', {
      label: expect.any(String), registeredMs: 400, graceMs: 30,
    })
    const fields = logger.warn.mock.calls[0][1]
    expect(Buffer.byteLength(fields.label, 'utf8')).toBeLessThanOrEqual(128)
    expect(fields.label).not.toBe(long)
  })
})
