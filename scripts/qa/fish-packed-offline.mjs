#!/usr/bin/env node
/**
 * `fish-packed-offline` — the published-shape QA lane for
 * `@banbolee/dsh-fish-shell` (F10 of `.omo/plans/fish-shell-tty-v3.md`; the CI
 * job with that name runs exactly this file, with no arguments).
 *
 * What it proves, end to end, on the artifact users actually get:
 *   pack the bundle -> install the TARBALL into a REAL isolated DSH profile
 *   with `--offline` -> boot that profile for real -> the bundle layer mounts
 *   its `fish-terminal-group` (fish-configured official backend), the bundled
 *   `@deepseek-ai/dsh-tool-terminal` resolves from INSIDE the installed package,
 *   and all six `terminal_*` tools are visible to a real agent.
 *
 * Why the flow looks like this (every constraint is an S0 measurement):
 *   - the bundle ships `@deepseek-ai/dsh-tool-terminal` through
 *     `bundledDependencies`, so the tarball must carry REAL files under
 *     `package/node_modules/**`. Packing from an isolated (symlinked) tree emits
 *     symlinks instead, and pnpm refuses to pack bundled dependencies at all
 *     without the hoisted linker (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED)
 *     — hence `pnpm install --prod --config.node-linker=hoisted` followed by
 *     `pnpm pack --config.node-linker=hoisted`;
 *   - that install must NEVER run against the checkout: `--prod` prunes the
 *     workspace devDependencies and the hoisted linker rewrites the workspace
 *     node_modules layout. The bundle is therefore copied into a temp tree
 *     OUTSIDE the repository (asserted below) and installed there;
 *   - the profile install is `--offline` against a BRAND-NEW, EMPTY pnpm store
 *     (`--store-dir <staging>/add-store`; `dsh plugin` forwards pnpm flags and
 *     this one was verified to be honored): a published tarball must be
 *     self-contained, so this gate must not be able to consume anything the
 *     staging install has just warmed into the default store. Needing the
 *     network or that store would mean the bundled layout is broken; the
 *     symptom is ERR_PNPM_NO_OFFLINE_TARBALL.
 *
 * Isolation: everything lives under one temp root, whose `DSH_HOME` is
 * therefore isolated by construction — the real `~/.config/dsh` is never
 * touched (asserted below through the repository's own QA-root guard). The temp
 * root is removed on the way out, success or failure; every failure prints the
 * failing command and its complete output and exits non-zero.
 *
 * Requires on PATH: `dsh` (0.2.0-rc.1), `pnpm`, `tar`. `fish` is deliberately
 * NOT required: this lane proves the packed bundle installs, loads and
 * registers its tools — session behavior is the real lane's job
 * (`plugins/fish-shell/tests/terminal-session-real.spec.ts`).
 *
 * Environment note: a `PNPM_HOME` pointing at a missing or unwritable
 * package-manager directory makes every pnpm child fail with "create the
 * package-manager env directory … Permission denied". The pnpm/dsh children
 * spawned here therefore drop `PNPM_HOME` (the S0 probes do the same); pnpm
 * falls back to its default store, which is the one a workspace install already
 * warmed.
 */

import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertIsolatedQaRoot } from './lib/environment.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE_DIRECTORY = join(REPO_ROOT, 'plugins', 'fish-shell')
const BUNDLE_NAME = '@banbolee/dsh-fish-shell'
const TOOL_PACKAGE = '@deepseek-ai/dsh-tool-terminal'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const GROUP_ID = 'fish-terminal-group'
const PROFILE_NAME = 'fish-packed-offline'
const TERMINAL_TOOL_NAMES = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
]

class ProbeError extends Error {
  name = 'ProbeError'
}

let stepIndex = 0
/** Recorded as soon as it exists, so cleanup also covers every failure path. */
let stagingRoot

function step(description) {
  stepIndex += 1
  console.log(`[fish-packed-offline] step ${stepIndex}: ${description}`)
}

function info(message) {
  console.log(`[fish-packed-offline]   ${message}`)
}

function findOnPath(name) {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The child environment for `dsh` and `pnpm`: this repository's
 * `NODE_ENV=development` convention, the isolated `DSH_HOME`, and no
 * `PNPM_HOME` (see the header).
 */
function childEnvironment(dshHome) {
  const environment = { ...process.env, NODE_ENV: 'development', DSH_HOME: dshHome }
  delete environment.PNPM_HOME
  return environment
}

function run(command, args, options) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 900_000,
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error?.message,
  }
}

function requireSuccess(label, command, args, result) {
  if (result.status === 0) return result
  throw new ProbeError([
    `${label} failed (status ${String(result.status)}${result.error === undefined ? '' : `, ${result.error}`})`,
    `command: ${command} ${args.join(' ')}`,
    '--- output ---',
    result.output.trim(),
  ].join('\n'))
}

function requireUsableDirectory(path, label) {
  try {
    mkdirSync(path, { recursive: true })
    accessSync(path, constants.W_OK)
  } catch (error) {
    throw new ProbeError(`${label} is not writable: ${path} (${String(error)})`)
  }
  return path
}

/** `tar -tzf`: one packed path per line (no metadata columns). */
function tarballNames(tarball) {
  const listing = requireSuccess(
    'tar -tzf of the packed tarball',
    'tar',
    ['-tzf', tarball],
    run('tar', ['-tzf', tarball], { cwd: dirname(tarball) }),
  )
  return listing.output.split('\n').filter((line) => line.trim().length > 0)
}

/** `tar -tvzf`: one entry per line, mode in the first column ('l' = symlink). */
function tarballListing(tarball) {
  const listing = requireSuccess(
    'tar -tvzf of the packed tarball',
    'tar',
    ['-tvzf', tarball],
    run('tar', ['-tvzf', tarball], { cwd: dirname(tarball) }),
  )
  return listing.output.split('\n').filter((line) => line.trim().length > 0)
}

function tarballFile(tarball, entry) {
  return requireSuccess(
    `tar -xzOf ${entry}`,
    'tar',
    ['-xzOf', tarball, entry],
    run('tar', ['-xzOf', tarball, entry], { cwd: dirname(tarball) }),
  ).output
}

/** Package root of the installed `@deepseek-ai/dsh` (wrapper shebang or real bin). */
function dshPackageRoot(dshBinary) {
  const candidate = realpathSync(dshBinary)
  const wrapperTarget = /^exec "[^"]+" "([^"]+)" "\$@"$/m.exec(readFileSync(candidate, 'utf8'))?.[1]
  const real = wrapperTarget !== undefined && existsSync(wrapperTarget) ? realpathSync(wrapperTarget) : candidate
  return dirname(dirname(real))
}

function importModule(path) {
  return import(pathToFileURL(path).href)
}

/** The real `@deepseek-ai/dsh-llm` adapter base plus an agent-loop stub. */
async function loadAgentRuntime(packageRoot) {
  const llmModule = await importModule(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
  const sessionModule = await importModule(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'))
  class StubAdapter extends llmModule.LlmAdapter {
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model })
    }
    async *stream() { /* never invoked: this lane registers tools, it does not run a turn */ }
  }
  return {
    SessionId: sessionModule.SessionId,
    createStubAdapter: () => new StubAdapter(),
  }
}

async function main() {
  const dshBinary = findOnPath('dsh')
  if (dshBinary === undefined) {
    throw new ProbeError('the `dsh` CLI is not on PATH (install @deepseek-ai/dsh@0.2.0-rc.1)')
  }
  const pnpmBinary = process.env.PNPM_BIN ?? findOnPath('pnpm')
  if (pnpmBinary === undefined) {
    throw new ProbeError("pnpm is not on PATH (this lane packs the bundle with the repository's package manager)")
  }
  if (!existsSync(BUNDLE_DIRECTORY)) {
    throw new ProbeError(`the bundle to pack is missing: ${BUNDLE_DIRECTORY}`)
  }
  if (process.env.PNPM_HOME !== undefined) {
    info(`dropping PNPM_HOME=${process.env.PNPM_HOME} for the pnpm/dsh children (a missing or unwritable package-manager directory breaks them)`)
  }

  step('create the isolated staging root outside the repository')
  const staging = mkdtempSync(join(tmpdir(), 'dsh-fish-packed-offline-'))
  stagingRoot = staging
  // The same guard the dsh-tui QA lane uses: the root must be an OS temp
  // directory, strictly outside the repository and the user's home — which is
  // what makes the DSH_HOME below unable to touch the real `~/.config/dsh`.
  assertIsolatedQaRoot(staging, REPO_ROOT, homedir())
  const dshHome = join(staging, 'dsh-home')
  const packsDirectory = requireUsableDirectory(join(staging, 'packs'), 'pack destination')
  const workspace = requireUsableDirectory(join(staging, 'workspace'), 'probe workspace')
  info(`staging root: ${staging}`)
  info(`isolated DSH_HOME (never the real one): ${dshHome}`)

  step('copy the bundle into the staging tree (node_modules and tests excluded)')
  const stagedBundle = join(staging, 'fish-shell')
  cpSync(BUNDLE_DIRECTORY, stagedBundle, {
    recursive: true,
    filter: (entry) => basename(entry) !== 'node_modules'
      && basename(entry) !== 'tests'
      && basename(entry) !== 'tsconfig.json',
  })
  const manifest = JSON.parse(readFileSync(join(stagedBundle, 'package.json'), 'utf8'))
  if (manifest.name !== BUNDLE_NAME) {
    throw new ProbeError(`staged bundle is ${String(manifest.name)}, expected ${BUNDLE_NAME}`)
  }
  const declaredBundled = manifest.bundledDependencies ?? []
  if (manifest.dependencies?.[TOOL_PACKAGE] === undefined || !declaredBundled.includes(TOOL_PACKAGE)) {
    throw new ProbeError(
      `${BUNDLE_NAME} must declare ${TOOL_PACKAGE} in both dependencies and bundledDependencies `
      + `(dependencies: ${JSON.stringify(manifest.dependencies)}, bundledDependencies: ${JSON.stringify(declaredBundled)})`,
    )
  }
  info(`staged ${manifest.name}@${manifest.version} at ${stagedBundle}`)

  // The hoisted production install and the pack both run INSIDE the staged
  // copy: this is the only place a `pnpm install --prod` may ever run.
  const environment = childEnvironment(dshHome)
  step('staging pnpm install (--prod, hoisted linker)')
  const installArgs = ['install', '--prod', '--config.node-linker=hoisted', '--config.auto-install-peers=false']
  requireSuccess(
    'staging pnpm install',
    pnpmBinary,
    installArgs,
    run(pnpmBinary, installArgs, { cwd: stagedBundle, env: environment }),
  )
  info(`staged copy now has ${readdirSync(join(stagedBundle, 'node_modules')).length} top-level node_modules entries`)

  step('pnpm pack the staged copy (hoisted linker, bundled dependencies)')
  const packArgs = ['pack', '--config.node-linker=hoisted', '--pack-destination', packsDirectory]
  requireSuccess('pnpm pack', pnpmBinary, packArgs, run(pnpmBinary, packArgs, { cwd: stagedBundle, env: environment }))
  const tarballs = readdirSync(packsDirectory).filter((entry) => entry.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new ProbeError(`expected exactly one packed tarball, found: ${JSON.stringify(tarballs)}`)
  }
  const tarballName = tarballs[0]
  const tarball = join(packsDirectory, tarballName)
  const expectedTarballName = `${BUNDLE_NAME.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
  if (tarballName !== expectedTarballName) {
    throw new ProbeError(`packed tarball is named ${tarballName}, expected ${expectedTarballName}`)
  }
  info(`${tarballName} (${statSync(tarball).size} bytes)`)

  step('assert the packed top level matches the files whitelist')
  // The unconditional twin of `plugins/fish-shell/tests/packed-files.spec.ts`
  // (T2): that spec skips itself on a cold store or without a reachable
  // registry, while this lane always runs in CI. `package.json` is packed by
  // npm/pnpm unconditionally and `node_modules` is pnpm's bundled-dependency
  // payload (asserted separately below), so both are outside the whitelist by
  // design; anything else at the top level must be declared in `files`.
  const topLevel = new Set()
  for (const name of tarballNames(tarball)) {
    const match = /^package\/([^/]+)\/?$/.exec(name)
    if (match !== null) topLevel.add(match[1])
  }
  topLevel.delete('package.json')
  topLevel.delete('node_modules')
  const whitelist = new Set(manifest.files ?? [])
  const missingFromTarball = [...whitelist].filter((name) => !topLevel.has(name)).sort()
  const extraInTarball = [...topLevel].filter((name) => !whitelist.has(name)).sort()
  if (missingFromTarball.length > 0 || extraInTarball.length > 0) {
    throw new ProbeError([
      'the packed top level does not match the `files` whitelist in plugins/fish-shell/package.json',
      `declared in files but MISSING from the tarball: ${JSON.stringify(missingFromTarball)}`,
      `present in the tarball but NOT declared in files: ${JSON.stringify(extraInTarball)}`,
      `tarball top level: ${JSON.stringify([...topLevel].sort())}`,
      `files whitelist:  ${JSON.stringify([...whitelist].sort())}`,
    ].join('\n'))
  }
  info(`top level == files whitelist (${whitelist.size} entries, plus package.json/node_modules)`)

  step('assert the bundled dependency is in the tarball as REAL files, not symlinks')
  const entries = tarballListing(tarball)
  const bundledEntries = entries.filter((line) => line.includes('/node_modules/'))
  if (bundledEntries.length === 0) {
    throw new ProbeError(
      `the tarball carries no node_modules entries, so ${TOOL_PACKAGE} was not bundled `
      + '(an isolated layout packs symlinks; without the hoisted linker pnpm refuses the pack entirely)',
    )
  }
  const symlinked = bundledEntries.filter((line) => line.startsWith('l'))
  if (symlinked.length > 0) {
    throw new ProbeError([
      `the tarball carries ${symlinked.length} SYMLINK entries under node_modules — the bundled files are not real:`,
      ...symlinked.slice(0, 10),
    ].join('\n'))
  }
  const bundledPackageJsonEntry = `package/node_modules/${TOOL_PACKAGE}/package.json`
  if (!entries.some((line) => line.endsWith(bundledPackageJsonEntry))) {
    throw new ProbeError(`the tarball has no ${bundledPackageJsonEntry}`)
  }
  const bundledPackage = JSON.parse(tarballFile(tarball, bundledPackageJsonEntry))
  const declaredVersion = manifest.dependencies[TOOL_PACKAGE]
  if (bundledPackage.version !== declaredVersion) {
    throw new ProbeError(
      `the tarball bundles ${TOOL_PACKAGE}@${String(bundledPackage.version)} but the manifest declares ${String(declaredVersion)}`,
    )
  }
  info(`${bundledEntries.length} node_modules entries, all regular files; bundled ${TOOL_PACKAGE}@${bundledPackage.version}`)

  step('build the isolated profile and install the TARBALL with --offline against an EMPTY store')
  // The staging install above may use whatever store pnpm has (and the network);
  // this gate must not be able to consume any of it, or a bundle that is only
  // complete because the store happens to be warm would pass. `dsh plugin`
  // forwards the rest of its command line to pnpm, and `--store-dir` was
  // verified to be honored (pointing it at a regular file fails the add with
  // "Failed to write cafs: … Not a directory"), so the add below runs offline
  // against a store directory that starts empty.
  const addStore = requireUsableDirectory(join(staging, 'add-store'), 'offline store')
  if (readdirSync(addStore).length !== 0) {
    throw new ProbeError(`the offline store must start empty: ${addStore}`)
  }
  info(`add-phase pnpm store (empty by construction): ${addStore}`)
  const packageRoot = dshPackageRoot(dshBinary)
  const installAnchor = join(packageRoot, 'package.json')
  const appBoot = await importModule(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  const profileDirectory = join(dshHome, 'profiles', PROFILE_NAME)
  mkdirSync(profileDirectory, { recursive: true })
  appBoot.initProfile(profileDirectory, [BASE_BUNDLE])
  // The profile plane needs a root config, and its own patch stays empty: the
  // rows under test must come from the BUNDLE's patch inside the tarball.
  writeFileSync(join(profileDirectory, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDirectory, 'cordis.patch.yml'), '[]\n')
  const addArgs = [
    'plugin', '--profile', PROFILE_NAME, 'add', '-w', tarball,
    '--offline', '--config.auto-install-peers=false', '--store-dir', addStore,
  ]
  requireSuccess(
    'dsh plugin add --offline (empty store)',
    dshBinary,
    addArgs,
    run(dshBinary, addArgs, { cwd: profileDirectory, env: environment }),
  )
  const profileManifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8'))
  const recordedBundles = profileManifest.dsh?.profile?.bundles ?? []
  if (!recordedBundles.includes(BUNDLE_NAME)) {
    throw new ProbeError(`the profile did not record the bundle layer: ${JSON.stringify(recordedBundles)}`)
  }
  info(`profile bundles: ${JSON.stringify(recordedBundles)}`)

  step('load the installed profile and check the bundled copy inside the package')
  const profile = appBoot.loadProfile('dsh', PROFILE_NAME, installAnchor, dshHome)
  const layers = profile.layers.map((layer) => layer.packageName)
  for (const required of [BASE_BUNDLE, BUNDLE_NAME]) {
    if (!layers.includes(required)) {
      throw new ProbeError(`profile layer missing: ${required} (layers: ${JSON.stringify(layers)})`)
    }
  }
  const bundleLayer = profile.layers.find((layer) => layer.packageName === BUNDLE_NAME)
  const installedToolDirectory = join(bundleLayer.packageDir, 'node_modules', TOOL_PACKAGE)
  const installedToolPackage = join(installedToolDirectory, 'package.json')
  if (!existsSync(installedToolPackage)) {
    throw new ProbeError(`the installed bundle has no bundled ${TOOL_PACKAGE} at ${installedToolPackage}`)
  }
  if (lstatSync(installedToolDirectory).isSymbolicLink()) {
    throw new ProbeError(`the installed ${TOOL_PACKAGE} is a symlink, not a bundled copy: ${installedToolDirectory}`)
  }
  const installedVersion = JSON.parse(readFileSync(installedToolPackage, 'utf8')).version
  info(`installed bundle layer: ${bundleLayer.packageDir}`)
  info(`bundled ${TOOL_PACKAGE}@${installedVersion} is a real directory inside it`)

  // The resolver probe behind this plan's "resolved from inside the package"
  // assumption: the profile-plane resolution must own an entry for the bundled
  // package, declared by the installed bundle and located inside its directory.
  const resolution = typeof appBoot.createRuntimeResolution === 'function' && appBoot.PluginPackages !== undefined
    ? await appBoot.createRuntimeResolution({ installAnchor, profile, home: dshHome })
    : undefined
  let prepare
  if (resolution !== undefined) {
    prepare = async (ctx) => { await ctx.plugin(appBoot.PluginPackages, { resolution }) }
  } else {
    await appBoot.healProfilesModuleFallback?.({ installAnchor, profile, home: dshHome })
  }
  if (resolution !== undefined) {
    const toolEntry = resolution.entries?.find((entry) => entry.name === TOOL_PACKAGE)
    if (toolEntry === undefined) {
      throw new ProbeError(`the runtime resolution has no entry for the bundled ${TOOL_PACKAGE}`)
    }
    if (toolEntry.scope !== 'profile' || !String(toolEntry.packageDir).startsWith(bundleLayer.packageDir)) {
      throw new ProbeError(`${TOOL_PACKAGE} resolved outside the installed bundle: ${JSON.stringify(toolEntry)}`)
    }
    info(`resolution entry: ${TOOL_PACKAGE}@${String(toolEntry.version)} scope=${String(toolEntry.scope)} dir=${String(toolEntry.packageDir)}`)
  }

  step('boot the installed profile for real')
  process.env.DSH_HOME = dshHome
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]
  const ctx = await appBoot.boot('dsh', join(profileDirectory, 'cordis.yml'), patches, prepare)

  try {
    step('assert the group mounted, its backend is fish, and the six tools are visible')
    const loader = ctx.get('loader')
    const group = [...loader.entries()].find((entry) => entry.options?.id === GROUP_ID)
    if (group === undefined) {
      throw new ProbeError(`the installed bundle did not mount the "${GROUP_ID}" row`)
    }
    const terminals = group.ctx.get('terminals')
    if (terminals === undefined) {
      throw new ProbeError(`the "${GROUP_ID}" realm has no terminals service (isolate.terminals failed)`)
    }
    const backends = terminals.listBackends()
    if (!Array.isArray(backends) || backends.length === 0) {
      throw new ProbeError(`terminals.listBackends() is empty: ${JSON.stringify(backends)}`)
    }
    const shellBackend = terminals.backends?.get('shell')
    if (shellBackend === undefined || shellBackend.config?.shellPath !== 'fish') {
      throw new ProbeError(`the installed profile has no fish-configured shell backend: ${JSON.stringify(backends)}`)
    }
    info(`listBackends() -> ${JSON.stringify(backends)}; shellPath=${String(shellBackend.config.shellPath)}`)

    const runtime = await loadAgentRuntime(packageRoot)
    const tools = ctx.get('tools')
    ctx.get('llm').registerAdapter(['fish-packed-offline-mock'], runtime.createStubAdapter())
    const agent = await ctx.get('agentLoop').create(
      runtime.SessionId('fish-packed-offline'),
      { provider: 'fish-packed-offline-mock', model: 'fish-packed-offline-mock' },
      { cwd: workspace },
    )
    const missing = TERMINAL_TOOL_NAMES.filter((name) => {
      const tool = tools.get(name, agent)
      return tool === undefined || typeof tool.execute !== 'function'
    })
    if (missing.length > 0) {
      throw new ProbeError(`terminal tools not visible to a real agent: ${JSON.stringify(missing)}`)
    }
    const agentSchemas = tools.schemas(agent).map((schema) => schema.name)
    const missingInSchemas = TERMINAL_TOOL_NAMES.filter((name) => !agentSchemas.includes(name))
    if (missingInSchemas.length > 0) {
      throw new ProbeError(`terminal tools missing from the agent schema list: ${JSON.stringify(missingInSchemas)}`)
    }
    info(`agent ${String(agent.id)} sees all six terminal_* tools (get + schemas)`)
  } finally {
    step('dispose the booted profile')
    await ctx.fiber.dispose().catch(() => {})
  }

  return tarballName
}

try {
  const tarballName = await main()
  console.log(`[fish-packed-offline] PASSED — ${tarballName} installs --offline, boots, and exposes the six terminal tools`)
} catch (error) {
  console.error(`[fish-packed-offline] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (stagingRoot !== undefined) {
    rmSync(stagingRoot, { recursive: true, force: true })
    console.log(`[fish-packed-offline] cleaned up ${stagingRoot}`)
  }
}
