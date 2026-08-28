import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service, type Plugin } from '../../plugins/rtk-shell/node_modules/@deepseek-ai/cordis'
import { SandboxProvider } from '../../plugins/rtk-shell/node_modules/@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '../../plugins/rtk-shell/node_modules/@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '../../plugins/rtk-shell/node_modules/@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '../../plugins/rtk-shell/node_modules/@deepseek-ai/dsh-subprocess-local'
import type { ShellRunResult } from '../../plugins/rtk-shell/node_modules/@deepseek-ai/dsh-shell'
import { createIsolatedProfile } from '../helpers/profile'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fakeMcpServer = join(repoRoot, 'tests', 'fixtures', 'fake-mcp-server.mjs')
const fakeRtkBin = join(repoRoot, 'tests', 'fixtures', 'bin')
const yamlParser = pathToFileURL(join(repoRoot, 'plugins', 'codegraph-mcp', 'node_modules', 'yaml', 'browser', 'dist', 'index.js')).href

export interface BootedProfile {
  readonly ctx: Context
  readonly dshHome: string
  readonly profile: string
  readonly shellProviders: () => string[]
  readonly toolNames: () => string[]
  readonly assertHasTool: (name: string) => CompositionTool
  readonly runShell: (command: string) => Promise<ShellRunResult>
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  readonly cleanup: () => Promise<void>
}

interface BundleRow {
  readonly id: string
  readonly name: string
  readonly config: Record<string, unknown>
  readonly disabled: boolean
}

interface YamlModule {
  readonly parse: (source: string) => unknown
}

interface CompositionEnvironment {
  readonly ctx: Context
  readonly shellProviderIds: string[]
  readonly registeredTools: Map<string, CompositionTool>
}

type RtkShellConfig = {
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxOutputBytes: number
  readonly maxSpillBytes: number
  readonly graceMs: number
  readonly rewriteTimeoutMs: number
}

type McpConfig = {
  readonly transport: 'stdio'
  readonly serverName: string
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string>
  readonly cwd: string
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
  readonly reconnect: {
    readonly enabled: boolean
    readonly initialDelayMs: number
    readonly maxDelayMs: number
    readonly maxAttempts: number
  }
}

interface CompositionToolContext {
  readonly signal: AbortSignal
}

interface CompositionTool {
  readonly name: string
  execute(args: unknown, exec: CompositionToolContext): Promise<unknown>
}

class FakeSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(_provider: unknown): () => void {
    return () => undefined
  }

  context(_context: unknown): () => void {
    return () => undefined
  }
}

class FakeTools extends Service {
  readonly registered: Map<string, CompositionTool>

  constructor(ctx: Context, registered: Map<string, CompositionTool>) {
    super(ctx, 'tools')
    this.registered = registered
  }

  register(definition: CompositionTool): () => void {
    this.registered.set(definition.name, definition)
    return () => void this.registered.delete(definition.name)
  }
}

function fakeToolsPlugin(registered: Map<string, CompositionTool>): Plugin.Function {
  return (ctx: Context) => {
    new FakeTools(ctx, registered)
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') throw new Error(`expected string env value for ${key}`)
    result[key] = entry
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected object in profile composition, got ${JSON.stringify(value)}`)
  }
  return value as Record<string, unknown>
}

async function readYaml(file: string): Promise<unknown[]> {
  const yaml = (await import(yamlParser)) as YamlModule
  const parsed = yaml.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`bundle patch ${file} must contain a top-level operation list`)
  return parsed
}

function materializeRows(operations: readonly unknown[]): BundleRow[] {
  const rows = new Map<string, BundleRow>()
  for (const rawOperation of operations) {
    const operation = asRecord(rawOperation)
    if (Array.isArray(operation.insert)) {
      for (const rawRow of operation.insert) {
        const row = asRecord(rawRow)
        const id = String(row.id)
        rows.set(id, {
          id,
          name: String(row.name),
          config: asRecord(row.config ?? {}),
          disabled: row.disabled === true,
        })
      }
      continue
    }
    if (typeof operation.id === 'string') {
      const existing = rows.get(operation.id)
      if (existing === undefined) continue
      rows.set(operation.id, {
        ...existing,
        config: operation.config === undefined ? existing.config : asRecord(operation.config),
        disabled: operation.disabled === true,
      })
    }
  }
  return [...rows.values()].filter((row) => !row.disabled)
}

async function rowsForBundles(bundles: readonly string[]): Promise<BundleRow[]> {
  const operations: unknown[] = []
  for (const bundle of bundles) {
    operations.push(...await readYaml(join(repoRoot, bundle, 'cordis.patch.yml')))
  }
  return materializeRows(operations)
}

class FakeSandboxProvider extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: ['read-only file system', 'permission denied'],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }],
    }
  }
}

async function loadPlugin(row: BundleRow, environment: CompositionEnvironment): Promise<void> {
  switch (row.name) {
    case '@deepseek-ai/dsh-mcp-client': {
      const { apply } = await import('../../plugins/codegraph-mcp/node_modules/@deepseek-ai/dsh-mcp-client')
      const config = {
        ...row.config,
        transport: 'stdio',
        serverName: String(row.config.serverName ?? 'codegraph'),
        command: process.execPath,
        args: [fakeMcpServer],
        env: stringRecord(row.config.env ?? {}),
        cwd: '',
        toolCallTimeoutMs: 5_000,
        failOnStartupError: true,
        reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 1 },
      } satisfies McpConfig
      await apply(environment.ctx, config)
      return
    }
    case 'dsh-rtk-shell': {
      const { default: RtkShellExecutor } = await import('../../plugins/rtk-shell/index.js')
      const plugin = Object.assign((ctx: Context) => {
        new RtkShellExecutor(ctx, config)
      }, { inject: ['subprocess', 'sandbox', 'sandboxPolicy'] })
      const config = {
        cwd: repoRoot,
        timeoutMs: 120_000,
        maxTimeoutMs: 600_000,
        maxOutputBytes: 64_000,
        maxSpillBytes: 64 * 1024 * 1024,
        graceMs: 200,
        rewriteTimeoutMs: 2_000,
      } satisfies RtkShellConfig
      await environment.ctx.plugin(plugin)
      environment.shellProviderIds.push(row.id)
      return
    }
    default:
      throw new Error(`unsupported local bundle row "${row.name}" from ${row.id}`)
  }
}

async function bootComposition(rows: readonly BundleRow[], profile: string): Promise<CompositionEnvironment> {
  const ctx = new Context()
  const registeredTools = new Map<string, CompositionTool>()
  const environment = { ctx, shellProviderIds: [], registeredTools }
  await ctx.plugin(FakeSystemPrompt)
  await ctx.plugin(fakeToolsPlugin(registeredTools))
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: profile })
  await ctx.plugin(LocalSubprocessRuntime)
  for (const row of rows) await loadPlugin(row, environment)
  return environment
}

export async function bootProfileWithBundles(bundles: readonly string[]): Promise<BootedProfile> {
  const previousDshHome = process.env.DSH_HOME
  const previousPath = process.env.PATH
  const previousFakeMode = process.env.FAKE_RTK_MODE
  const isolated = createIsolatedProfile('rtk-codegraph-profile')
  mkdirSync(join(isolated.profile, 'node_modules'), { recursive: true })
  process.env.DSH_HOME = isolated.dshHome
  process.env.PATH = `${fakeRtkBin}:${previousPath ?? ''}`
  process.env.FAKE_RTK_MODE = 'rewrite'
  const rows = await rowsForBundles(bundles)
  const environment = await bootComposition(rows, isolated.profile)
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await environment.ctx.fiber.dispose()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousFakeMode === undefined) delete process.env.FAKE_RTK_MODE
    else process.env.FAKE_RTK_MODE = previousFakeMode
    await isolated.cleanup()
  }
  return {
    ctx: environment.ctx,
    dshHome: isolated.dshHome,
    profile: isolated.profile,
    shellProviders: () => [...environment.shellProviderIds],
    toolNames: () => [...environment.registeredTools.keys()].sort(),
    assertHasTool: (name) => {
      const tool = environment.registeredTools.get(name)
      if (tool === undefined) throw new Error(`missing MCP tool "${name}"`)
      return tool
    },
    runShell: (command) => environment.ctx.shell.run(environment.ctx.shell.resolve({ command })),
    callTool: (name, args) => {
      const tool = environment.registeredTools.get(name)
      if (tool === undefined) return Promise.reject(new Error(`missing MCP tool "${name}"`))
      return tool.execute(args, { signal: new AbortController().signal })
    },
    cleanup,
  }
}
