import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fakeRtk = join(root, 'tests/fixtures/fake-rtk.mjs')
const rtkWrapper = join(root, 'tests/fixtures/bin/rtk')
const fakeMcp = join(root, 'tests/fixtures/fake-mcp-server.mjs')
const planHygiene = join(root, 'tests/verify-plan-hygiene.mjs')
const taskEvidence = join(root, 'tests/verify-task-evidence.mjs')
const realPlan = join(root, '.omo/plans/rtk-codegraph-dsh-plugins.md')

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Run `node <script> [args...]` to completion with the given extra env. */
function runNode(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

/** Run an executable script directly (honoring its shebang) to completion. */
function runExec(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

describe('fake-rtk.mjs', () => {
  const cases: Array<{
    mode: string
    expectedCode: number
    expectedStdout: string
  }> = [
    { mode: 'rewrite', expectedCode: 0, expectedStdout: 'rtk git status' },
    { mode: 'passthrough', expectedCode: 1, expectedStdout: 'git status' },
    { mode: 'deny', expectedCode: 2, expectedStdout: '' },
    { mode: 'ask', expectedCode: 3, expectedStdout: 'rtk git status' },
  ]

  for (const { mode, expectedCode, expectedStdout } of cases) {
    it(`mode ${mode} exits ${expectedCode} and prints the deterministic output`, async () => {
      const result = await runNode(fakeRtk, ['rewrite', 'git status'], { FAKE_RTK_MODE: mode })
      expect(result.stdout.trim()).toBe(expectedStdout)
      expect(result.code).toBe(expectedCode)
    })
  }

  it('mode rewrite matches the plan acceptance command exactly', async () => {
    const result = await runNode(fakeRtk, ['rewrite', 'git status'], { FAKE_RTK_MODE: 'rewrite' })
    expect(result.stdout.trim()).toBe('rtk git status')
    expect(result.code).toBe(0)
  })

  it('mode malformed prints non-command garbage and exits 0', async () => {
    const result = await runNode(fakeRtk, ['rewrite', 'git status'], { FAKE_RTK_MODE: 'malformed' })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).not.toBe('rtk git status')
    expect(result.stdout.trim()).not.toBe('git status')
  })

  it('mode timeout hangs and must be killed externally', async () => {
    const child = spawn(process.execPath, [fakeRtk, 'rewrite', 'git status'], {
      env: { ...process.env, FAKE_RTK_MODE: 'timeout' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let exited = false
    child.on('close', () => { exited = true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(exited).toBe(false)
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('close', resolve))
    expect(exited).toBe(true)
  })

  it('mode rewrite joins multi-arg commands with spaces', async () => {
    const result = await runNode(fakeRtk, ['rewrite', 'git', 'status'], { FAKE_RTK_MODE: 'rewrite' })
    expect(result.stdout.trim()).toBe('rtk git status')
  })

  it('fails loudly when FAKE_RTK_MODE is unset', async () => {
    const result = await runNode(fakeRtk, ['rewrite', 'git status'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/FAKE_RTK_MODE/)
  })
})

describe('tests/fixtures/bin/rtk wrapper', () => {
  it('delegates to fake-rtk.mjs so PATH prepending works', async () => {
    const result = await runExec(rtkWrapper, ['rewrite', 'git status'], { FAKE_RTK_MODE: 'rewrite' })
    expect(result.stdout.trim()).toBe('rtk git status')
    expect(result.code).toBe(0)
  })

  it('propagates deny exit code through the wrapper', async () => {
    const result = await runExec(rtkWrapper, ['rewrite', 'rm -rf /tmp/x'], { FAKE_RTK_MODE: 'deny' })
    expect(result.code).toBe(2)
  })
})

describe('fake-mcp-server.mjs', () => {
  function connectMcp(): { child: ChildProcess; request(req: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void } {
    const child = spawn(process.execPath, [fakeMcp], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    const pending: Array<(line: string) => void> = []
    child.stdout.on('data', (chunk: Buffer) => {
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
            try { resolve(JSON.parse(line) as Record<string, unknown>) } catch (error) { reject(error) }
          })
          child.stdin.write(`${JSON.stringify(req)}\n`)
        })
      },
      close() {
        child.kill()
      },
    }
  }

  it('lists the echo_context tool through stdio MCP', async () => {
    const mcp = connectMcp()
    try {
      await mcp.request({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness-test', version: '0.0.0' } },
      })
      const listed = await mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }
      const names = listed.result.tools.map((tool) => tool.name)
      expect(names).toContain('echo_context')
    } finally {
      mcp.close()
    }
  })

  it('calls echo_context and returns the deterministic codegraph-ok text', async () => {
    const mcp = connectMcp()
    try {
      await mcp.request({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness-test', version: '0.0.0' } },
      })
      const called = await mcp.request({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'echo_context', arguments: {} },
      }) as { result: { content: Array<{ type: string; text: string }> } }
      expect(called.result.content[0].text).toBe('codegraph-ok')
    } finally {
      mcp.close()
    }
  })

  it('returns an isError result for an unknown tool', async () => {
    const mcp = connectMcp()
    try {
      await mcp.request({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness-test', version: '0.0.0' } },
      })
      const called = await mcp.request({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      }) as { result: { isError: boolean } }
      expect(called.result.isError).toBe(true)
    } finally {
      mcp.close()
    }
  })
})

describe('createIsolatedProfile', () => {
  it('creates a temp dshHome and profile under the OS temp dir and cleans them up', async () => {
    const { createIsolatedProfile } = await import('./helpers/profile')
    const { dshHome, profile, cleanup } = createIsolatedProfile('harness-profile-test')
    expect(dshHome.startsWith(tmpdir())).toBe(true)
    expect(profile.startsWith(dshHome)).toBe(true)
    expect(existsSync(dshHome)).toBe(true)
    expect(existsSync(profile)).toBe(true)
    await cleanup()
    expect(existsSync(dshHome)).toBe(false)
  })

  it('cleanup is idempotent', async () => {
    const { createIsolatedProfile } = await import('./helpers/profile')
    const { dshHome, cleanup } = createIsolatedProfile('harness-profile-idempotent')
    await cleanup()
    await cleanup()
    expect(existsSync(dshHome)).toBe(false)
  })
})

describe('verify-plan-hygiene.mjs', () => {
  it('passes on the real plan file', async () => {
    const result = await runNode(planHygiene, [realPlan])
    expect(result.code).toBe(0)
  }, 30000)

  it('fails on a plan missing required per-task fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-bad-'))
    try {
      const broken = join(dir, 'broken.md')
      writeFileSync(broken, [
        '# Broken plan',
        '',
        '## Todos',
        '',
        '- [ ] 1. Missing everything after the title',
        '  What to do / Must NOT do: whatever',
        '',
        '## Success criteria',
        '',
        '- done',
      ].join('\n'))
      const result = await runNode(planHygiene, [broken])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when a forbidden placeholder token appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-hygiene-todo-'))
    try {
      const broken = join(dir, 'todo.md')
      const body = `${'## Todos\n\n- [ ] 1. Some task\n'}\n  What to do / Must NOT do: finish me TODO\n`
      writeFileSync(broken, body)
      const result = await runNode(planHygiene, [broken])
      expect(result.code).not.toBe(0)
      expect(result.stdout).toMatch(/TODO/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verify-task-evidence.mjs', () => {
  const karpathyHeadings = [
    '## Assumptions',
    '## Simplest sufficient approach',
    '## Changed files',
    '## No speculative abstraction',
    '## Surgical scope confirmation',
  ]

  function writeValidTask(dir: string, n: number) {
    const taskDir = join(dir, `task-${n}`)
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'tdd-red.log'), 'RED ran\n')
    writeFileSync(join(taskDir, 'tdd-green.log'), 'GREEN ran\n')
    writeFileSync(join(taskDir, 'karpathy.md'), karpathyHeadings.join('\n\n') + '\n')
  }

  it('passes on a valid evidence root for task 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-ok-'))
    try {
      writeValidTask(dir, 1)
      const result = await runNode(taskEvidence, [dir, '1'])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts tdd-not-applicable.md for task 8 with the exact sentence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-t8-'))
    try {
      const taskDir = join(dir, 'task-8')
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(join(taskDir, 'tdd-not-applicable.md'), 'no implementation change; TDD not applicable\n')
      writeFileSync(join(taskDir, 'karpathy.md'), karpathyHeadings.join('\n\n') + '\n')
      const result = await runNode(taskEvidence, [dir, '8'])
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when tdd evidence and karpathy headings are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-missing-'))
    try {
      const taskDir = join(dir, 'task-1')
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(join(taskDir, 'karpathy.md'), '## Assumptions\n\n## Wrong heading\n')
      const result = await runNode(taskEvidence, [dir, '1'])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when the evidence directory does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-absent-'))
    try {
      const result = await runNode(taskEvidence, [dir, '99'])
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
