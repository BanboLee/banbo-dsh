import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { runExec, runNode } from '../helpers/process'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeRtk = join(root, 'tests/fixtures/fake-rtk.mjs')
const rtkWrapper = join(root, 'tests/fixtures/bin/rtk')

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
