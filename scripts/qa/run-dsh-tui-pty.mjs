#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node-pty'
import { parseOptions, requireOption } from './lib/cli.mjs'
import { readQaEnvironment } from './lib/environment.mjs'
import { descendantPids, livingPids, waitForPidsGone } from './lib/pids.mjs'

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

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const caseName = requireOption(options, 'case')
  if (caseName !== 'startup') throw new Error(`unsupported PTY case: ${caseName}`)
  const envFile = resolve(requireOption(options, 'env-file'))
  const environment = readQaEnvironment(envFile)
  const tuiBin = join(
    environment.DSH_HOME,
    'profiles',
    'dsh-tui',
    'node_modules',
    '@deepseek-harness-tui',
    'dsh-tui',
    'bin',
    'dsh-tui.js',
  )
  const node = environment.PATH.split(':').map((path) => join(path, 'node'))
    .find((candidate) => {
      try {
        return readFileSync(candidate).length > 0
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return false
        throw error
      }
    })
  if (node === undefined) throw new Error('Node 26 executable is missing from QA PATH')
  const pty = spawn(node, [tuiBin], {
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
    await waitUntil(() => {
      if (!stripAnsi(transcript).includes('❯')) return false
      try {
        const records = JSON.parse(readFileSync(serversFile, 'utf8'))
        return Array.isArray(records) && records.some((record) => record?.cwd === environment.DSH_TUI_WORKSPACE_TARGET)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
        if (error instanceof SyntaxError) return false
        throw error
      }
    }, 60_000)
    for (const pid of descendantPids(pty.pid)) owned.add(pid)
    pty.write('/exit\r')
    const exit = await waitForExit(pty, 30_000)
    if (exit.exitCode !== 0) throw new Error(`TUI exited ${exit.exitCode}`)
    const clean = await waitForPidsGone([...owned], 5_000)
    if (!clean) throw new Error(`owned PTY processes survived: ${livingPids([...owned]).join(', ')}`)
    const evidence = {
      case: caseName,
      inputReady: true,
      exitCode: exit.exitCode,
      processCleanup: clean,
      ownedPidCount: owned.size,
    }
    writeFileSync(join(dirname(envFile), 'evidence', 'g5-pty.json'), `${JSON.stringify(evidence, null, 2)}\n`)
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
