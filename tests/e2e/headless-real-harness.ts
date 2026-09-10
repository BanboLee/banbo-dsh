/// <reference types="node" />

import { randomUUID } from 'node:crypto'
import { delimiter, dirname, join } from 'node:path'
import { createIsolatedProfile } from '../helpers/profile'
import { type BootContext } from '../composition/profile-loader'
import {
  activeLocalPluginOrder,
  activeShellProviders,
  captureEnvironment,
  restoreEnvironment,
  type RealHeadlessHarness,
} from './headless-real-contract'
import {
  assertRealPrerequisites,
  BANBO_DSH_ROOT,
  NODE_BIN,
  orderedLayers,
  PLUGIN_NAMES,
  PROFILE_NAME,
  RTK_BIN,
  runtimePatches,
} from './headless-real-runtime'
import {
  markerOwnedPids,
  terminateMarkerOwnedProcesses,
} from './headless-real-process'
import { prepareRealProfile } from './headless-real-setup'
export { PROCESS_INSPECTION_AVAILABLE } from './headless-real-process'
export {
  BANBO_DSH_ROOT,
  CODEGRAPH_BIN,
  DEFAULT_CODEGRAPH_BIN,
  DEFAULT_RTK_BIN,
  DSH_BIN,
  NODE_BIN,
  PLUGIN_NAMES,
  RTK_BIN,
  type PluginName,
} from './headless-real-runtime'
export {
  readTextToolResult,
  type RealBoot,
  type RealHeadlessHarness,
} from './headless-real-contract'

export async function createRealHeadlessHarness(): Promise<RealHeadlessHarness> {
  assertRealPrerequisites()

  const originalCwd = process.cwd()
  const { credentialNames, snapshot } = captureEnvironment()
  const previousTmpdir = process.env.TMPDIR
  const isolated = (() => {
    try {
      process.env.TMPDIR = dirname(BANBO_DSH_ROOT)
      return createIsolatedProfile(PROFILE_NAME)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
    }
  })()
  const home = join(isolated.dshHome, 'home')
  process.env.PATH = [dirname(RTK_BIN), dirname(NODE_BIN), snapshot.PATH ?? ''].join(delimiter)
  const initialized = await prepareRealProfile({
    isolated,
    home,
    credentialNames,
    snapshot,
    originalCwd,
  })
  const {
    appBoot,
    defaultIndexedProject,
    defaultIndexedSymbol,
    explicitIndexedProject,
    explicitIndexedSymbol,
    gitProject,
    profile,
    rootConfig,
  } = initialized
  const active = new Map<BootContext, string>()
  const ownedMarkers = new Set<string>()
  let cleaned = false

  return {
    dshHome: isolated.dshHome,
    home,
    profile: isolated.profile,
    gitProject,
    defaultIndexedProject,
    defaultIndexedSymbol,
    explicitIndexedProject,
    explicitIndexedSymbol,
    ownedProcessCount: () => [...ownedMarkers]
      .reduce((count, marker) => count + markerOwnedPids(marker).length, 0),
    boot: async (options = {}) => {
      if (cleaned) throw new Error('real E2E harness is already cleaned')
      const order = options.order ?? PLUGIN_NAMES
      const rtkBinary = options.rtkBinary ?? RTK_BIN
      const processMarker = `${PROFILE_NAME}-${randomUUID()}`
      ownedMarkers.add(processMarker)
      const layers = orderedLayers(profile, order)
      const patches = [
        ...layers.flatMap((layer) => layer.patches),
        ...profile.patches,
        ...runtimePatches({
          rtkBinary,
          codegraphBin: options.codegraphBin,
          codegraphProject: defaultIndexedProject,
          processMarker,
        }),
      ]
      let ctx: BootContext
      try {
        ctx = await appBoot.boot('dsh', rootConfig, patches)
      } catch (error) {
        try {
          await terminateMarkerOwnedProcesses(processMarker)
        } catch (cleanupError) {
          if (error instanceof Error && error.cause === undefined) error.cause = cleanupError
        }
        throw error
      }
      active.set(ctx, processMarker)
      let disposed = false
      return {
        ctx,
        proof: {
          loader: 'dsh-app-boot',
          profileDir: profile.dir,
          installedBundles: layers.map((layer) => layer.packageName),
          bundlePackageDirs: layers.map((layer) => layer.packageDir),
          bundlePatchFiles: layers.map((layer) => layer.patchPath),
        },
        ownedProcessPids: () => markerOwnedPids(processMarker),
        localPluginOrder: () => activeLocalPluginOrder(ctx),
        shellProviders: () => activeShellProviders(ctx),
        toolNames: () => ctx.get('tools')?.schemas().map((schema) => schema.name).sort() ?? [],
        runShell: (request) => {
          const input = typeof request === 'string'
            ? { command: request, timeoutMs: 60_000 }
            : { timeoutMs: 60_000, ...request }
          return ctx.shell.run(ctx.shell.resolve(input))
        },
        startShell: (request) => {
          const input = typeof request === 'string'
            ? { command: request, timeoutMs: 60_000 }
            : { timeoutMs: 60_000, ...request }
          return ctx.shell.start(ctx.shell.resolve(input))
        },
        executeTool: async (name, args) => {
          const result = await ctx.get('tools')?.execute({
            callId: `real-e2e-${name}`,
            name,
            arguments: args,
            signal: AbortSignal.timeout(30_000),
          })
          if (result === undefined) throw new Error('real E2E tools runtime is missing')
          return result
        },
        callTool: async (name, args) => {
          const result = await ctx.get('tools')?.execute({
            callId: `real-e2e-${name}`,
            name,
            arguments: args,
            signal: AbortSignal.timeout(30_000),
          })
          if (result === undefined) throw new Error('real E2E tools runtime is missing')
          if (result.isError) throw new Error(result.error?.message ?? `tool ${name} failed`)
          return result.value
        },
        cleanup: async () => {
          if (disposed) return
          let cleanupError: unknown
          try {
            await ctx.fiber.dispose()
          } catch (error) {
            cleanupError = error
          }
          try {
            await terminateMarkerOwnedProcesses(processMarker)
          } catch (error) {
            cleanupError ??= error
          }
          if (cleanupError !== undefined) throw cleanupError
          active.delete(ctx)
          ownedMarkers.delete(processMarker)
          disposed = true
        },
      }
    },
    cleanup: async () => {
      if (cleaned) return
      let cleanupError: unknown
      try {
        const disposals = await Promise.allSettled([...active.keys()].map((ctx) => ctx.fiber.dispose()))
        cleanupError = disposals.find((result) => result.status === 'rejected')?.reason
        for (const marker of ownedMarkers) {
          try {
            await terminateMarkerOwnedProcesses(marker)
          } catch (error) {
            cleanupError ??= error
          }
        }
        process.chdir(originalCwd)
        try {
          await isolated.cleanup()
        } catch (error) {
          cleanupError ??= error
        }
      } finally {
        if (process.cwd() !== originalCwd) process.chdir(originalCwd)
        restoreEnvironment(snapshot)
      }
      if (cleanupError !== undefined) throw cleanupError
      active.clear()
      ownedMarkers.clear()
      cleaned = true
    },
  }
}
