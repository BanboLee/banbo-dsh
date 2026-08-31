import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { runExec, runNode } from '../helpers/process'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeRtk = join(root, 'tests/fixtures/fake-rtk.mjs')
const rtkWrapper = join(root, 'tests/fixtures/bin/rtk')

// Spawn the fake rtk with piped stdin so `pipe` subcommand tests can feed input.
function runNodeWithStdin(
  script: string,
  args: readonly string[],
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.end(input)
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
    child.on('close', () => {
      exited = true
    })
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

describe('fake-rtk.mjs pipe subcommand', () => {
  it('mode compress prints the deterministic compressed output and exits 0', async () => {
    const result = await runNodeWithStdin(fakeRtk, ['pipe', '-f', 'grep'], 'a\nb\n', {
      FAKE_RTK_PIPE_MODE: 'compress',
    })
    expect(result.stdout).toBe('[fake-rtk pipe -f grep] compressed 2 lines\n')
    expect(result.code).toBe(0)
  })

  it('mode compress defaults the filter to grep when -f is absent', async () => {
    const result = await runNodeWithStdin(fakeRtk, ['pipe'], 'a\nb\n', { FAKE_RTK_PIPE_MODE: 'compress' })
    expect(result.stdout).toBe('[fake-rtk pipe -f grep] compressed 2 lines\n')
    expect(result.code).toBe(0)
  })

  it('mode compress counts only non-empty stdin lines', async () => {
    const result = await runNodeWithStdin(fakeRtk, ['pipe', '-f', 'grep'], 'a\n\nb\n\n', {
      FAKE_RTK_PIPE_MODE: 'compress',
    })
    expect(result.stdout).toBe('[fake-rtk pipe -f grep] compressed 2 lines\n')
    expect(result.code).toBe(0)
  })

  it('mode passthrough echoes stdin byte-for-byte and exits 0', async () => {
    const input = 'a\nb\n'
    const result = await runNodeWithStdin(fakeRtk, ['pipe', '-f', 'grep'], input, {
      FAKE_RTK_PIPE_MODE: 'passthrough',
    })
    expect(result.stdout).toBe(input)
    expect(result.code).toBe(0)
  })

  it('mode deny writes the denial to stderr and exits 2', async () => {
    const result = await runNodeWithStdin(fakeRtk, ['pipe', '-f', 'rm'], 'a\nb\n', {
      FAKE_RTK_PIPE_MODE: 'deny',
    })
    expect(result.stderr).toBe('fake-rtk pipe: denied by rule: rm\n')
    expect(result.code).toBe(2)
  })

  it('mode timeout hangs and must be killed externally', async () => {
    const child = spawn(process.execPath, [fakeRtk, 'pipe', '-f', 'grep'], {
      env: { ...process.env, FAKE_RTK_PIPE_MODE: 'timeout' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end('a\nb\n')
    let exited = false
    child.on('close', () => {
      exited = true
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(exited).toBe(false)
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('close', resolve))
    expect(exited).toBe(true)
  })

  it('fails loudly when FAKE_RTK_PIPE_MODE is unset', async () => {
    const result = await runNodeWithStdin(fakeRtk, ['pipe', '-f', 'grep'], 'a\nb\n')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/FAKE_RTK_PIPE_MODE must be one of compress, passthrough, deny, timeout \(got: unset\)/)
  })

  it('fails loudly on an invalid FAKE_RTK_PIPE_MODE', async () => {
    const result = await runNodeWithStdin(fakeRtk, ['pipe', '-f', 'grep'], 'a\nb\n', {
      FAKE_RTK_PIPE_MODE: 'bogus',
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/got: bogus/)
  })

  it('unsupported subcommand message lists both rewrite and pipe', async () => {
    const result = await runNode(fakeRtk, ['frobnicate'], { FAKE_RTK_MODE: 'rewrite' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('only "rewrite" and "pipe"')
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
