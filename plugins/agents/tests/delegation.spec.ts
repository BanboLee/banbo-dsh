/**
 * Delegation policy — docs/agents-plugin-plan.md §10.1–§10.5 and §11.1.1.
 *
 * These tests stop before holder/deadline accounting (budget.spec.ts and
 * batch.spec.ts own that). They lock identity, current-policy authorization,
 * official absolute depth arithmetic and the detached start request.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CHILD_IDENTITY_VERSION, writeChildIdentity } from '../identity.js'
import {
  DelegationError,
  buildDelegationRequest,
  prepareDelegation,
  resolveCallerIdentity,
} from '../delegation.js'

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'banbo-delegation-'))
  scratch.push(root)
  return root
}

const REGISTERED = new Set([
  'read', 'read_image', 'write', 'edit', 'grep', 'glob', 'bash',
  'web_search', 'web_fetch', 'skill', 'todo_write',
  'job_list', 'job_output', 'job_kill',
  'list_agents', 'send_message', 'interrupt_agent',
  'agent_worker', 'agent_leaf', 'agent_disabled', 'agent_retired',
  'delegate_batch',
])

function service(root = rootDir()) {
  const definitions = new Map([
    ['lead', {
      id: 'lead',
      displayName: 'Lead',
      allowedChildren: ['worker', 'leaf', 'disabled'],
      main: {
        presetId: 'lead-preset',
        persona: 'prompts/lead.md',
        tools: ['read'],
        maxDepth: 2,
        budget: {},
      },
    }],
    ['worker', {
      id: 'worker',
      displayName: 'Worker',
      allowedChildren: ['leaf'],
      child: {
        model: { provider: 'deepseek', model: 'fast', reasoningEffort: 'high' },
        persona: 'prompts/worker.md',
        guidance: 'Implement one bounded task.',
        tools: ['read', 'write', 'edit', 'exec', 'agent-control'],
        continuation: 'optional',
      },
    }],
    ['leaf', {
      id: 'leaf',
      displayName: 'Leaf',
      allowedChildren: [],
      child: {
        model: { default: true },
        persona: 'prompts/leaf.md',
        guidance: 'Research one bounded question.',
        tools: ['read', 'search'],
        continuation: 'one-shot',
      },
    }],
    ['disabled', {
      id: 'disabled',
      displayName: 'Disabled',
      allowedChildren: [],
      child: {
        model: { default: true },
        persona: 'prompts/disabled.md',
        guidance: 'Disabled fixture.',
        tools: ['read'],
        continuation: 'one-shot',
      },
    }],
  ])
  return {
    rootDir: root,
    generation: 'current-generation',
    definitions,
    personas: new Map([
      ['prompts/lead.md', '# Lead\n'],
      ['prompts/worker.md', '# Worker\n'],
      ['prompts/leaf.md', '# Leaf\n'],
      ['prompts/disabled.md', '# Disabled\n'],
    ]),
    abi: {
      agents: [
        { id: 'lead', toolName: 'agent_lead', hasMain: true, presetId: 'lead-preset' },
        { id: 'worker', toolName: 'agent_worker', hasChild: true },
        { id: 'leaf', toolName: 'agent_leaf', hasChild: true },
        { id: 'disabled', toolName: 'agent_disabled', hasChild: true },
        { id: 'retired', toolName: 'agent_retired', hasChild: true, retired: true },
      ],
    },
    settings: {
      policy(agentId: string) {
        const definition = definitions.get(agentId)
        return {
          agentId,
          definition,
          exists: definition !== undefined,
          retired: agentId === 'retired',
          effectiveEnabled: definition !== undefined && agentId !== 'disabled',
          model: definition?.child?.model,
        }
      },
    },
  }
}

function parent(options: {
  id?: string
  origin?: 'subagent'
  depth?: number
  runtimeDepth?: number
  preset?: string
  label?: string
} = {}) {
  return {
    id: options.id ?? 'root-session',
    // A misleading label is intentional: identity may never parse it.
    label: options.label ?? 'leaf: do not trust this label',
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      ...(options.runtimeDepth === undefined ? {} : { subagentDepth: options.runtimeDepth }),
    },
    session: {
      header: {
        agentPreset: options.preset ?? 'lead-preset',
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.depth === undefined ? {} : { delegationDepth: options.depth }),
      },
    },
  }
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    version: CHILD_IDENTITY_VERSION,
    agentId: 'worker',
    mainAgentId: 'lead',
    presetId: 'lead-preset',
    rootSessionId: 'root-session',
    generation: 'old-generation',
    ...overrides,
  }
}

describe('resolveCallerIdentity', () => {
  it('derives a top-level identity only from configured preset facts', () => {
    const state = service()
    expect(resolveCallerIdentity({
      parent: parent() as never,
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: new Map(),
    })).toEqual({
      version: CHILD_IDENTITY_VERSION,
      agentId: 'lead',
      mainAgentId: 'lead',
      presetId: 'lead-preset',
      rootSessionId: 'root-session',
      generation: 'current-generation',
    })
  })

  it('resolves a live one-shot child by exact session id, never its label', () => {
    const state = service()
    const live = new Map([['child-live', identity({ agentId: 'worker' })]])
    expect(resolveCallerIdentity({
      parent: parent({ id: 'child-live', origin: 'subagent', label: 'leaf: misleading' }) as never,
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: live,
    }).agentId).toBe('worker')
  })

  it('reads a continuable child sidecar and does not reject an old generation', () => {
    const state = service()
    writeChildIdentity(state.rootDir, 'child-durable', identity({ generation: 'very-old-generation' }))
    expect(resolveCallerIdentity({
      parent: parent({ id: 'child-durable', origin: 'subagent' }) as never,
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: new Map(),
    })).toMatchObject({ agentId: 'worker', generation: 'very-old-generation' })
  })

  it('fails closed when a child identity is missing or malformed', () => {
    const state = service()
    expect(() => resolveCallerIdentity({
      parent: parent({ id: 'unknown-child', origin: 'subagent' }) as never,
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: new Map(),
    })).toThrow(/identity|身份|sidecar/i)
  })

  it('fails closed when identity main/preset no longer maps in current catalog', () => {
    const state = service()
    const live = new Map([['child-live', identity({ presetId: 'wrong-preset' })]])
    expect(() => resolveCallerIdentity({
      parent: parent({ id: 'child-live', origin: 'subagent' }) as never,
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: live,
    })).toThrow(/preset|mapping|restart/i)
  })
})

describe('prepareDelegation — current authorization and absolute depth', () => {
  it('prepares a top-level request using target persona/model and one absolute cap', () => {
    const prepared = prepareDelegation({
      parent: parent() as never,
      targetAgentId: 'worker',
      service: service() as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: new Map(),
      registered: REGISTERED,
    })
    expect(prepared).toMatchObject({
      callerIdentity: { agentId: 'lead', rootSessionId: 'root-session' },
      targetAgentId: 'worker',
      childDepth: 1,
      remainingDepth: 1,
      maxDepth: 2,
      persona: '# Worker\n',
      agentOptions: { provider: 'deepseek', model: 'fast', reasoningEffort: 'high' },
    })
    expect(prepared.toolFilter.allow).toEqual([
      'read', 'read_image', 'write', 'edit', 'bash',
      'list_agents', 'send_message', 'interrupt_agent',
      'agent_leaf', 'delegate_batch',
    ])
  })

  it('uses the official monotone depth floor and hides all next-level tools at cap', () => {
    const state = service()
    const live = new Map([['worker-session', identity()]])
    const prepared = prepareDelegation({
      parent: parent({ id: 'worker-session', origin: 'subagent', depth: 0, runtimeDepth: 1 }) as never,
      targetAgentId: 'leaf',
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: live,
      registered: REGISTERED,
    })
    expect(prepared.childDepth).toBe(2)
    expect(prepared.remainingDepth).toBe(0)
    expect(prepared.toolFilter.allow).toEqual(['read', 'read_image', 'grep', 'glob'])
    expect(prepared.agentOptions).toBeUndefined()
  })

  it('rejects an edge absent from the caller current allowedChildren', () => {
    const state = service()
    const live = new Map([['worker-session', identity()]])
    expect(() => prepareDelegation({
      parent: parent({ id: 'worker-session', origin: 'subagent', depth: 1 }) as never,
      targetAgentId: 'disabled',
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: live,
      registered: REGISTERED,
    })).toThrow(/not authoris|allowedChildren|授权/i)
  })

  it('rejects a disabled, retired, unknown, or main-only target with a distinct code', () => {
    // Asserting only "some DelegationError" would let a wrong code through, and
    // `logRejected` silently emits nothing when it cannot map the code — so the
    // operator loses the very diagnostic this taxonomy exists to provide.
    //
    // The edge check runs BEFORE the target checks, so every deeper code needs
    // the name to be an allowed child: that is the realistic shape of the
    // `RetiredToolShell` case (the edge survives, the definition does not).
    const state = service()
    state.definitions.get('lead')!.allowedChildren = ['disabled', 'retired', 'unknown', 'lead']
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['disabled', 'target-disabled'],
      ['retired', 'target-retired'],
      ['unknown', 'target-unknown'],
      ['lead', 'target-main-only'],
    ]
    for (const [targetAgentId, code] of cases) {
      let caught: unknown
      try {
        prepareDelegation({
          parent: parent() as never,
          targetAgentId,
          service: state as never,
          configuredMainAgentId: 'lead',
          composedPreset: 'lead-preset',
          liveIdentities: new Map(),
          registered: REGISTERED,
        })
      } catch (error) {
        caught = error
      }
      expect(caught, targetAgentId).toBeInstanceOf(DelegationError)
      expect((caught as DelegationError).code, targetAgentId).toBe(code)
    }
  })

  it('refuses a target the caller is not authorised to reach, before any target check', () => {
    const state = service()
    let caught: unknown
    try {
      prepareDelegation({
        parent: parent() as never,
        targetAgentId: 'retired',
        service: state as never,
        configuredMainAgentId: 'lead',
        composedPreset: 'lead-preset',
        liveIdentities: new Map(),
        registered: REGISTERED,
      })
    } catch (error) {
      caught = error
    }
    // `retired` is not in this fixture's allowedChildren, so the edge wins.
    expect((caught as DelegationError).code).toBe('edge-unauthorised')
  })

  it('rejects a child beyond the main preset absolute cap through official depth logic', () => {
    const state = service()
    const live = new Map([['worker-session', identity()]])
    expect(() => prepareDelegation({
      parent: parent({ id: 'worker-session', origin: 'subagent', depth: 2 }) as never,
      targetAgentId: 'leaf',
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: live,
      registered: REGISTERED,
    })).toThrow(/depth|cap|maximum/i)
  })
})

describe('buildDelegationRequest', () => {
  function requestFor(state: ReturnType<typeof service>, targetAgentId = 'worker') {
    const prepared = prepareDelegation({
      parent: parent() as never,
      targetAgentId,
      service: state as never,
      configuredMainAgentId: 'lead',
      composedPreset: 'lead-preset',
      liveIdentities: new Map(),
      registered: REGISTERED,
    })
    const signal = new AbortController().signal
    const request = buildDelegationRequest(prepared, {
      parent: parent() as never,
      prompt: 'Implement the parser.',
      description: 'parser implementation',
      signal,
    })
    return { prepared, request, signal }
  }

  it('builds the exact official one-shot request without encoding identity in label', () => {
    const { prepared, request, signal } = requestFor(service())
    expect(request).toMatchObject({
      label: 'Worker: parser implementation',
      prompt: [{ type: 'text', text: 'Implement the parser.' }],
      signal,
      maxDepth: 2,
      persona: '# Worker\n',
      toolFilter: prepared.toolFilter,
      agentOptions: prepared.agentOptions,
    })
    expect(request.label).not.toContain('root-session')
    expect(request.label).not.toContain('current-generation')
  })

  it('prefixes the label with the target displayName, never the raw id', () => {
    const { prepared, request } = requestFor(service())
    expect(prepared.targetDefinition.displayName).toBe('Worker')
    expect(request.label.startsWith(`${prepared.targetDefinition.displayName}: `)).toBe(true)
    expect(request.label).toBe('Worker: parser implementation')
    expect(request.label.startsWith(`${prepared.targetAgentId}: `)).toBe(false)
  })

  it('keeps a display-layer fallback for a definition that bypassed validation', () => {
    // DEFENSIVE ONLY, and deliberately so. `displayName` is required and
    // non-empty by `validateAgentDefinition`, and `catalog.js` is the only
    // production constructor — so no shipped or user definition can reach this
    // branch. It exists so a future schema relaxation degrades to the raw id
    // instead of rendering `undefined: …` in the subagent list, and this case
    // pins that fallback rather than claiming a production path.
    const state = service()
    delete (state.definitions.get('worker') as { displayName?: string }).displayName
    const { prepared, request } = requestFor(state)
    expect(prepared.targetDefinition.displayName).toBeUndefined()
    expect(request.label).toBe('worker: parser implementation')
  })
})
