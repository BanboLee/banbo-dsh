import { spawn } from 'node:child_process'

export interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

function runProcess(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

export function runNode(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return runProcess(process.execPath, [script, ...args], env)
}

export function runExec(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return runProcess(script, args, env)
}
