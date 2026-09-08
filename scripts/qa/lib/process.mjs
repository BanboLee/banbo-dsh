import { spawn } from 'node:child_process'

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
