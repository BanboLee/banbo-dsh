import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { descendantPids } from '../../scripts/qa/lib/pids.mjs'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}))

function procError(code: string) {
  return Object.assign(new Error(code), { code })
}

describe('descendantPids', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue(['101', '102'] as never)
  })

  it('ignores a process that vanishes with ESRCH while its status is read', () => {
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (path === '/proc/101/status') throw procError('ESRCH')
      return 'Name:\tchild\nPPid:\t100\n' as never
    })

    expect(descendantPids(100)).toEqual([102])
  })

  it('does not hide unrelated status read errors', () => {
    const error = procError('EACCES')
    vi.mocked(readFileSync).mockImplementation(() => {
      throw error
    })

    expect(() => descendantPids(100)).toThrow(error)
  })
})
