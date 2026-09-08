import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQaLayout } from '../../scripts/qa/lib/environment.mjs'
import {
  readDshWrapperTarget,
  targetTuiPackagePath,
  writeToolWrappers,
} from '../../scripts/qa/lib/profile.mjs'
import { resolveDshInstallationBin } from '../composition/profile-loader'

const roots: string[] = []

describe('QA profile tool wrappers', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('places dsh and pnpm in the allowlisted QA bin when wrappers are rendered', () => {
    // Given: an isolated QA layout and explicit host tool paths.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-profile-'))
    roots.push(root)
    const layout = createQaLayout(root)

    // When: the tool wrappers are created.
    const wrappers = writeToolWrappers(layout, {
      node: '/opt/node26/bin/node',
      dsh: '/opt/node26/bin/dsh',
      pnpm: '/opt/pnpm/bin/pnpm',
    })

    // Then: both child-discoverable wrappers delegate only to explicit paths.
    expect(Object.keys(wrappers).sort()).toEqual(['dsh', 'pnpm'])
    expect(existsSync(wrappers.dsh)).toBe(true)
    expect(existsSync(wrappers.pnpm)).toBe(true)
    expect(readFileSync(wrappers.pnpm, 'utf8')).toContain('exec "/opt/pnpm/bin/pnpm" "$@"')
  })

  it('locates the exact installed target TUI beside the Node 26 global dsh package', () => {
    // Given: the Node 26 global dsh executable path.
    const dsh = '/opt/node26/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'

    // When: the sibling target package path is derived without registry access.
    const target = targetTuiPackagePath(dsh)

    // Then: the target package points at the global scoped dsh-tui install.
    expect(target).toBe('/opt/node26/lib/node_modules/@deepseek-harness-tui/dsh-tui')
  })

  it('recovers the explicit dsh target when a QA wrapper is inspected', () => {
    // Given: a rendered QA wrapper with no ambient path lookup.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-wrapper-'))
    roots.push(root)
    const layout = createQaLayout(root)
    const wrappers = writeToolWrappers(layout, {
      node: '/opt/node26/bin/node',
      dsh: '/opt/node26/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      pnpm: '/opt/pnpm/bin/pnpm',
    })

    // When: the validator resolves its Harness fallback anchor.
    const dsh = readDshWrapperTarget(wrappers.dsh)

    // Then: the exact explicit dsh target is returned.
    expect(dsh).toBe('/opt/node26/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  })

  it('resolves a QA wrapper to the real dsh installation bin when composition tests launch', () => {
    // Given: a QA wrapper whose real target is an installed dsh package.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-composition-'))
    roots.push(root)
    const layout = createQaLayout(root)
    const wrappers = writeToolWrappers(layout, {
      node: '/opt/node26/bin/node',
      dsh: '/opt/node26/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      pnpm: '/opt/pnpm/bin/pnpm',
    })

    // When: the composition-test environment resolves the executable anchor.
    const dsh = resolveDshInstallationBin(wrappers.dsh)

    // Then: the wrapper cannot masquerade as an installation root.
    expect(dsh).toBe('/opt/node26/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  })
})
