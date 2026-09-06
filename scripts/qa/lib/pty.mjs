import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node-pty'
import { descendantPids, livingPids, waitForPidsGone } from './pids.mjs'

function stripAnsi(value) {
  return value.replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${label} deadline exceeded`)
}

function waitForExit(pty, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY exit deadline exceeded')), timeoutMs)
    pty.onExit((event) => {
      clearTimeout(timer)
      resolve(event)
    })
  })
}

function injectionRecords(environment) {
  try {
    const records = JSON.parse(readFileSync(join(environment.HOME, '.dsh-tui', 'inject', 'servers.json'), 'utf8'))
    return Array.isArray(records) ? records : []
  } catch (error) {
    if (error instanceof SyntaxError) return []
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
  })
}

function transientSocketError(error) {
  return error instanceof Error
    && 'code' in error
    && ['ECONNREFUSED', 'ENOENT', 'EINVAL'].includes(error.code)
}

function socketPathIsReady(socketPath) {
  try {
    return lstatSync(socketPath).isSocket()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export async function waitForInjectionSocket(options) {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    const records = injectionRecords(options.environment)
      .filter((record) => record?.cwd === options.environment.DSH_TUI_WORKSPACE_TARGET)
      .filter((record) => options.ownerPids.has(record.pid))
      .filter((record) => record.startedAt >= options.launchedAt)
      .sort((left, right) => right.startedAt - left.startedAt)
    for (const record of records) {
      if (typeof record.socketPath !== 'string' || !socketPathIsReady(record.socketPath)) continue
      try {
        await connectSocket(record.socketPath)
        return record
      } catch (error) {
        if (!transientSocketError(error)) throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('injection socket readiness deadline exceeded')
}

export async function submitInjectedPrompt(socketPath, text, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection(socketPath)
        socket.once('error', reject)
        socket.once('connect', () => {
          socket.end(
            `${JSON.stringify({ type: 'prompt.append', text })}\n`
            + `${JSON.stringify({ type: 'command.execute', command: 'prompt.submit' })}\n`,
          )
          resolve()
        })
      })
      return
    } catch (error) {
      if (!transientSocketError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`injection socket did not become ready: ${socketPath}`)
}

function isWithin(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

export function cleanupInjectionState(environment, record) {
  const injectDir = resolve(environment.HOME, '.dsh-tui', 'inject')
  if (typeof record.socketPath === 'string' && isWithin(record.socketPath, injectDir)) {
    rmSync(record.socketPath, { force: true })
  }
  const serversFile = join(injectDir, 'servers.json')
  const remaining = injectionRecords(environment).filter((candidate) => (
    candidate?.sessionId !== record.sessionId || candidate?.pid !== record.pid
  ))
  writeFileSync(serversFile, `${JSON.stringify(remaining, null, 2)}\n`)
}

export function actionCompleted(action, transcript) {
  const protocolComplete = action.completed === undefined || action.completed() === true
  const markerVisible = action.waitFor === undefined || transcript.includes(action.waitFor)
  return protocolComplete && markerVisible
}

export async function runTuiSession(options) {
  const tuiBin = join(
    options.environment.DSH_HOME,
    'profiles',
    'dsh-tui',
    'node_modules',
    '@deepseek-harness-tui',
    'dsh-tui',
    'bin',
    'dsh-tui.js',
  )
  const node = options.environment.PATH.split(':').map((path) => join(path, 'node'))
    .find((candidate) => {
      try {
        return readFileSync(candidate).length > 0
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return false
        throw error
      }
    })
  if (node === undefined) throw new Error('Node 26 executable is missing from QA PATH')
  const pty = spawn(node, [tuiBin, ...(options.args ?? [])], {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd: options.environment.DSH_TUI_WORKSPACE_TARGET,
    env: options.environment,
  })
  const launchedAt = Date.now()
  let transcript = ''
  const owned = new Set([pty.pid])
  let record
  pty.onData((chunk) => {
    transcript = `${transcript}${chunk}`.slice(-256_000)
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
  })
  try {
    await waitUntil(() => stripAnsi(transcript).includes('❯'), 60_000, 'PTY readiness')
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
    record = await waitForInjectionSocket({
      environment: options.environment,
      ownerPids: owned,
      launchedAt,
      timeoutMs: 10_000,
    })
    if (typeof record.sessionId !== 'string') throw new Error('PTY injection identity is unavailable')
    for (const action of options.actions ?? []) {
      if (action.prompt !== undefined) await submitInjectedPrompt(record.socketPath, action.prompt)
      else pty.write(action.input)
      if (action.waitFor !== undefined || action.completed !== undefined) {
        await waitUntil(
          () => actionCompleted(action, stripAnsi(transcript)),
          action.timeoutMs ?? 60_000,
          action.waitFor ?? 'PTY action',
        )
      }
    }
    if (options.exit !== false) {
      pty.write('/exit\r')
      const exit = await waitForExit(pty, 30_000)
      if (exit.exitCode !== 0) throw new Error(`TUI exited ${exit.exitCode}`)
    }
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
    const clean = await waitForPidsGone([...owned], 5_000)
    if (!clean) throw new Error(`owned PTY processes survived: ${livingPids([...owned]).join(', ')}`)
    return {
      cleanTranscript: stripAnsi(transcript),
      resumeToken: record.sessionId,
      processCleanup: clean,
      ownedPidCount: owned.size,
    }
  } catch (error) {
    pty.kill('SIGTERM')
    await waitForPidsGone([...owned], 2_000)
    if (livingPids([...owned]).length > 0) pty.kill('SIGKILL')
    throw error
  } finally {
    if (record !== undefined) cleanupInjectionState(options.environment, record)
    transcript = ''
  }
}
