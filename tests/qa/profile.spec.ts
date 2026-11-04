import { execFile, execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createQaLayout } from '../../scripts/qa/lib/environment.mjs'
import {
  TUI_PACKAGE_NAME,
  packageRootFromBin,
  readDshWrapperTarget,
  readOnboardingFixture,
  seedOnboardingFixture,
  stageTuiPackage,
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

  it('derives the dsh-tui package root from the injected launcher instead of a sibling layout', () => {
    // Given: a candidate prefix whose `bin/dsh-tui` is a symlink into its own
    // package — the shape of `npm install --global --prefix /tmp/<prefix>`.
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-launcher-'))
    roots.push(prefix)
    const packageRoot = join(prefix, 'lib', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: TUI_PACKAGE_NAME, version: '0.18.0' }))
    writeFileSync(join(packageRoot, 'bin', 'dsh-tui.js'), '#!/usr/bin/env node\n')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    symlinkSync(
      join('..', 'lib', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'bin', 'dsh-tui.js'),
      join(prefix, 'bin', 'dsh-tui'),
    )

    // When: the package root is derived from the launcher (realpath first).
    const resolved = packageRootFromBin(join(prefix, 'bin', 'dsh-tui'), TUI_PACKAGE_NAME)

    // Then: the launcher's own package is returned, not a path beside some dsh.
    expect(resolved.root).toBe(realpathSync(packageRoot))
    expect(resolved.manifest.name).toBe(TUI_PACKAGE_NAME)
    expect(resolved.manifest.version).toBe('0.18.0')
  })

  it('fails loud when the launcher belongs to a package with another name', () => {
    // Given: a launcher inside a package that is not the requested one.
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-wrong-package-'))
    roots.push(prefix)
    const packageRoot = join(prefix, 'lib', 'node_modules', '@example', 'not-dsh-tui')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@example/not-dsh-tui', version: '1.0.0' }))
    writeFileSync(join(packageRoot, 'bin', 'launcher.js'), '#!/usr/bin/env node\n')

    // When: the requested package root is derived from that launcher.
    const derive = () => packageRootFromBin(join(packageRoot, 'bin', 'launcher.js'), TUI_PACKAGE_NAME)

    // Then: the derivation refuses to guess another install.
    expect(derive).toThrow(/no ancestor package\.json declares that name/)
  })

  it('fails loud when the candidate launcher does not exist', () => {
    // Given/When/Then: a missing launcher is a named setup error, never a fallback.
    expect(() => packageRootFromBin('/nonexistent/bin/dsh-tui', TUI_PACKAGE_NAME))
      .toThrow(/candidate launcher does not exist/)
  })

  it('targets the dsh realpath so dsh-tui 0.18 can follow the launcher to its host package', () => {
    // Given: a candidate prefix whose `bin/dsh` is a symlink to `lib/bin.js` —
    // the shape `dsh-tui 0.18`'s `findHostDsh` follows by its `.js` token.
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-dsh-realpath-'))
    roots.push(prefix)
    const dshPackage = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(dshPackage, 'lib'), { recursive: true })
    writeFileSync(join(dshPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }))
    writeFileSync(join(dshPackage, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    symlinkSync(join('..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), join(prefix, 'bin', 'dsh'))
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-dsh-wrapper-'))
    roots.push(root)
    const layout = createQaLayout(root)

    // When: the QA wrappers are rendered from that launcher.
    const wrappers = writeToolWrappers(layout, {
      node: process.execPath,
      dsh: join(prefix, 'bin', 'dsh'),
      pnpm: '/opt/pnpm/bin/pnpm',
    })

    // Then: the wrapper targets the real package entry, not the prefix symlink.
    expect(readDshWrapperTarget(wrappers.dsh)).toBe(realpathSync(join(dshPackage, 'lib', 'bin.js')))
    expect(readDshWrapperTarget(wrappers.dsh).endsWith('/lib/bin.js')).toBe(true)
  })

  it('seeds the dsh-tui first-run state as a recorded fixture', () => {
    // Given: an empty QA home.
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-onboarding-'))
    roots.push(home)

    // When: the deterministic first-run state is seeded.
    const seeded = seedOnboardingFixture(home)

    // Then: it is written, marked as preseeded, and readable back.
    expect(seeded).toMatchObject({ completed: true, version: 1, preseeded: true })
    expect(existsSync(seeded.path)).toBe(true)
    expect(readOnboardingFixture(home)).toMatchObject({ completed: true, version: 1 })
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

// ── QA packing contract for the installed dsh-tui package ────────────────────

const TUI_PACKAGE = TUI_PACKAGE_NAME
const TUI_HINT = 'install it with `npm install -g @deepseek-harness-tui/dsh-tui@0.18.0` (the package root is derived from the `dsh-tui` launcher on PATH)'

/**
 * The vendored bundles the PUBLISHED manifest curates in its own
 * `bundledDependencies` — read from the INSTALLED manifest at run time.
 *
 * This used to be a hardcoded nine-name list snapshotted from dsh-tui 0.11.2
 * (`@dsh-std/command`, `@dsh-std/connection`, `@dsh-std/core`,
 * `@dsh-std/manifest`, `@dsh-std/messages`, `@dsh-std/presentation`,
 * `@dsh-std/storage`, `@dsh-tui-vendor/mathjax-tex-svg`,
 * `@deepseek-harness-tui/dsh-auth`). That snapshot was never a contract:
 * dsh-tui 0.14.0 dropped `dsh-auth` from its published list, so the lane went
 * red on any machine that follows the real install while proving nothing extra
 * — the invariant the packing path owes is "whatever THIS manifest declares as
 * a published bundle survives the staging", not "0.11.2's list is still true".
 *
 * The QA-specific reason the published half matters at all is unchanged: when a
 * vendored bundle is dropped, the `plugin-host` / `extensions` / `oauth` rows
 * cannot import it, those rows record activation errors, the main `dsh-tui` row
 * stays pending on the services they own, and the QA lanes still look green.
 */
function publishedBundles(manifest: TuiManifest | undefined): readonly string[] {
  return manifest?.bundledDependencies ?? []
}

interface TuiManifest {
  readonly name?: string
  readonly version?: string
  readonly bundledDependencies?: readonly string[]
  readonly dependencies?: Readonly<Record<string, string>>
}

function findExecutableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The dsh-tui package the `dsh-tui` launcher on PATH belongs to. */
function findTargetTuiPackage(): string | undefined {
  const dshTui = findExecutableOnPath('dsh-tui')
  if (dshTui === undefined) return undefined
  try {
    return packageRootFromBin(dshTui, TUI_PACKAGE_NAME).root
  } catch {
    return undefined
  }
}

function isWritableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The union the QA staging promises: published vendored copies + dependencies. */
function expectedBundledUnion(manifest: TuiManifest): readonly string[] {
  return [...new Set([...(manifest.bundledDependencies ?? []), ...Object.keys(manifest.dependencies ?? {})])]
}

const tuiScratch = mkdtempSync(join(tmpdir(), 'banbo-dsh-tui-pack-'))
const tuiStaged = join(tuiScratch, 'staged')
const tuiPacks = join(tuiScratch, 'packs')
const tuiExtracted = join(tuiScratch, 'extracted')
const tuiTarget = findTargetTuiPackage()
/** Why this lane cannot run here; a SKIP with this reason, never a silent pass. */
const tuiUnrunnable = tuiTarget === undefined
  ? `no installed ${TUI_PACKAGE} package was found through the \`dsh-tui\` launcher on PATH — ${TUI_HINT}`
  : undefined

let tuiSourceManifest: TuiManifest | undefined
let tuiPackedManifest: TuiManifest | undefined
let tuiTarballEntries: readonly string[] = []

/**
 * Spawn pnpm the way the fish-shell T2 lane does: asynchronously (a synchronous
 * child would block this worker for the whole pack) and with a writable
 * `PNPM_HOME` (pnpm refuses to start when that variable names an unwritable
 * package-manager directory, which some dev shells do).
 */
function runTuiPnpm(args: readonly string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    // The published dsh-tui package pins `packageManager: pnpm@11.21.0`; the
    // engine manager would try to install that pinned copy (into a store the
    // test does not own) before doing anything else. The pack does not need the
    // pinned engine — the composition lane turns the manager off for the same
    // reason.
    npm_config_manage_package_manager_versions: 'false',
  }
  const home = env['PNPM_HOME']
  if (home === undefined || !isWritableDirectory(home)) env['PNPM_HOME'] = join(tuiScratch, 'pnpm-home')
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'pnpm',
      [...args],
      { cwd: tuiScratch, env, encoding: 'utf8', timeout: 600_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
      (error) => {
        if (error === null) resolvePromise()
        else rejectPromise(error)
      },
    )
  })
}

describe(`QA packing of the installed ${TUI_PACKAGE} package`, () => {
  afterAll(() => {
    rmSync(tuiScratch, { recursive: true, force: true })
  })

  beforeAll(async () => {
    // The installed package is the published artefact: a missing one is a SKIP
    // (spelled out in every test below), but once it is there the pack runs.
    if (tuiTarget === undefined) return
    tuiSourceManifest = JSON.parse(readFileSync(join(tuiTarget, 'package.json'), 'utf8')) as TuiManifest
    mkdirSync(tuiPacks, { recursive: true })

    // `stageTuiPackage` is the helper `packBundles` itself uses, so this lane
    // asserts the QA packing path rather than a copy of it: reverting the
    // union there turns this lane red.
    stageTuiPackage(tuiTarget, tuiStaged)
    await runTuiPnpm([
      '--config.node-linker=hoisted',
      '--config.ignore-scripts=true',
      '--dir', tuiStaged,
      'pack',
      '--pack-destination', tuiPacks,
    ])

    // `pnpm pack --json` is deliberately not used: pnpm 9.3.0 (the CI pin)
    // rejects it, so the tarball is discovered the way `packBundles` does.
    const found = readdirSync(tuiPacks).filter((name) => name.endsWith('.tgz'))
    if (found.length !== 1) {
      throw new Error(`expected exactly one tarball in ${tuiPacks}, found ${found.length}: ${found.join(', ') || '(none)'}`)
    }
    const tarball = join(tuiPacks, found[0] as string)
    tuiTarballEntries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
    mkdirSync(tuiExtracted, { recursive: true })
    execFileSync('tar', ['-xzf', tarball, '-C', tuiExtracted])
    tuiPackedManifest = JSON.parse(
      readFileSync(join(tuiExtracted, 'package', 'package.json'), 'utf8'),
    ) as TuiManifest
  }, 600_000)

  it('packs the published bundled set together with the dependency set', (ctx) => {
    if (tuiUnrunnable !== undefined) ctx.skip(tuiUnrunnable)
    const source = tuiSourceManifest
    const packed = tuiPackedManifest
    if (source === undefined || packed === undefined) throw new Error('the staged dsh-tui tarball was not packed')

    const packagedBundles = [...(packed.bundledDependencies ?? [])].sort()
    const published = publishedBundles(source)
    const dependencies = Object.keys(source.dependencies ?? {})

    // Union, not overwrite: the published list is what makes the vendored rows
    // importable, and the dependency list is what makes the tarball
    // self-contained. Either half alone ships a broken or non-installable tgz.
    expect(packagedBundles).toEqual([...expectedBundledUnion(source)].sort())

    // The two halves as explicit superset invariants, both derived from the
    // source manifest: the packer may add to either set, but it must never drop
    // one. (The installed 0.14.0 manifest declares eight published bundles and
    // 30 dependencies, so neither assertion is vacuous; a future manifest that
    // declares fewer simply narrows the set that has to survive.)
    expect(packagedBundles, "the publisher's bundledDependencies must survive the staging")
      .toEqual(expect.arrayContaining([...published]))
    expect(packagedBundles, 'the regular dependency set must survive the staging')
      .toEqual(expect.arrayContaining(dependencies))

    // That the published half is really IN the artefact, not merely
    // re-declared, is the next test. The dependency half is checked by
    // declaration only: an installer may legitimately skip a dependency for
    // platform reasons, and a bundled dependency that declared a missing file
    // would fail the QA installs loudly anyway.
  })

  it('ships every vendored bundle as a real file inside the tarball', (ctx) => {
    if (tuiUnrunnable !== undefined) ctx.skip(tuiUnrunnable)

    // Derived from the installed manifest, so the check follows the release the
    // machine actually runs instead of one version's list.
    for (const name of publishedBundles(tuiSourceManifest)) {
      const entry = `package/node_modules/${name}/package.json`
      expect(tuiTarballEntries, `${entry} must be listed in the tarball`).toContain(entry)

      // A symlinked (isolated) tree would pack links instead of the package.
      const extracted = join(tuiExtracted, 'package', 'node_modules', name, 'package.json')
      expect(existsSync(extracted), `${extracted} must be extracted from the tarball`).toBe(true)
      expect(lstatSync(extracted).isFile(), `${name} must be a real file, not a symlink`).toBe(true)
    }
  })
})
