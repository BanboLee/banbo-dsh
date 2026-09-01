/// <reference types="node" />

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { repoRoot, type LoadedProfile } from '../composition/profile-loader'

export const BANBO_DSH_ROOT = repoRoot
const workspaceRoot = dirname(repoRoot)

function executableOnPath(name: string, pathValue: string = process.env.PATH ?? ''): string | undefined {
  return pathValue.split(delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => join(directory, name))
    .find((candidate) => existsSync(candidate))
}

export const DSH_BIN = process.env.DSH_REAL_E2E_DSH_BIN ?? executableOnPath('dsh') ?? ''
export const NODE_BIN = process.env.DSH_REAL_E2E_NODE_BIN
  ?? executableOnPath('node', `${dirname(DSH_BIN)}${delimiter}${process.env.PATH ?? ''}`)
  ?? ''
export const DEFAULT_RTK_BIN = join(workspaceRoot, 'rtk', 'target', 'release', 'rtk')
export const DEFAULT_CODEGRAPH_BIN = join(workspaceRoot, 'codegraph', 'dist', 'bin', 'codegraph.js')
export const RTK_BIN = process.env.DSH_REAL_E2E_RTK_BIN ?? DEFAULT_RTK_BIN
export const CODEGRAPH_BIN = process.env.DSH_REAL_E2E_CODEGRAPH_BIN ?? DEFAULT_CODEGRAPH_BIN
export const PROFILE_NAME = 'headless-real'
export const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] as const
export const PLUGIN_NAMES = [
  'dsh-fish-shell',
  'dsh-rtk',
  'dsh-codegraph-mcp',
] as const

export type PluginName = (typeof PLUGIN_NAMES)[number]

const LOCAL_BUNDLE_PATHS = [
  'plugins/fish-shell',
  'plugins/rtk',
  'plugins/codegraph-mcp',
] as const
const DISABLED_ROWS = [
  'headless-startup',
  'headless-runner',
  'session-telemetry-otel',
] as const

export function assertRealPrerequisites(): void {
  for (const path of [DSH_BIN, NODE_BIN, RTK_BIN, CODEGRAPH_BIN]) {
    try {
      accessSync(path, path === CODEGRAPH_BIN ? constants.R_OK : constants.X_OK)
    } catch {
      throw new Error(`required real E2E executable is unavailable: ${path}`)
    }
  }
  if (realpathSync(RTK_BIN) !== realpathSync(DEFAULT_RTK_BIN)) {
    throw new Error(`configured RTK binary must resolve to the sibling build: ${DEFAULT_RTK_BIN}`)
  }
  if (realpathSync(CODEGRAPH_BIN) !== realpathSync(DEFAULT_CODEGRAPH_BIN)) {
    throw new Error(`configured CodeGraph binary must resolve to the sibling build: ${DEFAULT_CODEGRAPH_BIN}`)
  }
  const nodeVersion = spawnSync(NODE_BIN, ['--version'], { encoding: 'utf8', timeout: 5_000 })
  if (nodeVersion.status !== 0 || !nodeVersion.stdout.startsWith('v22.')) {
    throw new Error(`real E2E requires Node 22 at ${NODE_BIN}: ${nodeVersion.stdout}${nodeVersion.stderr}`)
  }
  const fish = spawnSync('fish', ['--version'], { encoding: 'utf8', timeout: 5_000 })
  if (fish.status !== 0) throw new Error(`real E2E requires fish on PATH: ${fish.stderr}`)
}

export function installLocalBundles(profile: string, dshHome: string): void {
  const pluginPaths = LOCAL_BUNDLE_PATHS.map((path) => join(repoRoot, path))
  const result = spawnSync(
    DSH_BIN,
    ['plugin', '--profile', PROFILE_NAME, 'add', '-w', ...pluginPaths, '--offline', '--ignore-scripts'],
    {
      cwd: profile,
      env: { ...process.env, DSH_HOME: dshHome },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  if (result.status !== 0) {
    throw new Error(`dsh plugin add failed (${result.status ?? 'signal'}):\n${result.stdout}${result.stderr}`)
  }
}

export type CodeGraphFixtureOptions = {
  readonly dshHome: string
  readonly directoryName: string
  readonly symbol: string
}

export function initializeCodeGraphFixture(options: CodeGraphFixtureOptions): string {
  const indexedProject = join(options.dshHome, options.directoryName)
  mkdirSync(indexedProject, { recursive: true })
  writeFileSync(
    join(indexedProject, 'fixture.ts'),
    `export function ${options.symbol}(): string { return 'real-headless-index' }\n`,
  )
  const indexing = spawnSync(NODE_BIN, [CODEGRAPH_BIN, 'init', indexedProject, '--yes'], {
    cwd: indexedProject,
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1',
      DO_NOT_TRACK: '1',
      CODEGRAPH_NO_UPDATE_CHECK: '1',
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (indexing.status !== 0) {
    throw new Error(`CodeGraph fixture init failed (${indexing.status ?? 'signal'}):\n${indexing.stdout}${indexing.stderr}`)
  }
  return indexedProject
}

export function orderedLayers(
  profile: LoadedProfile,
  order: readonly PluginName[],
): LoadedProfile['layers'] {
  const byName = new Map(profile.layers.map((layer) => [layer.packageName, layer]))
  return [...BASE_BUNDLES, ...order].map((name) => {
    const layer = byName.get(name)
    if (layer === undefined) throw new Error(`required real E2E layer is missing: ${name}`)
    return layer
  })
}

export type RealBootOptions = {
  readonly order?: readonly PluginName[]
  readonly rtkBinary?: string
  readonly codegraphBin?: string
}

export type RuntimePatchOptions = {
  readonly rtkBinary: string
  readonly codegraphBin?: string
  readonly codegraphProject: string
  readonly processMarker: string
}

export function runtimePatches(options: RuntimePatchOptions): unknown[] {
  return [
    ...DISABLED_ROWS.map((id) => ({ id, disabled: true })),
    {
      id: 'rtk',
      config: { rtkBinary: options.rtkBinary, rewriteTimeoutMs: 5_000, grepCompress: true },
    },
    {
      id: 'mcp-codegraph',
      config: {
        serverName: 'codegraph',
        transport: 'stdio',
        command: NODE_BIN,
        args: [options.codegraphBin ?? CODEGRAPH_BIN, 'serve', '--mcp'],
        env: {
          CODEGRAPH_NO_DAEMON: '1',
          DO_NOT_TRACK: '1',
          CODEGRAPH_NO_UPDATE_CHECK: '1',
          REAL_HEADLESS_E2E_PROCESS_MARKER: options.processMarker,
        },
        cwd: options.codegraphProject,
        toolCallTimeoutMs: 30_000,
        failOnStartupError: true,
        reconnect: { enabled: false },
      },
    },
  ]
}
