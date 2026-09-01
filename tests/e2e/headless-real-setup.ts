/// <reference types="node" />

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadAppBoot, type LoadedProfile } from '../composition/profile-loader'
import type { IsolatedProfile } from '../helpers/profile'
import {
  restoreEnvironment,
  scrubGitCredentials,
  type EnvironmentSnapshot,
} from './headless-real-contract'
import { initializeGitFixture } from './headless-real-git'
import {
  BASE_BUNDLES,
  DSH_BIN,
  initializeCodeGraphFixture,
  installLocalBundles,
} from './headless-real-runtime'

type SetupOptions = {
  readonly isolated: IsolatedProfile
  readonly home: string
  readonly credentialNames: readonly string[]
  readonly snapshot: EnvironmentSnapshot
  readonly originalCwd: string
}

export type PreparedProfile = {
  readonly appBoot: Awaited<ReturnType<typeof loadAppBoot>>['appBoot']
  readonly defaultIndexedProject: string
  readonly defaultIndexedSymbol: string
  readonly explicitIndexedProject: string
  readonly explicitIndexedSymbol: string
  readonly gitProject: string
  readonly profile: LoadedProfile
  readonly rootConfig: string
}

export async function prepareRealProfile(options: SetupOptions): Promise<PreparedProfile> {
  try {
    mkdirSync(options.home, { recursive: true })
    process.env.DSH_HOME = options.isolated.dshHome
    process.env.HOME = options.home
    process.env.XDG_CONFIG_HOME = join(options.home, '.config')
    process.env.CODEGRAPH_NO_DAEMON = '1'
    process.env.DO_NOT_TRACK = '1'
    process.env.CODEGRAPH_NO_UPDATE_CHECK = '1'
    scrubGitCredentials(options.credentialNames)
    process.env.GIT_TERMINAL_PROMPT = '0'
    process.env.GIT_OPTIONAL_LOCKS = '0'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    const emptyGitConfig = join(options.home, 'empty-git-config')
    writeFileSync(emptyGitConfig, '')
    process.env.GIT_CONFIG_GLOBAL = emptyGitConfig
    process.env.GIT_CONFIG_SYSTEM = emptyGitConfig
    const { appBoot, installAnchor } = await loadAppBoot(DSH_BIN)
    appBoot.initProfile(options.isolated.profile, [...BASE_BUNDLES])
    installLocalBundles(options.isolated.profile, options.isolated.dshHome)
    appBoot.healProfilesModuleFallback(installAnchor, options.isolated.dshHome)
    const profile = appBoot.loadProfile('dsh', 'headless-real', installAnchor, options.isolated.dshHome)
    const rootConfig = join(options.isolated.profile, 'cordis.yml')
    writeFileSync(rootConfig, '[]\n')
    const nonce = randomUUID().replaceAll('-', '')
    const defaultIndexedSymbol = `DefaultFixture_${nonce}`
    const explicitIndexedSymbol = `ExplicitFixture_${nonce}`
    const defaultIndexedProject = initializeCodeGraphFixture({
      dshHome: options.isolated.dshHome,
      directoryName: 'default-indexed-project',
      symbol: defaultIndexedSymbol,
    })
    const explicitIndexedProject = initializeCodeGraphFixture({
      dshHome: options.isolated.dshHome,
      directoryName: 'explicit-indexed-project',
      symbol: explicitIndexedSymbol,
    })
    const gitProject = initializeGitFixture(options.isolated.dshHome)
    process.chdir(gitProject)
    return {
      appBoot,
      defaultIndexedProject,
      defaultIndexedSymbol,
      explicitIndexedProject,
      explicitIndexedSymbol,
      gitProject,
      profile,
      rootConfig,
    }
  } catch (error) {
    try {
      await options.isolated.cleanup()
    } catch (cleanupError) {
      if (error instanceof Error && error.cause === undefined) error.cause = cleanupError
    } finally {
      process.chdir(options.originalCwd)
      restoreEnvironment(options.snapshot)
    }
    throw error
  }
}
