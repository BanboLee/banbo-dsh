import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createIsolatedProfile, type IsolatedProfile } from '../helpers/profile'
import {
  findExecutable,
  installBundles,
  type LspDiagnosticsBootOptions,
  writeLspProfileFiles,
} from './lsp-diagnostics-profile-config'
import {
  loadAppBoot,
  type BootContext,
  type LoadedProfile,
  type RealProfileProof,
} from './profile-loader'

export {
  FAKE_LSP_SERVER,
  type FakeLspMode,
  type LspDiagnosticsBootOptions,
  repoRoot,
} from './lsp-diagnostics-profile-config'

const profileName = 'lsp-diagnostics-profile'
const LSP_BUNDLE = 'plugins/dsh-lsp-diagnostics'

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
  readonly clangdLog: string
  readonly rustLog: string
  readonly pythonLog: string
  readonly proof: RealProfileProof
  readonly cleanup: () => Promise<void>
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
  const clangdLog = join(isolated.profile, 'clangd-server.log')
  const rustLog = join(isolated.profile, 'rust-server.log')
  const pythonLog = join(isolated.profile, 'python-server.log')
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
    installBundles({
      dshBin,
      dshHome: isolated.dshHome,
      profile: isolated.profile,
      bundles: [LSP_BUNDLE, ...(options.additionalBundles ?? [])],
    })
    const rootConfig = writeLspProfileFiles({
      profile: isolated.profile,
      workspace,
      options,
      logs: {
        typescript: typescriptLog,
        go: goLog,
        clangd: clangdLog,
        rust: rustLog,
        python: pythonLog,
      },
    })
    const profile: LoadedProfile = appBoot.loadProfile('dsh', profileName, installAnchor, isolated.dshHome)
    await appBoot.healProfilesModuleFallback({
      installAnchor,
      profile,
      home: isolated.dshHome,
    })
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
      clangdLog,
      rustLog,
      pythonLog,
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
