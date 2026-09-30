/**
 * T2 — the published tarball must be exactly the `files` whitelist
 * (fish-shell-tty-v3 §5.3 T2, §2.7, F1).
 *
 * This is the only suite that inspects what the fish-shell bundle really
 * packs, and it does so on a STAGED COPY outside the workspace: bundled
 * dependencies require the hoisted linker for both the install and the pack
 * (`ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED` otherwise), and running
 * that install in the real checkout would resolve against the repository's
 * pnpm workspace — pruning its devDependencies and rewriting its node_modules
 * layout. The copy therefore drops `node_modules/` (its entries are symlinks
 * into the checkout) and the test files; the install recreates real files.
 *
 * The lane needs registry access (or a warm pnpm store) for that install;
 * when it is unavailable the tests skip WITH the reason instead of passing
 * silently. The pack step itself is local and never swallowed: a failure
 * there is a defect (a missing hoisted linker, a bad manifest), not a missing
 * environment.
 */

import { execFile, execFileSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BUNDLED_PACKAGE = '@deepseek-ai/dsh-tool-terminal'
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const scratch = mkdtempSync(join(tmpdir(), 'banbo-fish-packed-'))
const staged = join(scratch, 'staged')
const packs = join(scratch, 'packs')
const extracted = join(scratch, 'extracted')

/** Why this lane cannot run here; set only when the staged install failed. */
let unpackable: string | undefined
/** The packed tarball and its entry list (`package/...` paths). */
let tarball: string | undefined
let entries: string[] | undefined

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function isWritableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * pnpm refuses to start when `PNPM_HOME` is missing or unwritable (a stale
 * path in some dev shells); that variable only holds the global bin, never
 * the store, so pointing it at the scratch directory keeps this lane runnable
 * instead of turning it into a skip.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' }
  const home = env['PNPM_HOME']
  if (home === undefined || !isWritableDirectory(home)) env['PNPM_HOME'] = join(scratch, 'pnpm-home')
  return env
}

/**
 * Spawn pnpm asynchronously: the install can run for tens of seconds on a
 * cold store, and a synchronous child would block this worker's event loop
 * for that whole time — long enough for vitest to report an `onTaskUpdate`
 * RPC timeout (and a non-clean run) even when the install succeeds.
 */
function runPnpm(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'pnpm',
      args,
      { cwd, env: childEnv(), encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout)
          return
        }
        reject(Object.assign(error, { stderr }))
      },
    )
  })
}
/** The tail of a failed child's output, for a readable skip reason. */
function describeFailure(error: unknown): string {
  const output = (error as { stderr?: unknown }).stderr ?? (error as { stdout?: unknown }).stdout
  const text = output === undefined || output === null ? String(error) : String(output)
  return text.trim().split('\n').slice(-3).join(' | ') || String(error)
}

function manifest(): { name?: string, version?: string, files?: string[], dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    files?: string[]
    dependencies?: Record<string, string>
  }
}

/** The tarball content, relative to its root (`package/` stripped). */
function shippedFiles(): string[] {
  if (entries === undefined) throw new Error('the tarball was not packed')
  return entries.map(entry => entry.replace(/^package\//, ''))
}

/** The staged tarball's filename, e.g. `banbolee-dsh-fish-shell-0.7.0.tgz`. */
function tarballName(): string {
  if (tarball === undefined) throw new Error('the tarball was not packed')
  return basename(tarball)
}

beforeAll(async () => {
  mkdirSync(packs, { recursive: true })
  cpSync(pluginRoot, staged, {
    recursive: true,
    filter: entry => basename(entry) !== 'node_modules' && basename(entry) !== 'tests',
  })
  try {
    await runPnpm(['install', '--prod', '--config.node-linker=hoisted', '--config.auto-install-peers=false'], staged)
  } catch (error) {
    unpackable = `pnpm install --prod --config.node-linker=hoisted could not populate the staged copy `
      + `(no registry access or empty pnpm store?): ${describeFailure(error)}`
    return
  }
  // ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED surfaces here if the hoisted
  // linker is dropped from the pack — that is a defect, so it fails the lane.
  const report = JSON.parse(
    await runPnpm(['pack', '--config.node-linker=hoisted', '--json', '--pack-destination', packs], staged),
  ) as { filename: string }
  const tarballPath = isAbsolute(report.filename) ? report.filename : resolve(packs, report.filename)
  tarball = tarballPath
  entries = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }).trim().split('\n')
  mkdirSync(extracted, { recursive: true })
  execFileSync('tar', ['-xzf', tarballPath, '-C', extracted])
}, 600_000)

describe('packed fish-shell tarball', () => {
  it('ships every `files` whitelist entry and nothing else at the top level', (ctx) => {
    if (unpackable !== undefined) ctx.skip(unpackable)
    const { name, version, files } = manifest()
    if (files === undefined) throw new Error('plugins/fish-shell/package.json declares no files whitelist')
    const shipped = shippedFiles()

    // The artifact really is this plugin (pnpm names a scoped package
    // `@banbolee/dsh-fish-shell` as `banbolee-dsh-fish-shell-<version>.tgz`).
    expect(tarballName()).toBe(`${(name ?? '').replace(/^@/, '').replace('/', '-')}-${version}.tgz`)

    for (const entry of files) {
      expect(shipped, `files entry ${entry} is missing from the tarball`).toContain(entry)
    }

    // `package.json` is forced into every tarball by npm/pnpm and is
    // deliberately not in `files`; every other top-level entry must be wanted.
    const allowed = new Set([...files, 'package.json'])
    expect(shipped.filter(file => !file.includes('/')).filter(file => !allowed.has(file))).toEqual([])
  })

  it('bundles the pinned terminal tool as real files inside the tarball', (ctx) => {
    if (unpackable !== undefined) ctx.skip(unpackable)
    const pin = manifest().dependencies?.[BUNDLED_PACKAGE]
    expect(pin).toBeDefined()

    const bundled = join(extracted, 'package', 'node_modules', BUNDLED_PACKAGE)
    expect(existsSync(join(bundled, 'package.json')), `${BUNDLED_PACKAGE} must travel inside the tarball`).toBe(true)
    // The bundled copy must be the real package (a symlinked tree would pack
    // links instead), entry point included.
    expect(existsSync(join(bundled, 'lib', 'index.js')), 'the bundled package must ship its code, not just its manifest').toBe(true)

    const installed = JSON.parse(readFileSync(join(bundled, 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe(pin)
  })
})
