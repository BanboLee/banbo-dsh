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
const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const reExportPath = fileURLToPath(new URL('../tool-terminal.js', import.meta.url))
const toolTerminalUrl = new URL('../tool-terminal.js', import.meta.url).href
const vendoredEntryUrl = new URL(`../node_modules/${BUNDLED_PACKAGE}/lib/index.js`, import.meta.url).href

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

  it('mounts its own copy through the tool-terminal re-export, never the bare name', async () => {
    // 0.2.1 ships `@deepseek-ai/dsh-tool-terminal` in the dsh installation too,
    // and a bare name then resolves to the INSTALLATION copy. The patch must
    // therefore name this package's own handle, and that handle must resolve the
    // dependency from its own position.
    const patch = readFileSync(patchPath, 'utf8')
    expect(patch).toContain("name: '@banbolee/dsh-fish-shell/tool-terminal'")
    expect(patch).not.toMatch(/name:\s*'@deepseek-ai\/dsh-tool-terminal'/)

    const manifest = readManifest(manifestPath) as Manifest & { exports?: Record<string, string> }
    expect(manifest.exports?.['./tool-terminal']).toBe('./tool-terminal.js')

    const reExport = readFileSync(reExportPath, 'utf8')
    expect(reExport).toContain('createRequire(import.meta.url)')
    expect(reExport).toContain("requireFromHere.resolve('@deepseek-ai/dsh-tool-terminal')")

    // The plugin surface is re-exported unchanged: a row naming this subpath must
    // look exactly like a row naming the package itself.
    const reExported = await import(toolTerminalUrl)
    const vendored = await import(vendoredEntryUrl)
    for (const key of ['apply', 'inject', 'name', 'Config']) {
      expect(reExported[key], `re-export lost ${key}`).toBe(vendored[key])
    }
  })
})
