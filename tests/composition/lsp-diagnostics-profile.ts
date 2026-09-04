import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createIsolatedProfile, type IsolatedProfile } from '../helpers/profile'
import {
  loadAppBoot,
  type BootContext,
  type LoadedProfile,
  type RealProfileProof,
} from './profile-loader'

/**
 * Compose a real DSH app for the lsp-diagnostics plugin, mirroring the
 * rtk/codegraph profile composition but with a test-only root config that
 * mounts the official filesystem tools and points the plugin's language
 * servers at the deterministic fake LSP server fixture.
 *
 * This helper only creates the isolated profile, installs the local bundle
 * through the real `dsh plugin` CLI, writes the test-only root config plus
 * the profile patch that overrides the plugin's server commands, boots via
 * the real dsh-app-boot Loader, and cleans up. It never modifies any
 * early-owner file.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FAKE_LSP_SERVER = join(repoRoot, 'tests', 'fixtures', 'fake-lsp-server.mjs')

const profileName = 'lsp-diagnostics-profile'
const LSP_BUNDLE = 'plugins/dsh-lsp-diagnostics'

/** Fake LSP server modes understood by `tests/fixtures/fake-lsp-server.mjs`. */
export type FakeLspMode =
  | 'push-versioned'
  | 'push-versionless'
  | 'clean'
  | 'content-aware'
  | 'two-batches'
  | 'continuous'
  | 'delayed-old'
  | 'cross-uri-same-version'
  | 'cross-uri-future-version'
  | 'cross-uri-malformed-diagnostics'
  | 'strict-diagnostic'
  | 'diagnostic-standard-optionals'
  | 'diagnostic-unknown-extension'
  | 'diagnostic-invalid-consumed-field'
  | 'diagnostic-controls'
  | 'timeout'
  | 'hang-initialize'
  | 'crash'
  | 'malformed'
  | 'server-requests'
  | 'close-stdin-after-diagnostics'
  | 'hang-shutdown'
  | 'graceful-order'

export interface LspDiagnosticsBootOptions {
  /** Fake LSP server mode used by the `typescript` provider. Defaults to `push-versioned`. */
  readonly typescriptMode?: FakeLspMode
  /** Fake LSP server mode used by the `go` provider. Defaults to `clean`. */
  readonly goMode?: FakeLspMode
  /** Plugin `enabled` config; `false` must produce zero runtime/listeners/processes. Defaults to `true`. */
  readonly enabled?: boolean
  /** Plugin `timeoutMs` (composition tests use small values for fast fail-open coverage). */
  readonly timeoutMs?: number
  /** Plugin `settleMs`. */
  readonly settleMs?: number
  /** Plugin `maxDocumentBytes` (document too large coverage). */
  readonly maxDocumentBytes?: number
  /** Plugin aggregate diagnostic-count cap. */
  readonly maxDiagnostics?: number
  /** Plugin aggregate Unicode code-point character cap. */
  readonly maxResultChars?: number
  /** Plugin graceful shutdown budget. */
  readonly shutdownTimeoutMs?: number
  /** Subprocess TERM→KILL grace. */
  readonly killGraceMs?: number
  /** Extra YAML root-config entries (agent loop services, code runtime, etc.). */
  readonly extraRootEntries?: readonly string[]
  /**
   * The `dsh-tools` presentation mode; `code` is required for the run_code
   * matrix (the installed 0.1.1-rc.2 enum is `native | code | both`; the
   * newer `ptc` alias is normalized to `code`).
   */
  readonly toolsMode?: 'native' | 'code' | 'ptc'
  /** When true, point the typescript server at a nonexistent executable (server not found coverage). */
  readonly missingTypescript?: boolean
  /** When true, point the Go server at a nonexistent executable. */
  readonly missingGo?: boolean
}

export interface LspDiagnosticsBooted {
  readonly ctx: BootContext
  readonly dshHome: string
  /** The isolated profile directory (also the DSH profile root). */
  readonly profile: string
  /** The session workspace directory inside the profile (agent session cwd). */
  readonly workspace: string
  /** Protocol log written by the typescript fake LSP server (empty until it spawns). */
  readonly typescriptLog: string
  /** Protocol log written by the go fake LSP server (empty until it spawns). */
  readonly goLog: string
  readonly proof: RealProfileProof
  readonly cleanup: () => Promise<void>
}

function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string {
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`${name} not found on PATH`)
}

function stageBundle(profile: string): string {
  const source = join(repoRoot, LSP_BUNDLE)
  const target = join(profile, 'local-packages', basename(LSP_BUNDLE))
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.includes(`${repoRoot}/${LSP_BUNDLE}/node_modules`)
      && !path.includes(`${repoRoot}/${LSP_BUNDLE}/tests`)
      && !path.endsWith('/tsconfig.json'),
  })
  return `./local-packages/${basename(LSP_BUNDLE)}`
}

function installBundle(dshBin: string, dshHome: string, profile: string): void {
  const spec = stageBundle(profile)
  const result = spawnSync(
    dshBin,
    ['plugin', '--profile', profileName, 'add', '-w', spec, '--offline', '--ignore-scripts'],
    { cwd: profile, env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`dsh plugin add failed (${result.status ?? 'signal'}):\n${result.stdout}${result.stderr}`)
  }
}

/** Root config entries shared by every lsp-diagnostics composition app. */
function baseRootEntries(toolsMode: 'native' | 'code' | 'ptc', workspace: string): string[] {
  const mode = toolsMode === 'ptc' ? 'code' : toolsMode
  return [
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '  config:',
    `    mode: ${mode}`,
    '- id: fs',
    "  name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(workspace)}`,
    '- id: subprocess',
    "  name: '@deepseek-ai/dsh-subprocess-local'",
    '- id: tool-fs',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '- id: editor',
    "  name: '@deepseek-ai/dsh-tool-str-replace-editor'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
  ]
}

function writeProfilePatch(profile: string, options: LspDiagnosticsBootOptions, logs: { typescript: string, go: string }): void {
  const typescriptCommand = options.missingTypescript === true
    ? join(profile, 'missing-language-server')
    : process.execPath
  const typescriptArgs = options.missingTypescript === true
    ? []
    : [FAKE_LSP_SERVER, options.typescriptMode ?? 'push-versioned', logs.typescript]
  const goCommand = options.missingGo === true ? join(profile, 'missing-go-language-server') : process.execPath
  const goArgs = options.missingGo === true
    ? []
    : [FAKE_LSP_SERVER, options.goMode ?? 'clean', logs.go]
  const lines = [
    '- id: lsp-diagnostics',
    '  config:',
    `    enabled: ${options.enabled ?? true}`,
    `    timeoutMs: ${options.timeoutMs ?? 2000}`,
    `    settleMs: ${options.settleMs ?? 100}`,
    `    shutdownTimeoutMs: ${options.shutdownTimeoutMs ?? 1_000}`,
    `    killGraceMs: ${options.killGraceMs ?? 500}`,
    `    maxDocumentBytes: ${options.maxDocumentBytes ?? 2_097_152}`,
    `    maxDiagnostics: ${options.maxDiagnostics ?? 50}`,
    `    maxResultChars: ${options.maxResultChars ?? 8_000}`,
    '    servers:',
    '      typescript:',
    `        command: ${JSON.stringify(typescriptCommand)}`,
    ...(typescriptArgs.length === 0
      ? ['        args: []']
      : ['        args:', ...typescriptArgs.map((arg) => `          - ${JSON.stringify(arg)}`)]),
    '        env: {}',
    '      go:',
    `        command: ${JSON.stringify(goCommand)}`,
    ...(goArgs.length === 0
      ? ['        args: []']
      : ['        args:', ...goArgs.map((arg) => `          - ${JSON.stringify(arg)}`)]),
    '        env: {}',
  ]
  writeFileSync(join(profile, 'cordis.patch.yml'), `${lines.join('\n')}\n`)
}

function writeTestRoot(profile: string, options: LspDiagnosticsBootOptions, workspace: string): string {
  const entries = [...baseRootEntries(options.toolsMode ?? 'native', workspace)]
  if (options.extraRootEntries !== undefined) entries.push(...options.extraRootEntries)
  const root = join(profile, 'cordis.yml')
  writeFileSync(root, `${entries.join('\n')}\n`)
  return root
}

function restoreEnvironment(snapshot: {
  readonly dshHome?: string
  readonly xdgConfigHome?: string
}): void {
  if (snapshot.dshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = snapshot.dshHome
  if (snapshot.xdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = snapshot.xdgConfigHome
}

/**
 * Boot one real DSH app with the lsp-diagnostics bundle installed and the
 * plugin pointed at the fake LSP server. Returns the booted context plus the
 * isolated workspace and the fake-server protocol logs; `cleanup()` disposes
 * the fiber and removes the whole temporary tree.
 */
export async function bootLspDiagnosticsProfile(
  options: LspDiagnosticsBootOptions = {},
): Promise<LspDiagnosticsBooted> {
  const previousEnv = {
    dshHome: process.env.DSH_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  }
  const isolated: IsolatedProfile = createIsolatedProfile(profileName)
  process.env.DSH_HOME = isolated.dshHome
  process.env.XDG_CONFIG_HOME = join(isolated.dshHome, '.config')
  const workspace = join(isolated.profile, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const typescriptLog = join(isolated.profile, 'typescript-server.log')
  const goLog = join(isolated.profile, 'go-server.log')
  let ctx: BootContext | undefined
  let proof: RealProfileProof | undefined
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    let cleanupError: unknown
    try {
      await ctx?.fiber.dispose()
    } catch (error) {
      cleanupError = error
    }
    try {
      await isolated.cleanup()
    } catch (error) {
      cleanupError ??= error
    } finally {
      restoreEnvironment(previousEnv)
    }
    if (cleanupError !== undefined) throw cleanupError
  }
  try {
    const dshBin = findExecutable('dsh')
    const { appBoot, installAnchor } = await loadAppBoot(dshBin)
    appBoot.initProfile(isolated.profile, [])
    installBundle(dshBin, isolated.dshHome, isolated.profile)
    appBoot.healProfilesModuleFallback(installAnchor, isolated.dshHome)
    writeProfilePatch(isolated.profile, options, { typescript: typescriptLog, go: goLog })
    const rootConfig = writeTestRoot(isolated.profile, options, workspace)
    const profile: LoadedProfile = appBoot.loadProfile('dsh', profileName, installAnchor, isolated.dshHome)
    const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]
    ctx = await appBoot.boot('dsh', rootConfig, patches)
    proof = {
      loader: 'dsh-app-boot',
      profileDir: profile.dir,
      installedBundles: profile.layers.map((layer) => layer.packageName),
      bundlePackageDirs: profile.layers.map((layer) => layer.packageDir),
      bundlePatchFiles: profile.layers.map((layer) => layer.patchPath),
    }
    return {
      ctx,
      dshHome: isolated.dshHome,
      profile: isolated.profile,
      workspace,
      typescriptLog,
      goLog,
      proof,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * Resolve a `@deepseek-ai/*` package entry point from the dsh install anchor,
 * so composition tests can construct deterministic mock adapters against the
 * exact module instance the booted app uses.
 */
export async function loadAnchorModule(packageName: string): Promise<unknown> {
  const dshBin = findExecutable('dsh')
  const packageRoot = dirname(dirname(realpathSync(dshBin)))
  const moduleUrl = pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', packageName, 'lib', 'index.js')).href
  return import(moduleUrl)
}
