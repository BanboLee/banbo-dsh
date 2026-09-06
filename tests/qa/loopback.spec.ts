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
})

async function sendRequest(port: number, affinity: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ model: 'qa-model', messages: [{ role: 'user', content: 'qa' }], stream: true })
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
      response.resume()
      response.on('end', resolve)
    })
    req.on('error', reject)
    req.end(body)
  })
}
