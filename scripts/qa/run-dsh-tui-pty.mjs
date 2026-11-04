#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node-pty'
import { parseOptions, requireOption } from './lib/cli.mjs'
import { readQaEnvironment } from './lib/environment.mjs'
import { descendantPids, livingPids, waitForPidsGone } from './lib/pids.mjs'
import {
  assertChatSurface,
  assertOnboardingSeeded,
  wizardMarker,
  writeSubmittedLine,
} from './lib/pty.mjs'
import { profileTuiEntry } from './lib/profile.mjs'
import { resolveNodeForMatrix } from './lib/process.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The two launch paths dsh-tui 0.18 can take, selected explicitly:
 *
 *   - `host-entry` (the 0.18 default) loads DSH in-process as a first-party
 *     backend through the package's own entry;
 *   - `legacy-fallback` sets `DSH_TUI_HOST_ENTRY=0`, which keeps the
 *     `dsh --profile dsh-tui` mount path the 0.16 lane was written for.
 *
 * Both are run — a green host-entry run must not be able to hide a broken
 * legacy path, and vice versa.
 */
const MODES = {
  'host-entry': {},
  'legacy-fallback': { DSH_TUI_HOST_ENTRY: '0' },
}

function stripAnsi(value) {
  return value.replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
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

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('PTY readiness deadline exceeded')
}

function isWithin(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const caseName = requireOption(options, 'case')
  if (caseName !== 'startup') throw new Error(`unsupported PTY case: ${caseName}`)
  const mode = requireOption(options, 'mode')
  if (MODES[mode] === undefined) throw new Error(`--mode must be one of: ${Object.keys(MODES).join(', ')} (got ${mode})`)
  const envFile = resolve(requireOption(options, 'env-file'))
  const matrix = JSON.parse(readFileSync(resolve(requireOption(options, 'matrix')), 'utf8'))
  // The QA home's first-run state is a seeded fixture: the 0.18 wizard's `❯` is
  // not the chat prompt. Failing before spawn keeps a missing fixture honest.
  const environment = { ...readQaEnvironment(envFile), ...MODES[mode] }
  const onboarding = assertOnboardingSeeded(environment)
  // The node is the one on the QA PATH, checked by its REAL --version against
  // the matrix (a path-shaped guess is not a version check).
  const { node, versionOutput: nodeVersion } = await resolveNodeForMatrix(environment.PATH, matrix.nodeMajor)
  // The TUI entry comes from the candidate profile this lane just installed —
  // never from a global installation. Its package version is the matrix's.
  const tui = profileTuiEntry(environment.DSH_HOME, 'dsh-tui')
  if (tui.packageVersion !== matrix.dshTui) {
    throw new Error(`the QA profile installs ${tui.packageName}@${tui.packageVersion}; the matrix requires ${matrix.dshTui}`)
  }
  if (isWithin(tui.entryRealpath, repoRoot)) {
    throw new Error(`the QA profile's TUI entry resolves into the repository: ${tui.entryRealpath}`)
  }
  const pty = spawn(node, [tui.entryPath], {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd: environment.DSH_TUI_WORKSPACE_TARGET,
    env: environment,
  })
  let transcript = ''
  const owned = new Set([pty.pid])
  pty.onData((chunk) => {
    transcript = `${transcript}${chunk}`.slice(-128_000)
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
  })
  try {
    const serversFile = join(environment.HOME, '.dsh-tui', 'inject', 'servers.json')
    // Readiness is `❯` on the CHAT surface: `❯` alone is also the wizard cursor.
    await waitUntil(() => {
      const visible = stripAnsi(transcript)
      if (!visible.includes('❯') || wizardMarker(visible) !== undefined) return false
      try {
        const records = JSON.parse(readFileSync(serversFile, 'utf8'))
        return Array.isArray(records) && records.some((record) => record?.cwd === environment.DSH_TUI_WORKSPACE_TARGET)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
        if (error instanceof SyntaxError) return false
        throw error
      }
    }, 60_000)
    assertChatSurface(stripAnsi(transcript))
    const fallbackNotice = stripAnsi(transcript).includes('cannot host this launch')
    if (mode === 'host-entry' && fallbackNotice) {
      throw new Error('host-entry was requested but dsh-tui fell back to `dsh --profile` (the TUI could not follow the QA dsh launcher to its host package)')
    }
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
    // 0.18 needs the text and the submit key as SEPARATE writes; one combined
    // `/exit\r` chunk opens the command palette and never submits. If the
    // palette consumes the first Enter, a second one shortly after exits.
    await writeSubmittedLine(pty, '/exit')
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
    const clean = await waitForPidsGone([...owned], 5_000)
    if (!clean) throw new Error(`owned PTY processes survived: ${livingPids([...owned]).join(', ')}`)
    // With `DSH_TUI_HOST_ENTRY=0` the launcher takes the legacy branch
    // directly (no fallback notice); otherwise the notice — never its absence
    // alone — is what identifies an unexpected fallback.
    const effectiveMode = environment.DSH_TUI_HOST_ENTRY === '0'
      ? 'legacy-fallback'
      : fallbackNotice ? 'legacy-fallback' : 'host-entry'
    const evidence = {
      case: caseName,
      mode,
      effectiveMode,
      hostEntryEnv: environment.DSH_TUI_HOST_ENTRY ?? null,
      hostEntryNotice: fallbackNotice,
      onboarding: {
        path: onboarding.path,
        completed: onboarding.completed,
        version: onboarding.version,
        preseeded: true,
      },
      readiness: { chatSurface: true, wizardMarker: null, injectionRecord: true },
      inputReady: true,
      exitCode: exit.exitCode,
      processCleanup: clean,
      ownedPidCount: owned.size,
      node: { path: node, version: nodeVersion },
      tui: {
        packageName: tui.packageName,
        packageVersion: tui.packageVersion,
        profileRoot: tui.profileRoot,
        entryPath: tui.entryPath,
        entryRealpath: tui.entryRealpath,
        source: 'candidate-profile',
      },
    }
    writeFileSync(join(dirname(envFile), 'evidence', `g5-pty-${mode}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } catch (error) {
    pty.kill('SIGTERM')
    await waitForPidsGone([...owned], 2_000)
    if (livingPids([...owned]).length > 0) pty.kill('SIGKILL')
    throw error
  } finally {
    transcript = ''
    rmSync(join(dirname(envFile), 'pty-transcript.log'), { force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
