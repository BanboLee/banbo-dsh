import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createIsolatedProfile } from '../helpers/profile'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fakeMcpServer = join(repoRoot, 'tests', 'fixtures', 'fake-mcp-server.mjs')
const fakeRtkBin = join(repoRoot, 'tests', 'fixtures', 'bin')
const profileName = 'rtk-codegraph-profile'
const shellProviderNames = new Set(['dsh-rtk-shell', '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-bash-local'])

interface EnvSnapshot {
  readonly dshHome?: string
  readonly path?: string
  readonly fakeMode?: string
}

export interface BootedProfile {
  readonly ctx: BootContext
  readonly dshHome: string
  readonly profile: string
  readonly realProfilePath: () => RealProfileProof
  readonly shellProviders: () => string[]
  readonly toolNames: () => string[]
  readonly assertHasTool: (name: string) => void
  readonly runShell: (command: string) => Promise<ShellRunResultLike>
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  readonly cleanup: () => Promise<void>
}

export interface RealProfileProof {
  readonly loader: 'dsh-app-boot'
  readonly profileDir: string
  readonly installedBundles: string[]
  readonly bundlePackageDirs: string[]
  readonly bundlePatchFiles: string[]
}

interface ShellRunResultLike {
  readonly stdout: { readonly text: string }
  readonly stderr: { readonly text: string }
}

interface ShellLike {
  resolve(request: { readonly command: string }): unknown
  run(spec: unknown): Promise<ShellRunResultLike>
}

interface ToolRuntimeLike {
  schemas(): Array<{ readonly name: string }>
  execute(input: { readonly callId: string; readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal }): Promise<{
    readonly isError: boolean
    readonly value?: unknown
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

interface BootContext {
  readonly fiber: { dispose(): Promise<void> }
  readonly shell: ShellLike
  get(name: 'tools'): ToolRuntimeLike | undefined
  get(name: 'loader'): LoaderLike | undefined
}

interface LoadedProfile {
  readonly dir: string
  readonly layers: Array<{ readonly packageName: string; readonly packageDir: string; readonly patchPath: string; readonly patches: unknown[] }>
  readonly patches: unknown[]
}

interface AppBootModule {
  initProfile(dir: string, bundles: string[]): void
  loadProfile(binName: string, name: string, installAnchor: string, home: string): LoadedProfile
  healProfilesModuleFallback(installAnchor: string, home: string): void
  boot(binName: string, configPath: string, patches: unknown[]): Promise<BootContext>
}

function isAppBootModule(value: unknown): value is AppBootModule {
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

async function loadAppBoot(dshBin: string): Promise<{ readonly appBoot: AppBootModule; readonly installAnchor: string }> {
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

function fakeMcpProcessCount(): number {
  if (!existsSync('/proc')) return 0
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
    try {
      return readFileSync(join('/proc', pid, 'cmdline'), 'utf8').includes(fakeMcpServer)
    } catch {
      return false
    }
  }).length
}

function restoreEnvironment(snapshot: EnvSnapshot): void {
  if (snapshot.dshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = snapshot.dshHome
  if (snapshot.path === undefined) delete process.env.PATH
  else process.env.PATH = snapshot.path
  if (snapshot.fakeMode === undefined) delete process.env.FAKE_RTK_MODE
  else process.env.FAKE_RTK_MODE = snapshot.fakeMode
}

export async function waitForNoFakeMcpServer(): Promise<void> {
  const deadline = Date.now() + 1_000
  while (fakeMcpProcessCount() > 0) {
    if (Date.now() > deadline) throw new Error('fake MCP server process still running after profile cleanup')
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

export async function bootProfileWithBundles(bundles: readonly string[]): Promise<BootedProfile> {
  const previousEnv = {
    dshHome: process.env.DSH_HOME,
    path: process.env.PATH,
    fakeMode: process.env.FAKE_RTK_MODE,
  } satisfies EnvSnapshot
  const dshBin = findExecutable('dsh', previousEnv.path)
  const { appBoot, installAnchor } = await loadAppBoot(dshBin)
  const isolated = createIsolatedProfile(profileName)
  process.env.DSH_HOME = isolated.dshHome
  process.env.PATH = `${fakeRtkBin}:${previousEnv.path ?? ''}`
  process.env.FAKE_RTK_MODE = 'rewrite'
  let ctx: BootContext | undefined
  let profile: LoadedProfile | undefined
  try {
    appBoot.initProfile(isolated.profile, [])
    installBundles(dshBin, isolated.dshHome, isolated.profile, bundles)
    appBoot.healProfilesModuleFallback(installAnchor, isolated.dshHome)
    writeProfilePatch(isolated.profile)
    const rootConfig = writeTestRoot(isolated.profile)
    profile = appBoot.loadProfile('dsh', profileName, installAnchor, isolated.dshHome)
    const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]
    ctx = await appBoot.boot('dsh', rootConfig, patches)
  } catch (error) {
    try {
      await ctx?.fiber.dispose()
      restoreEnvironment(previousEnv)
      await isolated.cleanup()
    } catch {
      restoreEnvironment(previousEnv)
      await isolated.cleanup()
    }
    throw error
  }
  const proof = {
    loader: 'dsh-app-boot',
    profileDir: profile.dir,
    installedBundles: profile.layers.map((layer) => layer.packageName),
    bundlePackageDirs: profile.layers.map((layer) => layer.packageDir),
    bundlePatchFiles: profile.layers.map((layer) => layer.patchPath),
  } satisfies RealProfileProof
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await ctx.fiber.dispose()
    restoreEnvironment(previousEnv)
    await isolated.cleanup()
  }
  return {
    ctx,
    dshHome: isolated.dshHome,
    profile: isolated.profile,
    realProfilePath: () => proof,
    shellProviders: () => {
      const loader = ctx.get('loader')
      if (loader === undefined) return []
      return [...loader.entries()]
        .filter((entry) => !entry.disabled && shellProviderNames.has(entry.options.name))
        .map((entry) => entry.id.split(':').at(-1) ?? entry.id)
        .sort()
    },
    toolNames: () => ctx.get('tools')?.schemas().map((schema) => schema.name).sort() ?? [],
    assertHasTool: (name) => {
      if (!ctx.get('tools')?.schemas().some((schema) => schema.name === name)) throw new Error(`missing MCP tool "${name}"`)
    },
    runShell: (command) => ctx.shell.run(ctx.shell.resolve({ command })),
    callTool: async (name, args) => {
      const result = await ctx.get('tools')?.execute({
        callId: `composition-${name}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
      if (result === undefined) throw new Error('missing tools runtime')
      if (result.isError) throw new Error(result.error?.message ?? `tool ${name} failed`)
      return result.value
    },
    cleanup,
  }
}
