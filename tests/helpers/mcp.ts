import { spawn, type ChildProcess } from 'node:child_process'

export interface McpConnection {
  readonly child: ChildProcess
  readonly request: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
  close(): void
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function connectMcp(script: string): McpConnection {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = child.stdout
  const stdin = child.stdin
  if (!stdout || !stdin) {
    throw new Error('MCP process must expose stdio pipes')
  }
  let buffer = ''
  const pending: Array<(line: string) => void> = []
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        const resolve = pending.shift()
        resolve?.(line)
      }
    }
  })
  return {
    child,
    request(req) {
      return new Promise((resolve, reject) => {
        pending.push((line) => {
          try {
            const value: unknown = JSON.parse(line)
            if (isRecord(value)) {
              resolve(value)
              return
            }
            reject(new Error('MCP response must be a JSON object'))
          } catch (error) {
            reject(error)
          }
        })
        stdin.write(`${JSON.stringify(req)}\n`)
      })
    },
    close() {
      child.kill()
    },
  }
}
