/**
 * Cross-platform pointer replacement safety (§8.6/§8.7).
 *
 * A platform may refuse to rename one directory link over another — Windows
 * answers EPERM for a junction, which is the mechanism the ladder selects there.
 * §8.7's replace step handles that by parking the live pointer, installing the
 * new one, and putting the old one back if the install fails. What this file
 * pins is the invariant behind all of it: **`current` either advances to the new
 * generation or still names the previous one. It is never lost, and a real
 * directory sitting there is never touched.**
 *
 * The pointer is created through `compilePresets` rather than a raw
 * `symlinkSync`, so the test exercises whichever mechanism §8.7 selects on the
 * running platform. A raw symlink needs Developer Mode on Windows, which would
 * have made this file fail in setup — before reaching any pointer code — for a
 * reason that has nothing to do with what it is testing.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scratch: string[] = []
afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

const options = (root: string, id: string) => ({
  rootDir: root,
  templateText: `{{agentId}}-${id}`,
  definitions: [],
  dshVersion: '0.1.5-rc.2',
  selfVersion: '0.0.0',
})

/** Parked pointers are private staging; none may survive an activation. */
const parkedResidue = (generated: string): string[] =>
  readdirSync(generated).filter((name) => name.includes('previous'))

describe('current pointer replacement survives a platform that refuses it', () => {
  it('advances the pointer through the swap when renaming over a link is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'banbo-pointer-atomic-'))
    scratch.push(root)
    const generated = join(root, '.generated')
    const current = join(generated, 'current')

    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>()
      return {
        ...fs,
        renameSync(source: string, destination: string) {
          // Exactly how a junction behaves: replacing a LIVE directory link is
          // refused, while installing one where nothing is is fine.
          if (destination === current && existsSync(current)) {
            throw Object.assign(new Error('rename-over-link unavailable'), { code: 'EPERM' })
          }
          return fs.renameSync(source, destination)
        },
      }
    })
    const { compilePresets } = await import('../preset-compiler.js')

    const first = compilePresets(options(root, 'first') as never)
    const firstLive = resolve(dirname(current), readlinkSync(current))
    expect(firstLive).toBe(resolve(first.generationDir))

    // The replace is refused, so §8.7's swap runs — and it must succeed.
    const second = compilePresets(options(root, 'second') as never)

    expect(existsSync(current), '`current` must never be lost').toBe(true)
    const secondLive = resolve(dirname(current), readlinkSync(current))
    expect(secondLive, 'the pointer must name the new generation').toBe(resolve(second.generationDir))
    expect(secondLive).not.toBe(firstLive)
    // The replaced generation stays on disk: rollback needs it, and a running
    // process may still be reading it.
    expect(existsSync(firstLive)).toBe(true)
    expect(parkedResidue(generated)).toEqual([])
  })

  it('puts the live pointer back when the swap itself cannot install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'banbo-pointer-restore-'))
    scratch.push(root)
    const generated = join(root, '.generated')
    const current = join(generated, 'current')
    // Only the SECOND activation is sabotaged: the first must create the pointer
    // so there is something to preserve.
    let sabotage = false

    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>()
      return {
        ...fs,
        renameSync(source: string, destination: string) {
          if (sabotage && destination === current) {
            throw Object.assign(new Error('refused'), { code: 'EPERM' })
          }
          return fs.renameSync(source, destination)
        },
      }
    })
    const { compilePresets } = await import('../preset-compiler.js')

    compilePresets(options(root, 'first') as never)
    const firstLive = resolve(dirname(current), readlinkSync(current))
    sabotage = true

    expect(() => compilePresets(options(root, 'second') as never)).toThrow(/atomic|rename|EPERM/i)

    expect(existsSync(current), '`current` must never be left absent').toBe(true)
    expect(resolve(dirname(current), readlinkSync(current)), 'the previous generation must stay live').toBe(firstLive)
    expect(parkedResidue(generated), 'no parked pointer may be left behind').toEqual([])
  })

  it('never moves a real directory sitting at `current`', async () => {
    // A directory that is not one of our links is not ours to touch: the
    // refusal must stand rather than the swap relocating someone else's data.
    const root = mkdtempSync(join(tmpdir(), 'banbo-pointer-real-'))
    scratch.push(root)
    const generated = join(root, '.generated')
    const current = join(generated, 'current')
    mkdirSync(current, { recursive: true })
    const marker = join(current, 'not-ours.txt')
    writeFileSync(marker, 'do not move me\n')

    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>()
      return {
        ...fs,
        renameSync(source: string, destination: string) {
          if (destination === current) throw Object.assign(new Error('refused'), { code: 'EPERM' })
          return fs.renameSync(source, destination)
        },
      }
    })
    const { compilePresets } = await import('../preset-compiler.js')

    expect(() => compilePresets(options(root, 'first') as never)).toThrow(/atomic|rename|EPERM|preserved/i)
    expect(existsSync(marker), 'a real directory at `current` must be left untouched').toBe(true)
    expect(parkedResidue(generated)).toEqual([])
  })
})
