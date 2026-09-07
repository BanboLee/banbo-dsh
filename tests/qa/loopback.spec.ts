import { once } from 'node:events'
import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoopbackServer } from '../../scripts/qa/fixtures/loopback-openai-sse.mjs'

const servers: Array<{ close(callback: (error?: Error) => void): void }> = []

describe('loopback OpenAI SSE fixture', () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    }
  })

  it('records only sanitized affinity facts when requests carry opaque identities', async () => {
    // Given: a loopback fixture and two requests sharing an opaque affinity header.
    const fixture = createLoopbackServer()
    servers.push(fixture.server)
    fixture.server.listen(0, '127.0.0.1')
    await once(fixture.server, 'listening')
    const address = fixture.server.address()
    if (address === null || typeof address === 'string') throw new TypeError('missing loopback address')

    // When: the fixture serves both deterministic requests.
    await sendRequest(address.port, 'opaque-a')
    await sendRequest(address.port, 'opaque-a')

    // Then: evidence contains booleans and terminal status, never raw identity values.
    expect(fixture.evidence()).toEqual({
      requestCount: 2,
      headerPresent: true,
      sameSessionEqual: true,
      differentSessionDifferent: false,
      toolNames: [],
      terminalStatuses: ['tool_calls', 'stop'],
    })
    expect(JSON.stringify(fixture.evidence())).not.toContain('opaque-a')
  })

  it('gates the bounded lsp-repair responses on diagnostic then clean feedback', async () => {
    // Given: the explicit finite LSP repair scenario.
    const fixture = createLoopbackServer({ scenario: 'lsp-repair' })
    servers.push(fixture.server)
    fixture.server.listen(0, '127.0.0.1')
    await once(fixture.server, 'listening')
    const address = fixture.server.address()
    if (address === null || typeof address === 'string') throw new TypeError('missing loopback address')

    // When: feedback is attempted out of order, then supplied in causal order.
    const badWrite = await sendRequest(address.port, 'opaque-lsp', [{ role: 'user', content: 'start' }])
    const prematureRepair = await sendRequest(address.port, 'opaque-lsp', [{
      role: 'user',
      content: '[LSP diagnostics after write]\nStatus: clean',
    }])
    const repairWrite = await sendRequest(address.port, 'opaque-lsp', [{
      role: 'user',
      content: '[LSP diagnostics after write]\ncode="TS2322"',
    }])
    const prematureTerminal = await sendRequest(address.port, 'opaque-lsp', [{
      role: 'user',
      content: '[LSP diagnostics after write]\ncode="TS2322"',
    }])
    const terminal = await sendRequest(address.port, 'opaque-lsp', [{
      role: 'user',
      content: '[LSP diagnostics after write]\nStatus: clean',
    }])

    // Then: only the three causally valid turns are emitted and evidence is aggregate-only.
    expect(badWrite).toMatchObject({ statusCode: 200 })
    expect(badWrite.body).toContain('"name":"write"')
    expect(badWrite.body).toContain('oops')
    expect(prematureRepair.statusCode).toBe(409)
    expect(repairWrite).toMatchObject({ statusCode: 200 })
    expect(repairWrite.body).toContain('"name":"write"')
    expect(repairWrite.body).not.toContain('oops')
    expect(prematureTerminal.statusCode).toBe(409)
    expect(terminal).toMatchObject({ statusCode: 200 })
    expect(terminal.body).toContain('"finish_reason":"stop"')
    expect(terminal.body).not.toContain('"tool_calls"')
    expect(fixture.evidence()).toEqual({
      requestCount: 5,
      acceptedTurnCount: 3,
      rejectedRequestCount: 2,
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
    expect(Object.values(fixture.evidence()).every((value) => typeof value === 'boolean' || typeof value === 'number')).toBe(true)
    expect(JSON.stringify(fixture.evidence())).not.toContain('opaque-lsp')
    expect(JSON.stringify(fixture.evidence())).not.toContain('TS2322')
  })
})

async function sendRequest(
  port: number,
  affinity: string,
  messages: readonly { readonly role: string; readonly content: string }[] = [{ role: 'user', content: 'qa' }],
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'qa-model', messages, stream: true })
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-session-affinity': affinity,
      },
    }, (response) => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { responseBody += chunk })
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: responseBody,
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
