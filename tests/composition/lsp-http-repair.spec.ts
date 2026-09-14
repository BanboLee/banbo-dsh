import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoopbackServer } from '../../scripts/qa/fixtures/loopback-openai-sse.mjs'
import {
  bootLspDiagnosticsProfile,
  loadAnchorModule,
  type LspDiagnosticsBooted,
} from './lsp-diagnostics-profile'

type Agent = {
  readonly followup: (message: unknown) => void
}

type AgentLoopContext = {
  readonly agentLoop: {
    readonly create: (
      id: unknown,
      options: Readonly<Record<string, unknown>>,
      meta: { readonly cwd: string },
    ) => Agent
  }
  readonly on: (
    event: 'agent/status',
    listener: (payload: { readonly agent: Agent; readonly status: string }) => void,
  ) => () => void
}

const profiles: LspDiagnosticsBooted[] = []
const servers: Server[] = []
const apiKeyEnvironment = 'QA_LSP_LOOPBACK_API_KEY'
let previousApiKey: string | undefined

afterEach(async () => {
  while (profiles.length > 0) {
    const profile = profiles.pop()
    if (profile !== undefined) await profile.cleanup()
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })))
  if (previousApiKey === undefined) delete process.env[apiKeyEnvironment]
  else process.env[apiKeyEnvironment] = previousApiKey
  previousApiKey = undefined
})

describe('LSP feedback through the real HTTP session adapter', () => {
  it('repairs only after diagnostics and finishes only after clean feedback', async () => {
    // Given: a finite local HTTP model and a real Loader profile using content-aware fake LSP.
    const fixture = createLoopbackServer({ scenario: 'lsp-repair' })
    servers.push(fixture.server)
    fixture.server.listen(0, '127.0.0.1')
    await once(fixture.server, 'listening')
    const address = fixture.server.address()
    if (address === null || typeof address === 'string') throw new TypeError('missing loopback address')
    previousApiKey = process.env[apiKeyEnvironment]
    process.env[apiKeyEnvironment] = 'local-loopback-key'
    const providerUrl = `http://127.0.0.1:${address.port}`
    const profile = await bootLspDiagnosticsProfile({
      typescriptMode: 'content-aware',
      additionalBundles: ['plugins/dsh-llm-pi-ai-with-session'],
      extraRootEntries: [
        '- id: llm',
        "  name: '@deepseek-ai/dsh-llm'",
        '- id: sessions',
        "  name: '@deepseek-ai/dsh-session'",
        '- id: session-projections',
        "  name: '@deepseek-ai/dsh-session-projection'",
        '- id: agents',
        "  name: '@deepseek-ai/dsh-agent'",
        '- id: agent-loop',
        "  name: '@deepseek-ai/dsh-agent-loop'",
        '  config:',
        '    agents: []',
      ],
      extraPatchEntries: [
        '- id: llm-pi-ai-with-session',
        '  config:',
        '    sessionHeader: x-session-affinity',
        '    routes:',
        '      - route: loopback-session',
        '        source: loopback',
        '    providers:',
        '      loopback:',
        `        apiKeyEnv: ${apiKeyEnvironment}`,
        `        baseURL: ${JSON.stringify(providerUrl)}`,
        '        models:',
        '          - id: loopback-model',
        '            reasoningEfforts: false',
      ],
    })
    profiles.push(profile)
    const loader = profile.ctx.get('loader')
    if (loader === undefined) throw new Error('missing real Loader')
    expect([...loader.entries()].some((entry) =>
      entry.options.name === '@banbolee/dsh-llm-pi-ai-with-session' && !entry.disabled)).toBe(true)
    const llmModule = await loadAnchorModule('dsh-llm') as {
      readonly createUserMessage: (input: unknown) => unknown
    }
    const sessionModule = await loadAnchorModule('dsh-session') as {
      readonly SessionId: (id: string) => unknown
    }
    const ctx = profile.ctx as unknown as AgentLoopContext
    const agent = await ctx.agentLoop.create(
      sessionModule.SessionId('lsp-http-repair'),
      { provider: 'loopback-session', model: 'loopback-model' },
      { cwd: profile.workspace },
    )
    const idle = new Promise<void>((resolve) => {
      const off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') {
          off()
          resolve()
        }
      })
    })

    // When: the real Agent loop drives the real HTTP adapter until its terminal model turn.
    agent.followup(llmModule.createUserMessage({
      content: [{ type: 'text', text: 'repair the TypeScript file' }],
      source: { kind: 'user' },
    }))
    await idle

    // Then: each later response was causally unlocked by prior LSP feedback.
    expect(readFileSync(join(profile.workspace, 'src', 'loopback-repair.ts'), 'utf8'))
      .toBe('const value: number = 2;\n')
    expect(fixture.evidence()).toEqual({
      requestCount: 3,
      acceptedTurnCount: 3,
      rejectedRequestCount: 0,
      headerPresent: true,
      sameSessionEqual: true,
      badWriteIssued: true,
      diagnosticFeedbackSeen: true,
      repairIssued: true,
      cleanFeedbackSeen: true,
      terminalIssued: true,
      repairAfterDiagnostic: true,
      terminalAfterClean: true,
    })
  }, 30_000)
})
