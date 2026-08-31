import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createIsolatedProfile, type IsolatedProfile } from '../helpers/profile'
import {
  bootDshProfileWithInstalledBundles,
  fakeMcpServer,
  fakeRtkBin,
  type BootContext,
  type LoadedDshProfile,
  type RealProfileProof,
  type ShellRunResultLike,
} from './profile-loader'

const profileName = 'rtk-codegraph-profile'
const shellProviderNames = new Set(['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-bash-local', 'dsh-fish-shell'])
let isolatedProfileFactory: (name: string) => IsolatedProfile = createIsolatedProfile

interface EnvSnapshot {
  readonly dshHome?: string
  readonly path?: string
  readonly fakeMode?: string
  readonly xdgConfigHome?: string
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
  if (snapshot.xdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = snapshot.xdgConfigHome
}

async function cleanupSetupFailure(ctx: BootContext | undefined, isolated: IsolatedProfile, snapshot: EnvSnapshot): Promise<void> {
  try {
    await ctx?.fiber.dispose()
  } catch {}
  try {
    await isolated.cleanup()
  } catch {}
  restoreEnvironment(snapshot)
}

async function cleanupReturnedProfile(ctx: BootContext, isolated: IsolatedProfile, snapshot: EnvSnapshot): Promise<void> {
  let cleanupError: unknown
  try {
    await ctx.fiber.dispose()
  } catch (error) {
    cleanupError = error
  }
  try {
    await isolated.cleanup()
  } catch (error) {
    cleanupError ??= error
  } finally {
    restoreEnvironment(snapshot)
  }
  if (cleanupError instanceof Error) throw cleanupError
  if (cleanupError !== undefined) throw new Error(String(cleanupError))
}

export async function waitForNoFakeMcpServer(): Promise<void> {
  const deadline = Date.now() + 1_000
  while (fakeMcpProcessCount() > 0) {
    if (Date.now() > deadline) throw new Error('fake MCP server process still running after profile cleanup')
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

export function setIsolatedProfileFactoryForTest(factory: (name: string) => IsolatedProfile): () => void {
  const previous = isolatedProfileFactory
  isolatedProfileFactory = factory
  return () => {
    isolatedProfileFactory = previous
  }
}

export async function bootProfileWithBundles(bundles: readonly string[]): Promise<BootedProfile> {
  const previousEnv = {
    dshHome: process.env.DSH_HOME,
    path: process.env.PATH,
    fakeMode: process.env.FAKE_RTK_MODE,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  } satisfies EnvSnapshot
  const isolated = isolatedProfileFactory(profileName)
  process.env.DSH_HOME = isolated.dshHome
  process.env.XDG_CONFIG_HOME = join(isolated.dshHome, '.config')
  process.env.PATH = `${fakeRtkBin}:${previousEnv.path ?? ''}`
  process.env.FAKE_RTK_MODE = 'rewrite'
  let ctx: BootContext | undefined
  let loaded: LoadedDshProfile | undefined
  try {
    loaded = await bootDshProfileWithInstalledBundles(bundles, isolated, previousEnv.path)
    ctx = loaded.ctx
  } catch (error) {
    await cleanupSetupFailure(ctx, isolated, previousEnv)
    throw error
  }
  const proof = loaded.proof
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await cleanupReturnedProfile(ctx, isolated, previousEnv)
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
        .map((entry) => entry.options.name)
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
