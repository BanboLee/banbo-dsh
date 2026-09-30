/**
 * T1 — the bundled terminal tool package must be the version the manifest
 * pins (fish-shell-tty-v3 §5.3 / F8).
 *
 * `@deepseek-ai/dsh-tool-terminal` is a real `dependencies` entry with an
 * EXACT pin and is bundled into the tarball (F1). This suite ties that pin to
 * the copy actually installed in `plugins/fish-shell/node_modules`, so a
 * range, a forgotten version bump, or a tree resolved from another version
 * fails here instead of at publish time. The packed side of the same
 * assertion lives in the T2 tarball lane (`packed-files.spec.ts`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLED_PACKAGE = '@deepseek-ai/dsh-tool-terminal'
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const installedManifestPath = fileURLToPath(new URL(`../node_modules/${BUNDLED_PACKAGE}/package.json`, import.meta.url))

interface Manifest {
  version?: string
  dependencies?: Record<string, string>
  bundledDependencies?: string[]
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

describe('bundled @deepseek-ai/dsh-tool-terminal version', () => {
  it('declares an exact pin and bundles exactly that package', () => {
    const manifest = readManifest(manifestPath)
    const pin = manifest.dependencies?.[BUNDLED_PACKAGE]
    // No `^`/`~`: a range on a prerelease drifts to the newest rc.x, and the
    // installed-version comparison below would stop meaning anything.
    expect(pin).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(manifest.bundledDependencies).toEqual([BUNDLED_PACKAGE])
  })

  it('installs the pinned version inside the plugin’s own node_modules', () => {
    const pin = readManifest(manifestPath).dependencies?.[BUNDLED_PACKAGE]
    expect(pin).toBeDefined()
    // Fail loud rather than skip: the bundled copy is the payload the tarball
    // ships, so a missing install means the packed lane would ship nothing.
    expect(existsSync(installedManifestPath), `${BUNDLED_PACKAGE} is not installed in plugins/fish-shell/node_modules`).toBe(true)
    const installed = readManifest(installedManifestPath)
    expect(installed.version).toBe(pin)
  })
})
