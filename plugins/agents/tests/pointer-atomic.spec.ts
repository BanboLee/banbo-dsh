/**
 * Cross-platform pointer replacement safety (§8.6/§8.7).
 *
 * Windows may refuse rename-over-link with EPERM. That must fail while the old
 * pointer remains intact; unlinking it before creating a replacement opens the
 * exact missing-root window the immutable-generation design forbids.
 */

import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scratch: string[] = []
afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

describe('current pointer replacement is atomic or fails closed', () => {
  it('preserves the old pointer when rename-over-link is unsupported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'banbo-pointer-atomic-'))
    scratch.push(root)
    const generated = join(root, '.generated')
    const oldGeneration = join(generated, 'generations', 'old')
    mkdirSync(oldGeneration, { recursive: true })
    writeFileSync(join(oldGeneration, 'complete'), '{}\n')
    symlinkSync(oldGeneration, join(generated, 'current'))

    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>()
      return {
        ...fs,
        renameSync(source: string, destination: string) {
          if (destination === join(generated, 'current')) {
            const error = Object.assign(new Error('rename-over-link unavailable'), { code: 'EPERM' })
            throw error
          }
          return fs.renameSync(source, destination)
        },
      }
    })
    const { compilePresets } = await import('../preset-compiler.js')

    expect(() => compilePresets({
      rootDir: root,
      templateText: '{{agentId}}',
      definitions: [],
      dshVersion: '0.1.5-rc.2',
      selfVersion: '0.0.0',
    })).toThrow(/atomic|rename|EPERM/i)

    const current = join(generated, 'current')
    expect(resolve(dirname(current), readlinkSync(current))).toBe(resolve(oldGeneration))
  })
})
