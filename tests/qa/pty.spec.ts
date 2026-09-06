import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  actionCompleted,
  cleanupInjectionState,
  submitInjectedPrompt,
  waitForInjectionSocket,
} from '../../scripts/qa/lib/pty.mjs'

const roots: string[] = []

describe('TUI injection client', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('appends and submits one prompt when the injection socket is ready', async () => {
    // Given: a QA-local Unix socket recording newline-delimited injection messages.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-inject-'))
    roots.push(root)
    const socketPath = join(root, 'session.sock')
    const messages: string[] = []
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => messages.push(chunk.toString()))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    // When: a controlled turn is submitted through the runtime protocol.
    await submitInjectedPrompt(socketPath, 'qa controlled turn')
    await new Promise<void>((resolve) => server.close(() => resolve()))

    // Then: the runtime receives exactly one append and one submit frame.
    expect(messages.join('')).toBe(
      '{"type":"prompt.append","text":"qa controlled turn"}\n'
      + '{"type":"command.execute","command":"prompt.submit"}\n',
    )
  })

  it('ignores a stale first-session record and returns the live second-session socket', async () => {
    // Given: stale discovery state followed by a live QA-owned Unix socket.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-inject-stale-'))
    roots.push(root)
    const injectDir = join(root, 'home', '.dsh-tui', 'inject')
    mkdirSync(injectDir, { recursive: true })
    const stalePath = join(injectDir, 'stale.sock')
    writeFileSync(stalePath, 'not-a-socket')
    const livePath = join(injectDir, 'live.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(livePath, resolve)
    })
    const launchedAt = Date.now()
    writeFileSync(join(injectDir, 'servers.json'), JSON.stringify([
      { pid: 999_999, sessionId: 'stale', cwd: join(root, 'workspace'), socketPath: stalePath, startedAt: launchedAt - 1_000 },
      { pid: process.pid, sessionId: 'live', cwd: join(root, 'workspace'), socketPath: livePath, startedAt: launchedAt },
    ]))

    // When: readiness is resolved for the current PTY ownership set.
    const record = await waitForInjectionSocket({
      environment: { HOME: join(root, 'home'), DSH_TUI_WORKSPACE_TARGET: join(root, 'workspace') },
      ownerPids: new Set([process.pid]),
      launchedAt,
      timeoutMs: 1_000,
    })

    // Then: only the live socket is selected and QA-owned state is cleaned.
    expect(record.sessionId).toBe('live')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanupInjectionState(
      { HOME: join(root, 'home'), DSH_TUI_WORKSPACE_TARGET: join(root, 'workspace') },
      record,
    )
    expect(() => readFileSync(livePath)).toThrow()
  })

  it('retries a transient EINVAL until the Unix socket starts accepting connections', async () => {
    // Given: a stale non-socket path that is atomically replaced by a Unix listener.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-inject-race-'))
    roots.push(root)
    const socketPath = join(root, 'session.sock')
    writeFileSync(socketPath, 'stale')
    const messages: string[] = []
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => messages.push(chunk.toString()))
    })
    const replacement = setTimeout(() => {
      rmSync(socketPath, { force: true })
      server.listen(socketPath)
    }, 25)

    // When: submission encounters EINVAL before the listener is ready.
    await submitInjectedPrompt(socketPath, 'qa second session', { timeoutMs: 1_000 })
    clearTimeout(replacement)
    await new Promise<void>((resolve) => server.close(() => resolve()))

    // Then: the bounded retry submits exactly once to the replacement socket.
    expect(messages.join('')).toContain('"text":"qa second session"')
  })

  it('requires protocol completion and the rendered marker when both are configured', () => {
    // Given: protocol completion before the TUI has rendered its tool result.
    const action = { waitFor: 'qa-tool-ok', completed: () => true }

    // When: action completion is evaluated against a transcript without the marker.
    const beforeRender = actionCompleted(action, 'model finished')
    const afterRender = actionCompleted(action, 'model finished qa-tool-ok')

    // Then: completion waits for both observable facts.
    expect(beforeRender).toBe(false)
    expect(afterRender).toBe(true)
  })
})
