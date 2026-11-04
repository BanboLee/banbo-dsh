import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class QaProcessError extends Error {
  name = 'QaProcessError'

  constructor(command, code, output) {
    super(`${command} exited ${code}\n${output}`)
    this.code = code
    this.output = output
  }
}

export function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ code, signal, output, pid: child.pid })
        return
      }
      reject(new QaProcessError(`${command} ${args.join(' ')}`, code ?? signal ?? 'unknown', output))
    })
  })
}

/** The first `<directory>/<name>` on `pathValue` that exists (no PATH execution). */
export function findExecutableOnPath(name, pathValue = process.env.PATH ?? '') {
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the node on a QA PATH and check its REAL `--version` against the
 * matrix's `nodeMajor`.
 *
 * Path sniffing (`candidate.includes('/v26.')`) used to stand in for a version
 * check: it accepted any launcher whose path happened to contain that string and
 * could not describe an externally installed candidate at all. The matrix is the
 * authority, and the observed version is returned so evidence can record it.
 */
export async function resolveNodeForMatrix(pathValue, nodeMajor) {
  if (!Number.isInteger(nodeMajor) || nodeMajor <= 0) {
    throw new Error(`matrix nodeMajor must be a positive integer: ${String(nodeMajor)}`)
  }
  const node = findExecutableOnPath('node', pathValue)
  if (node === undefined) throw new Error(`no node executable is on the QA PATH: ${pathValue}`)
  const versionOutput = (await runChild(node, ['--version'], { cwd: dirname(node), env: process.env })).output.trim()
  if (!versionOutput.startsWith(`v${nodeMajor}.`)) {
    throw new Error(`the QA PATH node is ${versionOutput} (${node}); the matrix requires v${nodeMajor}.x`)
  }
  return { node, versionOutput }
}
