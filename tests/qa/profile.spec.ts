import { execFile, execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createQaLayout } from '../../scripts/qa/lib/environment.mjs'
import {
  readDshWrapperTarget,
  stageTuiPackage,
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

// ── QA packing contract for the global dsh-tui installation ──────────────────

const TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui'
const TUI_HINT = 'install it beside the global dsh CLI with `npm install -g @deepseek-harness-tui/dsh-tui@0.11.2`'

/**
 * The vendored bundles the PUBLISHED `@deepseek-harness-tui/dsh-tui` manifest
 * curates in its own `bundledDependencies` (dsh-tui 0.11.2): the `@dsh-std/*`
 * set, the mathjax renderer vendor copy and the bundled subscription-auth
 * package. The QA staging has to keep every one of them inside the tarball —
 * when it does not, the `plugin-host` / `extensions` / `oauth` rows cannot
 * import them, their rows record activation errors and the main `dsh-tui` row
 * stays pending on the services they own while the QA lanes still look green.
 */
const PUBLISHED_VENDORED_BUNDLES = [
  '@dsh-std/command',
  '@dsh-std/connection',
  '@dsh-std/core',
  '@dsh-std/manifest',
  '@dsh-std/messages',
  '@dsh-std/presentation',
  '@dsh-std/storage',
  '@dsh-tui-vendor/mathjax-tex-svg',
  '@deepseek-harness-tui/dsh-auth',
] as const

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

/** The global dsh-tui package `targetTuiPackagePath` resolves beside `dsh`. */
function findTargetTuiPackage(): string | undefined {
  const dsh = findExecutableOnPath('dsh')
  if (dsh === undefined) return undefined
  try {
    const candidate = targetTuiPackagePath(realpathSync(dsh))
    return existsSync(join(candidate, 'package.json')) ? candidate : undefined
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
  ? `the global ${TUI_PACKAGE} package is missing beside the global \`dsh\` CLI — ${TUI_HINT}`
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

describe(`QA packing of the global ${TUI_PACKAGE} installation`, () => {
  afterAll(() => {
    rmSync(tuiScratch, { recursive: true, force: true })
  })

  beforeAll(async () => {
    // The global package is the published artefact: a missing one is a SKIP
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

    // Union, not overwrite: the published list is what makes the vendored rows
    // importable, and the dependency list is what makes the tarball
    // self-contained. Either half alone ships a broken or non-installable tgz.
    expect(packagedBundles).toEqual([...expectedBundledUnion(source)].sort())

    // And the published half is really there, not merely re-declared.
    for (const name of PUBLISHED_VENDORED_BUNDLES) {
      expect(packagedBundles, `${name} must stay in the packed bundledDependencies`).toContain(name)
    }
  })

  it('ships every vendored bundle as a real file inside the tarball', (ctx) => {
    if (tuiUnrunnable !== undefined) ctx.skip(tuiUnrunnable)

    for (const name of PUBLISHED_VENDORED_BUNDLES) {
      const entry = `package/node_modules/${name}/package.json`
      expect(tuiTarballEntries, `${entry} must be listed in the tarball`).toContain(entry)

      // A symlinked (isolated) tree would pack links instead of the package.
      const extracted = join(tuiExtracted, 'package', 'node_modules', name, 'package.json')
      expect(existsSync(extracted), `${extracted} must be extracted from the tarball`).toBe(true)
      expect(lstatSync(extracted).isFile(), `${name} must be a real file, not a symlink`).toBe(true)
    }
  })
})
