/**
 * Stage 5 packed-artifact lane — docs/agents-plugin-plan.md §16 阶段 5.
 *
 * This is the only suite that inspects what `npm pack` actually publishes. It
 * runs the real `npm pack`, asserts the exact published surface (build outputs
 * in, sources/tests/build config out), then imports the EXTRACTED tarball in a
 * fresh Node process so "the packed package works" is observed rather than
 * inferred from the working tree.
 *
 * The build itself stays a separate step (`node scripts/build.mjs`); this suite
 * consumes its output and fails loudly when `lib/` is missing.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'banbo-packed-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The manifest whitelist entries that MUST be real files in the tarball. */
const REQUIRED_ENTRIES = [
  'package/index.js',
  'package/schema.js',
  'package/identity.js',
  'package/catalog.js',
  'package/prompt-loader.js',
  'package/preset-compiler.js',
  'package/tool-surface.js',
  'package/settings-policy.js',
  'package/main-runtime.js',
  'package/delegation.js',
  'package/budget.js',
  'package/holder-registry.js',
  'package/cordis.patch.yml',
  'package/lib/catalog-remote.js',
  'package/lib/client.js',
  'package/lib/typert.host.js',
  'package/lib/typert.host.d.ts',
  'package/lib/typert.remote-client.js',
  'package/lib/typert.remote-client.d.ts',
  'package/lib/types/catalog-remote.d.ts',
  'package/lib/types/client/index.d.ts',
]

/** Sources and build config must never ship. */
const FORBIDDEN_ENTRIES = [
  'package/src/',
  'package/tests/',
  'package/scripts/',
  'package/tsconfig',
  'package/tsdown',
  'package/node_modules/',
]

let packResult: { filename: string, files: string[] } | undefined

function pack(): { filename: string, files: string[] } {
  if (packResult !== undefined) return packResult
  const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], {
    cwd: pluginRoot,
    encoding: 'utf8',
  })
  const parsed = JSON.parse(stdout) as Array<{ filename: string, files: Array<{ path: string }> }>
  const first = parsed[0]
  if (first === undefined) throw new Error('npm pack produced no result')
  packResult = { filename: join(scratch, first.filename), files: first.files.map((file) => `package/${file.path}`) }
  return packResult
}

async function importFromTarball(entry: string): Promise<string[]> {
  const { filename } = pack()
  const extractRoot = mkdtempSync(join(pluginRoot, '.packed-import-'))
  try {
    execFileSync('tar', ['-xzf', filename, '-C', extractRoot])
    const script = join(extractRoot, 'probe.mjs')
    writeFileSync(script, [
      `const mod = await import(${JSON.stringify(join(extractRoot, 'package', entry))})`,
      'console.log(JSON.stringify(Object.keys(mod).sort()))',
    ].join('\n'))
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    return JSON.parse(stdout) as string[]
  } finally {
    rmSync(extractRoot, { recursive: true, force: true })
  }
}

describe('packed tarball surface', () => {
  it('ships every declared build output and no source or build config', () => {
    const { files } = pack()
    expect(files).toEqual(expect.arrayContaining(REQUIRED_ENTRIES))
    for (const forbidden of FORBIDDEN_ENTRIES) {
      expect(files.some((file) => file.startsWith(forbidden)), `${forbidden} must not ship`).toBe(false)
    }
    // The whitelist must not hide a missing build: every `lib/**` file the
    // exports map points at has to be inside the tarball.
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string } | string>
    }
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const path = typeof target === 'string' ? target : target.default
      expect(files, `exports["${subpath}"] -> ${path}`).toContain(`package/${path.replace(/^\.\//, '')}`)
    }
  })

  it('ships every module the published entry points import', () => {
    // The `files` whitelist is manual, so adding a new runtime module and
    // forgetting to list it produces a package that installs and then fails at
    // import time. Walking the relative imports of every shipped root module
    // makes that class of mistake impossible to publish.
    const { files } = pack()
    const shipped = new Set(files)
    const localImport = /from\s+'(\.\/[^']+)'/g
    const rootModules = files.filter((file) => /^package\/[^/]+\.js$/.test(file))
    expect(rootModules.length).toBeGreaterThan(5)

    for (const file of rootModules) {
      const relative = file.replace(/^package\//, '')
      const source = readFileSync(join(pluginRoot, relative), 'utf8')
      for (const match of source.matchAll(localImport)) {
        const target = normalize(join(dirname(relative), match[1]!)).replace(/\\/g, '/')
        expect(shipped, `${relative} imports ${match[1]} which the tarball does not contain`).toContain(`package/${target}`)
      }
    }
  })

  it('contains byte-identical copies of the built Host and client artifacts', () => {
    const { filename } = pack()
    const extractRoot = mkdtempSync(join(pluginRoot, '.packed-identical-'))
    try {
      execFileSync('tar', ['-xzf', filename, '-C', extractRoot])
      for (const relative of ['lib/client.js', 'lib/catalog-remote.js', 'lib/typert.host.js', 'lib/typert.remote-client.js']) {
        expect(
          readFileSync(join(extractRoot, 'package', relative)).equals(readFileSync(join(pluginRoot, relative))),
          `${relative} must be the built file`,
        ).toBe(true)
      }
    } finally {
      rmSync(extractRoot, { recursive: true, force: true })
    }
  })
})

describe('packed package imports as pure ESM', () => {
  it('exposes the Host entry, the generated typert descriptor, and the client factory', async () => {
    expect(existsSync(join(pluginRoot, 'lib', 'client.js')), 'run `node scripts/build.mjs` first').toBe(true)
    const host = await importFromTarball('index.js')
    expect(host).toEqual(expect.arrayContaining([
      'default', 'name', 'inject', 'Config', 'initialiseCatalog', 'verifyRosterRoots',
    ]))

    const typert = await importFromTarball('lib/typert.host.js')
    expect(typert).toContain('TYPERT')

    const client = await importFromTarball('lib/typert.remote-client.js')
    expect(client).toContain('TYPERT_REMOTE')
  })

  it('registers the client as a classic ModuleLoader factory with no CJS interop', () => {
    const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
    expect(source).toContain('__ModuleLoader__')
    expect(source).toContain('load(')
    expect(source).toMatch(/factory/)
    expect(source).not.toContain('require("@banbolee/dsh-agents/remote")')
  })
})
