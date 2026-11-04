import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node-pty'
import { descendantPids, livingPids, waitForPidsGone } from './pids.mjs'
import { readOnboardingFixture } from './profile.mjs'

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

/**
 * The dsh-tui first-run wizard, in both locales the TUI ships.
 *
 * `❯` alone is NOT a readiness signal on dsh-tui 0.18: the wizard draws the
 * same cursor, and a lane that accepts it as the chat prompt sends its commands
 * into the wizard (where they are swallowed). Readiness is therefore `❯` on the
 * CHAT surface — the assertions below are a tightening, not a relaxation.
 */
const WIZARD_PATTERNS = [
  /Welcome to dsh-TUI/i,
  /Step\s+\d+\s+of\s+\d+/i,
  /欢迎使用\s*dsh-TUI/i,
  /第\s*\d+\s*\/\s*\d+\s*步/,
]

/** The first wizard marker found in a stripped transcript, or `undefined`. */
export function wizardMarker(transcript) {
  for (const pattern of WIZARD_PATTERNS) {
    const match = pattern.exec(transcript)
    if (match !== null) return match[0]
  }
  return undefined
}

/** Fail loud when the PTY is sitting in the first-run wizard rather than chat. */
export function assertChatSurface(transcript) {
  const marker = wizardMarker(transcript)
  if (marker !== undefined) {
    throw new Error(`the TUI is on its first-run wizard ("${marker}"), not the chat surface; the QA home must carry .dsh-tui/onboarding.json with completed=true`)
  }
}

/**
 * The onboarding fixture must exist before a TUI is launched; a missing one
 * would render the wizard and every later readiness check would be a lie.
 */
export function assertOnboardingSeeded(environment) {
  const record = readOnboardingFixture(environment.HOME)
  if (record === undefined || record.completed !== true) {
    throw new Error(`the QA home does not carry the preseeded first-run state (${join(environment.HOME, '.dsh-tui', 'onboarding.json')} completed=true); dsh-tui 0.18 would render its onboarding wizard instead of the chat surface`)
  }
  return record
}

/**
 * Text and its submit key MUST be separate PTY writes on dsh-tui 0.18: one
 * combined `"/cmd\\r"` chunk opens the command palette but does not submit the
 * command (verified: split writes exit cleanly, a single write times out).
 */
export function writeSubmittedLine(pty, text, delayMs = 250) {
  pty.write(text)
  return new Promise((resolveDelay) => {
    setTimeout(() => {
      pty.write('\r')
      resolveDelay()
    }, delayMs)
  })
}

/**
 * Launch one real TUI session.
 *
 * `options.node` and `options.tui` are resolved by the caller
 * (`run-dsh-tui-real.mjs`): the node is the QA-PATH one whose real `--version`
 * matched the matrix, and the TUI entry is the candidate profile's own
 * installation. Guessing either from a path shape is what this contract
 * removes.
 */
export async function runTuiSession(options) {
  const tuiBin = options.tui?.entryPath
  if (typeof tuiBin !== 'string' || tuiBin.length === 0) {
    throw new Error('runTuiSession requires the candidate profile TUI entry (options.tui.entryPath)')
  }
  if (typeof options.node !== 'string' || options.node.length === 0) {
    throw new Error('runTuiSession requires the matrix-checked node (options.node)')
  }
  // Fail before spawning: without the fixture the 0.18 TUI opens its wizard.
  assertOnboardingSeeded(options.environment)
  const pty = spawn(options.node, [tuiBin, ...(options.args ?? [])], {
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
    // `❯` on the CHAT surface only: the wizard draws the same cursor.
    await waitUntil(() => {
      const visible = stripAnsi(transcript)
      return visible.includes('❯') && wizardMarker(visible) === undefined
    }, 60_000, 'PTY readiness')
    assertChatSurface(stripAnsi(transcript))
    // G6 exercises the default 0.18 launch path: the in-process host entry.
    // A fallback to `dsh --profile` is a lane/launcher defect, not a pass.
    if (stripAnsi(transcript).includes('cannot host this launch')) {
      throw new Error('dsh-tui fell back to `dsh --profile`; G6 must exercise the default host-entry path (the QA dsh wrapper must point at the candidate\'s lib/bin.js)')
    }
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
    record = await waitForInjectionSocket({
      environment: options.environment,
      ownerPids: owned,
      launchedAt,
      timeoutMs: 10_000,
    })
    if (typeof record.sessionId !== 'string') throw new Error('PTY injection identity is unavailable')
    // A fresh session's channel exists before its runtime session settles; an
    // injected prompt sent into that window is dropped (no request is made).
    // Sessions that first run a `/preset` command are warm by the time they are
    // prompted, so give every session the same short settle.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    for (const action of options.actions ?? []) {
      if (action.prompt !== undefined) await submitInjectedPrompt(record.socketPath, action.prompt)
      else if (action.input.endsWith('\r')) {
        const text = action.input.slice(0, -1)
        pty.write(text)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
        pty.write('\r')
        // dsh-tui 0.18 opens a command-completion palette while the text is
        // typed; for a multi-word command the first Enter ACCEPTS the
        // completion and only the next one submits. Send the second Enter only
        // when the expected marker has not appeared, so a completed action is
        // never submitted twice.
        if ((action.waitFor !== undefined || action.completed !== undefined)
          && !actionCompleted(action, stripAnsi(transcript))) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
          pty.write('\r')
        }
      } else pty.write(action.input)
      if (action.waitFor !== undefined || action.completed !== undefined) {
        await waitUntil(
          () => actionCompleted(action, stripAnsi(transcript)),
          action.timeoutMs ?? 60_000,
          action.waitFor ?? 'PTY action',
        )
      }
    }
    if (options.exit !== false) {
      // The preset switch (and the controlled turn's final render) keeps the
      // composer busy for a moment after the last marker; `/exit` typed into
      // that window is dropped. Let the screen settle first.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
      await writeSubmittedLine(pty, '/exit')
      // The completion palette can consume the first Enter (multi-word commands
      // earlier in the session leave the composer in a palette state); one more
      // Enter shortly after makes the exit command deterministic.
      const retry = setTimeout(() => {
        try { pty.write('\r') } catch { /* the process is already gone */ }
      }, 1_500)
      let exit
      try {
        exit = await waitForExit(pty, 30_000)
      } finally {
        clearTimeout(retry)
      }
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
    // Name the session in the failure: four PTY sessions run per G6, and an
    // anonymous "deadline exceeded" cannot be attributed.
    if (options.label !== undefined && error instanceof Error) {
      error.message = `${options.label}: ${error.message}`
    }
    throw error
  } finally {
    if (record !== undefined) cleanupInjectionState(options.environment, record)
    transcript = ''
  }
}
