import { cpSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IsolatedProfile } from '../helpers/profile'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const fakeMcpServer = join(repoRoot, 'tests', 'fixtures', 'fake-mcp-server.mjs')
export const fakeRtkBin = join(repoRoot, 'tests', 'fixtures', 'bin')
const profileName = 'rtk-codegraph-profile'

export interface RealProfileProof {
  readonly loader: 'dsh-app-boot'
  readonly profileDir: string
  readonly installedBundles: string[]
  readonly bundlePackageDirs: string[]
  readonly bundlePatchFiles: string[]
}

export interface ShellRunResultLike {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly timeoutMs: number
  readonly stdout: {
    readonly text: string
    readonly truncated: boolean
    readonly spillPath?: string
  }
  readonly stderr: {
    readonly text: string
    readonly truncated: boolean
    readonly spillPath?: string
  }
  readonly sandbox?: {
    readonly mode: string
    readonly denied: boolean
    readonly enforcement?: string
  }
}

interface ShellLike {
  resolve(request: {
    readonly command: string
    readonly workdir?: string
    readonly timeoutMs?: number
    readonly env?: Readonly<Record<string, string>>
    readonly dshEnv?: Readonly<Record<string, string>>
    readonly sandboxPolicy?: {
      readonly mode: string
      readonly workspaceRoot: string
    }
  }): unknown
  run(spec: unknown): Promise<ShellRunResultLike>
}

interface ToolRuntimeLike {
  schemas(): Array<{ readonly name: string }>
  execute(input: { readonly callId: string; readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal }): Promise<{
    readonly isError: boolean
    readonly value?: unknown
    readonly content: readonly {
      readonly type: string
      readonly text?: string
    }[]
    readonly error?: { readonly message: string }
  }>
}

interface LoaderEntryLike {
  readonly id: string
  readonly disabled: boolean
  readonly options: { readonly name: string }
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

export interface BootContext {
  readonly fiber: { dispose(): Promise<void> }
  readonly shell: ShellLike
  get(name: 'tools'): ToolRuntimeLike | undefined
  get(name: 'loader'): LoaderLike | undefined
}

export interface LoadedProfile {
  readonly dir: string
  readonly layers: Array<{ readonly packageName: string; readonly packageDir: string; readonly patchPath: string; readonly patches: unknown[] }>
  readonly patches: unknown[]
}

export interface AppBootModule {
  initProfile(dir: string, bundles: string[]): void
  loadProfile(binName: string, name: string, installAnchor: string, home: string): LoadedProfile
  healProfilesModuleFallback(installAnchor: string, home: string): void
  boot(binName: string, configPath: string, patches: unknown[]): Promise<BootContext>
}

export interface LoadedDshProfile {
  readonly ctx: BootContext
  readonly proof: RealProfileProof
}

export function isAppBootModule(value: unknown): value is AppBootModule {
  if (typeof value !== 'object' || value === null) return false
  const module = value as Partial<Record<keyof AppBootModule, unknown>>
  return typeof module.initProfile === 'function'
    && typeof module.loadProfile === 'function'
    && typeof module.healProfilesModuleFallback === 'function'
    && typeof module.boot === 'function'
}

function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string {
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`${name} not found on PATH`)
}

export async function loadAppBoot(dshBin: string): Promise<{ readonly appBoot: AppBootModule; readonly installAnchor: string }> {
  const packageRoot = dirname(dirname(realpathSync(dshBin)))
  const appBootUrl = pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
  const loaded: unknown = await import(appBootUrl)
  if (!isAppBootModule(loaded)) throw new Error(`invalid dsh-app-boot module at ${appBootUrl}`)
  return { appBoot: loaded, installAnchor: join(packageRoot, 'package.json') }
}

function stageBundle(profile: string, bundle: string): string {
  const source = join(repoRoot, bundle)
  const target = join(profile, 'local-packages', basename(bundle))
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.includes(`${repoRoot}/${bundle}/node_modules`)
      && !path.includes(`${repoRoot}/${bundle}/tests`)
      && !path.endsWith('/tsconfig.json'),
  })
  return `./local-packages/${basename(bundle)}`
}

function installBundles(dshBin: string, dshHome: string, profile: string, bundles: readonly string[]): void {
  const specs = bundles.map((bundle) => stageBundle(profile, bundle))
  const result = spawnSync(dshBin, ['plugin', '--profile', profileName, 'add', '-w', ...specs, '--offline', '--ignore-scripts'], {
    cwd: profile,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`dsh plugin add failed (${result.status ?? 'signal'}):\n${result.stdout}${result.stderr}`)
  }
}

function writeTestRoot(profile: string): string {
  const seams = [
    "import { Service } from '@deepseek-ai/cordis'",
    "import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'",
    "class TestSystemPrompt extends Service { constructor(ctx){ super(ctx, 'systemPrompt') } tools(){ return () => undefined } context(){ return () => undefined } section(){ return () => undefined } }",
    "class TestSandbox extends SandboxProvider { confine(argv){ return { argv: [...argv], enforcement: 'full', denialSignatures: ['permission denied'], runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }] } } }",
    "export default function apply(ctx, config){ if (config.kind === 'systemPrompt') new TestSystemPrompt(ctx); else if (config.kind === 'sandbox') new TestSandbox(ctx); else throw new Error(`unknown test seam ${config.kind}`) }",
  ].join('\n')
  writeFileSync(join(profile, 'test-seams.mjs'), `${seams}\n`)
  const root = join(profile, 'cordis.yml')
  writeFileSync(root, [
    "- id: test-system-prompt\n  name: ./test-seams.mjs\n  config:\n    kind: systemPrompt",
    "- id: tools\n  name: '@deepseek-ai/dsh-tools'\n  config:\n    mode: native",
    "- id: sandbox\n  name: ./test-seams.mjs\n  config:\n    kind: sandbox",
    `- id: sandbox-policy\n  name: '@deepseek-ai/dsh-sandbox-policy'\n  config:\n    mode: read-only\n    workspaceRoot: ${JSON.stringify(profile)}`,
    "- id: subprocess\n  name: '@deepseek-ai/dsh-subprocess-local'",
    "- id: bash-sandbox\n  name: '@deepseek-ai/dsh-bash-sandbox'\n  config:\n    timeoutMs: 60000",
    "- id: shell-env\n  name: '@deepseek-ai/dsh-shell-env'",
  ].join('\n') + '\n')
  return root
}

function writeProfilePatch(profile: string): void {
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: mcp-codegraph',
    '  config:',
    '    serverName: codegraph',
    '    transport: stdio',
    `    command: ${JSON.stringify(process.execPath)}`,
    `    args: [${JSON.stringify(fakeMcpServer)}]`,
    '    env:',
    "      CODEGRAPH_NO_DAEMON: '1'",
    "    cwd: ''",
    '    toolCallTimeoutMs: 5000',
    '    failOnStartupError: true',
    '    reconnect:',
    '      enabled: false',
    '      initialDelayMs: 10',
    '      maxDelayMs: 10',
    '      maxAttempts: 1',
  ].join('\n') + '\n')
}

export async function bootDshProfileWithInstalledBundles(
  bundles: readonly string[],
  isolated: IsolatedProfile,
  dshPath: string | undefined,
): Promise<LoadedDshProfile> {
  const dshBin = findExecutable('dsh', dshPath)
  const { appBoot, installAnchor } = await loadAppBoot(dshBin)
  appBoot.initProfile(isolated.profile, [])
  installBundles(dshBin, isolated.dshHome, isolated.profile, bundles)
  appBoot.healProfilesModuleFallback(installAnchor, isolated.dshHome)
  writeProfilePatch(isolated.profile)
  const rootConfig = writeTestRoot(isolated.profile)
  const profile = appBoot.loadProfile('dsh', profileName, installAnchor, isolated.dshHome)
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]
  const ctx = await appBoot.boot('dsh', rootConfig, patches)
  return {
    ctx,
    proof: {
      loader: 'dsh-app-boot',
      profileDir: profile.dir,
      installedBundles: profile.layers.map((layer) => layer.packageName),
      bundlePackageDirs: profile.layers.map((layer) => layer.packageDir),
      bundlePatchFiles: profile.layers.map((layer) => layer.patchPath),
    },
  }
}
