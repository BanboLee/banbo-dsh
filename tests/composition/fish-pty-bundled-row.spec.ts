/**
 * REAL composition lane for `.omo/plans/fish-shell-tty-v3.md` §9 item 8: what
 * happens when a PROFILE's own patch plane (`$DSH_HOME/profiles/<p>/cordis.patch.yml`)
 * names a BUNDLED package directly —
 *
 *     - insert:
 *         - id: terminal-bundled-row
 *           name: '@deepseek-ai/dsh-tool-terminal'
 *
 * `@deepseek-ai/dsh-tool-terminal` is not a dependency of the dsh installation:
 * it ships INSIDE this bundle's tarball as a pnpm `bundledDependency`. The
 * bundle's own patch addresses it from inside that package
 * (`fish-terminal-group`'s `terminal-tools` row), which is the "resolve from
 * the package" assumption this lane probes at its outermost boundary. The plan
 * feared this shape could register the six `terminal_*` tools a second time.
 *
 * What the lane does, through this repository's own QA infra:
 *
 *   - `createQaLayout`/`writeToolWrappers`/`installProfile` build a real,
 *     isolated profile (`dsh-base` + this bundle only — no dsh-tui, so the lane
 *     runs in the CI `composition` job) under a fresh temporary `$DSH_HOME`;
 *     the tarball is packed with the same recipe `scripts/qa/lib/profile.mjs`
 *     uses for this bundle (staged copy → hoisted `--prod` install → hoisted
 *     `pack`), so the bundled package is a real file inside it;
 *   - BEFORE booting, `createRuntimeResolution` is read directly: it is the
 *     exact table the boot-time resolver interception installs, so it answers
 *     "where would this name resolve from" without inference — per entry:
 *     `scope` (installation vs profile), `packageDir` and `declarer`;
 *   - the profile patch plane then declares the probe row, and the profile is
 *     booted in-process the way the `dsh` CLI boots it.
 *
 * The assertions pin the OBSERVED result, not the plan's expectation (they were
 * written against a real run of this lane):
 *
 *   - the name RESOLVES, and from the profile plane only: exactly one entry,
 *     `scope: profile`, its `declarer` the mounted bundle's own `package.json`
 *     and its `packageDir` that bundle's own vendored copy
 *     (`<bundle package dir>/node_modules/@deepseek-ai/dsh-tool-terminal`) —
 *     plus NOT ONE installation-scope entry for the name. The assertion is
 *     relative to the bundle LAYER the profile composed, not to the profile
 *     directory, because that layer is not always the profile's installed copy:
 *     `resolveBundleDir` tries the installation anchor first and
 *     `packageDirFromAnchor` walks `createRequire(anchor).resolve.paths()`, which
 *     appends `Module.globalPaths` — including `process.env.NODE_PATH`.
 *     `pnpm test:composition` exports a NODE_PATH whose last entry is
 *     `<repo>/node_modules/.pnpm/node_modules`, where pnpm links every workspace
 *     package (`@banbolee/dsh-fish-shell -> ../../../../plugins/fish-shell`), so
 *     under the pnpm lane the layer IS the checkout; under a bare
 *     `node node_modules/vitest/vitest.mjs` run it is the profile's copy. Both
 *     provenances answer §9-8's question the same way — inside the bundle, never
 *     the installation — which is what this lane pins;
 *   - resolution is not activation, and the feared double registration CANNOT
 *     happen through this shape: `@deepseek-ai/dsh-tool-terminal` injects
 *     `terminals`, and that service is entry-local to this bundle's
 *     `fish-terminal-group` (`isolate: {terminals: true}`). At the profile plane
 *     the row therefore never activates — its fiber stays PENDING (state 0) with
 *     `terminals` as its one unsatisfied injection — so it never reaches the
 *     tools registry and cannot duplicate `terminal_open`. The boot's own audit
 *     reports exactly that, on stderr, as a non-required inactive entry:
 *     `terminal-bundled-row (@deepseek-ai/dsh-tool-terminal): pending (waiting
 *     for service: terminals)`. It is a warning, not a startup failure (the row
 *     is not in the profile's required-id list), so boot continues with the
 *     group's single registration — asserted from the captured boot
 *     diagnostics, so "did not activate" can never read as "worked";
 *   - nothing is registered twice: each of the six names appears exactly once
 *     in the host and in the agent's schema list, the owning row is the bundle's
 *     group (state 2), no row records an activation error, and the surviving six
 *     tools still drive a real PTY (a `dsh>` motd, then a clean close);
 *   - so the plan's §9-8 worry is answered "no double registration" — not
 *     because the package cannot load, but because the registry it needs sits
 *     behind the group's isolate realm. NOT verified here (mechanism, not
 *     evidence): a composition that made `terminals` reachable at the profile
 *     plane would load the same package into the root realm, and that second
 *     registration would hit the tools registry's duplicate guard
 *     (`tool "terminal_open" is already registered`, an activation error) — the
 *     loud shape this lane would otherwise have to pin.
 *
 * Gating: needs the global `dsh` CLI, `fish` and `pnpm`. A missing prerequisite
 * registers a SKIPPED test whose name names what is missing — never a silent
 * pass; `RUN_REAL_FISH_TUI=1` forces the lane open and then the same condition
 * FAILS LOUD.
 *
 * Cleanup: the session and the booted tree are disposed, every leftover PTY pid
 * is killed, `DSH_HOME`/`PNPM_HOME` are restored, the QA runtime home symlink is
 * removed and the whole temporary tree is deleted. The real `~/.config/dsh` is
 * never read or written.
 */

import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertIsolatedQaRoot,
  buildQaEnvironment,
  cleanupQaRuntimeHome,
  createQaLayout,
} from '../../scripts/qa/lib/environment.mjs'
import { installProfile, writeToolWrappers } from '../../scripts/qa/lib/profile.mjs'
import { runChild } from '../../scripts/qa/lib/process.mjs'
import {
  loadAppBoot,
  openProfileModuleResolution,
  repoRoot,
  resolveDshInstallationBin,
  type AppBootModule,
} from './profile-loader'

const FORCED = process.env.RUN_REAL_FISH_TUI === '1'
/** `installProfile` hard-codes this profile name, so the in-process boot must use it too. */
const PROFILE_NAME = 'dsh-tui'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const FISH_BUNDLE = '@banbolee/dsh-fish-shell'
const TOOL_TERMINAL = '@deepseek-ai/dsh-tool-terminal'
const GROUP_ID = 'fish-terminal-group'
/** The id of the profile-plane probe row this lane writes. */
const ROW_ID = 'terminal-bundled-row'
const PROVIDER = 'fish-bundled-row-lane-mock'
const SESSION_NAME = 'fish-pty-bundled-row'
/** The six names `@deepseek-ai/dsh-tool-terminal` registers. */
const TERMINAL_TOOL_NAMES = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
] as const
const DSH_HINT = 'install it with `npm install -g @deepseek-ai/dsh@0.2.0-rc.1`'
const FISH_HINT = 'install it (`apt-get install fish` on Linux, `brew install fish` on macOS)'

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const dshBinary = findOnPath('dsh')
const fishBinary = findOnPath('fish')
const pnpmBinary = findOnPath('pnpm')

const missingPrerequisites = [
  ...(dshBinary === undefined ? [`the \`dsh\` CLI on PATH — ${DSH_HINT}`] : []),
  ...(fishBinary === undefined ? [`the \`fish\` shell on PATH — ${FISH_HINT}`] : []),
  ...(pnpmBinary === undefined ? ['`pnpm` on PATH (the pack and profile-install steps run through it)'] : []),
]
/** A missing prerequisite is a SKIP with its reason spelled out, never a silent pass. */
const shouldRun = missingPrerequisites.length === 0 || FORCED
/** Named in the skipped suite/test titles so "did not run" can never read as "passed". */
const skipReason = `missing ${missingPrerequisites.join('; ')}`

// ── Real-runtime service shapes (only the members this lane touches) ──────────

interface ToolResult {
  readonly isError: boolean
  readonly value?: unknown
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly error?: { readonly message?: string }
}

interface ToolDefinition {
  readonly name?: string
  readonly execute?: unknown
}

interface ToolsRuntime {
  get(name: string, scope?: unknown): ToolDefinition | undefined
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>
  execute(input: {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly signal: AbortSignal
    readonly agent: RealAgent
  }): Promise<ToolResult>
}

interface SessionSnapshot {
  readonly sessionId: string
  readonly name?: string
  readonly type: string
  readonly pid?: number
  readonly status: { readonly kind: string }
}

interface TerminalsService {
  list(owner: unknown): readonly SessionSnapshot[]
  kill(owner: unknown, sessionId: string, reason?: string): Promise<boolean>
  hasOwnerActivity(owner: unknown): boolean
}

interface LoaderEntry {
  readonly options?: { readonly id?: string; readonly name?: string }
  readonly disabled?: boolean
  readonly ctx: { get(name: string): unknown }
  /**
   * Cordis fiber state: 2 running, 3 activation error, 0 pending
   * (`_getState`). `inject` is the service set the fiber is waiting on.
   */
  readonly fiber?: {
    readonly state?: number
    readonly inject?: Record<string, unknown>
    readonly error?: unknown
  }
}

interface LoaderService {
  entries(): Iterable<LoaderEntry>
}

/** One row of the boot-time module resolution table (`createRuntimeResolution`). */
interface ResolutionEntry {
  readonly name: string
  readonly packageDir?: string
  readonly version?: string
  readonly declarer?: string
  /** `installation` = carried by the dsh installation; `profile` = carried by a selected bundle. */
  readonly scope?: string
}

interface RuntimeResolution {
  readonly entries: readonly ResolutionEntry[]
}

/** The `@deepseek-ai/dsh-llm` adapter surface this lane has to satisfy. */
interface LlmAdapterLike {
  resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }>
  stream(): AsyncGenerator<never, void, void>
}

interface AgentLoopService {
  create(
    sessionId: unknown,
    model: { readonly provider: string; readonly model: string },
    options: { readonly cwd: string },
  ): Promise<RealAgent>
}

interface RealAgent {
  readonly id: string
  readonly ctx: { get(name: string): unknown }
  readonly session: { readonly id: string }
}

interface RealBootContext {
  readonly fiber: { dispose(): Promise<void> }
  get(name: string): unknown
}

interface DshRuntime {
  SessionId(id: string): unknown
  createStubAdapter(): unknown
}

interface QaLayout {
  readonly root: string
  readonly runtimeHome: string
  readonly dshHome: string
  readonly workspace: string
  readonly bin: string
  readonly packs: string
}

interface Lane {
  readonly ctx: RealBootContext
  readonly dshHome: string
  readonly profileDir: string
  readonly layers: readonly string[]
  /** Where the composed fish-shell layer was resolved (the profile copy, or the checkout under `pnpm run`). */
  readonly fishPackageDir: string
  readonly resolutionEntries: readonly ResolutionEntry[]
  /** Everything the boot wrote to stderr (its activation audit reports inactive rows there). */
  readonly bootDiagnostics: string
  readonly group: LoaderEntry
  readonly row: LoaderEntry | undefined
  readonly terminals: TerminalsService
  readonly tools: ToolsRuntime
  readonly agent: RealAgent
}

let qaRoot = ''
let layout: QaLayout | undefined
let lane: Lane | undefined
const openedSessions: Array<{ readonly sessionId: string; readonly pid: number }> = []
let callCounter = 0
const savedEnvironment = {
  DSH_HOME: process.env.DSH_HOME,
  PNPM_HOME: process.env.PNPM_HOME,
}

function service<T>(ctx: { get(name: string): unknown }, name: string): T {
  const found = ctx.get(name)
  if (found === undefined || found === null) {
    throw new Error(`the booted bundled-row profile is missing the "${name}" service`)
  }
  return found as T
}

function requireLane(): Lane {
  if (lane === undefined) throw new Error('the real bundled-row lane did not boot (see the beforeAll output)')
  return lane
}

/**
 * Child environment for `dsh`/`pnpm`: the QA lane's isolated HOME/PATH/DSH_HOME
 * plus two real-run overrides (`PNPM_HOME` absent by construction, engine
 * manager off because a packed bundle may pin its own `packageManager`).
 */
function childEnvironment(options: {
  readonly qaRoot: string
  readonly runtimeHome: string
  readonly nodeBin: string
  readonly dshBin: string
}): Record<string, string> {
  return {
    ...buildQaEnvironment({
      qaRoot: options.qaRoot,
      runtimeHome: options.runtimeHome,
      nodeBin: options.nodeBin,
      // This lane never renders the QA fixture patch, so the QA_* tool slots
      // stay empty: nothing in its flow reads them.
      codegraph: '',
      rtk: '',
      typescriptLanguageServer: '',
      gopls: '',
      realDsh: options.dshBin,
      go: '',
      loopbackPort: 1,
    }),
    NODE_ENV: 'development',
    npm_config_manage_package_manager_versions: 'false',
  }
}

/**
 * Pack this bundle the way `packBundles` in `scripts/qa/lib/profile.mjs` does
 * (staged copy without `node_modules`, hoisted prod install, hoisted pack) —
 * without that helper's unconditional dsh-tui staging step, which would make
 * this lane skip in the CI `composition` job. The bundled
 * `@deepseek-ai/dsh-tool-terminal` must be a real file inside the tarball, and
 * pnpm refuses to pack bundled dependencies on the default linker.
 */
async function packFishBundle(input: {
  readonly qaRoot: string
  readonly packs: string
  readonly pnpm: string
  readonly environment: Record<string, string>
}): Promise<string> {
  const source = join(repoRoot, 'plugins', 'fish-shell')
  const version = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }).version
  const staged = join(input.qaRoot, 'target-fish-shell')
  rmSync(staged, { recursive: true, force: true })
  cpSync(source, staged, { recursive: true, filter: (entry) => basename(entry) !== 'node_modules' })
  try {
    await runChild(input.pnpm, [
      'install',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
    ], { cwd: staged, env: input.environment })
    await runChild(input.pnpm, [
      '--config.node-linker=hoisted',
      '--dir', staged,
      'pack',
      '--pack-destination', input.packs,
    ], { cwd: input.qaRoot, env: input.environment })
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
  return join(input.packs, `banbolee-dsh-fish-shell-${version}.tgz`)
}

/** The profile's own patch plane: one row that names the BUNDLED package directly. */
function writeProfilePatch(profileDir: string): void {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# The user patch plane of this QA profile. The row below names a package that',
    "# ships INSIDE this bundle's tarball, addressed from the profile plane instead",
    "# of from the bundle's own patch.",
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: '${TOOL_TERMINAL}'`,
  ].join('\n') + '\n')
}

async function loadDshRuntime(dshBin: string): Promise<DshRuntime> {
  const packageRoot = dirname(dirname(resolveDshInstallationBin(dshBin)))
  const llmModule = (await import(
    pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href
  )) as { LlmAdapter: new () => LlmAdapterLike }
  const sessionModule = (await import(
    pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href
  )) as { SessionId(id: string): unknown }
  // The agent loop never runs in this lane (the tools are executed directly),
  // so the adapter only has to satisfy registration.
  class StubAdapter extends llmModule.LlmAdapter {
    resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
      return Promise.resolve({ provider, id: model, name: model })
    }
    override async *stream(): AsyncGenerator<never, void, void> {}
  }
  return {
    SessionId: sessionModule.SessionId,
    createStubAdapter: () => new StubAdapter(),
  }
}

/** Boot with stderr captured: dsh's startup policy reports inactive entries there. */
async function bootCapturingDiagnostics(input: {
  readonly appBoot: AppBootModule
  readonly configPath: string
  readonly patches: readonly unknown[]
  readonly prepare: Awaited<ReturnType<typeof openProfileModuleResolution>>
}): Promise<{ readonly ctx: RealBootContext; readonly stderr: string }> {
  const chunks: string[] = []
  const original = process.stderr.write
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    const ctx = await input.appBoot.boot(
      'dsh',
      input.configPath,
      input.patches as unknown[],
      input.prepare,
    ) as unknown as RealBootContext
    // The activation audit runs as the tree settles; give it its turn before
    // the capture window closes.
    await new Promise((resolve) => { setTimeout(resolve, 250) })
    return { ctx, stderr: chunks.join('') }
  } finally {
    process.stderr.write = original
  }
}

/** Boot the installed profile the way the `dsh` CLI does, then reach into the tree. */
async function bootLane(input: {
  readonly appBoot: AppBootModule
  readonly installAnchor: string
  readonly dshHome: string
  readonly workspaceRoot: string
  readonly runtime: DshRuntime
}): Promise<Lane> {
  const profile = input.appBoot.loadProfile('dsh', PROFILE_NAME, input.installAnchor, input.dshHome)
  const layers = profile.layers.map((layer) => layer.packageName)
  for (const expected of [BASE_BUNDLE, FISH_BUNDLE]) {
    if (!layers.includes(expected)) {
      throw new Error(`the installed profile is missing the ${expected} layer: ${layers.join(', ')}`)
    }
  }
  const fishLayer = profile.layers.find((layer) => layer.packageName === FISH_BUNDLE)
  if (fishLayer === undefined) throw new Error(`the profile carries no ${FISH_BUNDLE} layer to anchor the probe row`)
  const fishPackageDir = fishLayer.packageDir
  // The same table the boot-time resolver interception installs: read it BEFORE
  // any row activates, so "where does the name resolve from" is answered by the
  // resolution itself and not by a failing import later.
  if (typeof input.appBoot.createRuntimeResolution !== 'function') {
    throw new Error('this dsh release has no createRuntimeResolution, so the resolution table cannot be read')
  }
  const resolution = await input.appBoot.createRuntimeResolution({
    installAnchor: input.installAnchor,
    profile,
    home: input.dshHome,
  }) as RuntimeResolution
  // The CLI rewrites the profile root config to the empty entry list on every
  // boot (the whole composition is patch layers); a missing `cordis.yml` would
  // fail the boot, so write the same root here.
  writeFileSync(join(profile.dir, 'cordis.yml'), '[]\n')
  const prepare = await openProfileModuleResolution(input.appBoot, {
    installAnchor: input.installAnchor,
    profile,
    home: input.dshHome,
  })
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]
  const booted = await bootCapturingDiagnostics({
    appBoot: input.appBoot,
    configPath: join(profile.dir, 'cordis.yml'),
    patches,
    prepare,
  })
  const ctx = booted.ctx

  const loader = service<LoaderService>(ctx, 'loader')
  const group = [...loader.entries()].find((entry) => entry.options?.id === GROUP_ID)
  if (group === undefined) throw new Error(`the bundle patch did not mount the "${GROUP_ID}" row`)
  const row = [...loader.entries()].find((entry) => entry.options?.id === ROW_ID)
  const terminals = service<TerminalsService>(group.ctx, 'terminals')
  const tools = service<ToolsRuntime>(ctx, 'tools')

  const llm = service<{ registerAdapter(providers: readonly string[], adapter: unknown): unknown }>(ctx, 'llm')
  llm.registerAdapter([PROVIDER], input.runtime.createStubAdapter())
  const agentLoop = service<AgentLoopService>(ctx, 'agentLoop')
  const agent = await agentLoop.create(
    input.runtime.SessionId(SESSION_NAME),
    { provider: PROVIDER, model: PROVIDER },
    { cwd: input.workspaceRoot },
  )
  return {
    ctx,
    dshHome: input.dshHome,
    profileDir: profile.dir,
    layers,
    fishPackageDir,
    resolutionEntries: resolution.entries,
    bootDiagnostics: booted.stderr,
    group,
    row,
    terminals,
    tools,
    agent,
  }
}

async function callTool<T>(target: Lane, name: string, args: unknown, signalTimeoutMs = 120_000): Promise<T> {
  callCounter += 1
  const result = await target.tools.execute({
    callId: `${SESSION_NAME}-${callCounter}`,
    name,
    arguments: args,
    signal: AbortSignal.timeout(signalTimeoutMs),
    agent: target.agent,
  })
  if (result.isError) {
    const detail = result.error?.message
      ?? result.content?.map((block) => block.text ?? '').join('')
      ?? 'no detail'
    throw new Error(`${name} failed in the real bundled-row lane: ${detail}`)
  }
  return result.value as T
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** `ps -o stat=` state, or undefined when the pid is already reaped. */
function processState(pid: number): string | undefined {
  const probe = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
  if (probe.status !== 0) return undefined
  const state = (probe.stdout ?? '').trim()
  return state.length === 0 ? undefined : state
}

/** Reaped (`ps` fails) or zombie (dead, waiting for its parent) both count as gone. */
async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = processState(pid)
    if (state === undefined || state.startsWith('Z')) return true
    if (Date.now() >= deadline) return false
    await delay(100)
  }
}

describe(
  shouldRun
    ? 'real composition: a profile patch row naming the BUNDLED @deepseek-ai/dsh-tool-terminal'
    : `real composition: NOT RUN — ${skipReason}`,
  () => {
    if (!shouldRun) {
      it.skip(`real bundled-row composition lane skipped — ${skipReason}`, () => {})
      return
    }

    beforeAll(async () => {
      if (missingPrerequisites.length > 0) {
        // Only reachable through RUN_REAL_FISH_TUI=1: the lane is forced open,
        // so a missing prerequisite must not degrade into a green run.
        throw new Error([
          'RUN_REAL_FISH_TUI=1 is open, but this lane cannot run:',
          ...missingPrerequisites.map((entry) => `  - ${entry}`),
          `PATH searched: ${process.env.PATH ?? ''}`,
          'This lane refuses to skip silently once it is forced open.',
        ].join('\n'))
      }
      const dshBin = dshBinary as string
      const pnpmBin = pnpmBinary as string

      qaRoot = assertIsolatedQaRoot(mkdtempSync(join(tmpdir(), 'banbo-dsh-bundled-row-lane-')), repoRoot)
      const qa = createQaLayout(qaRoot) as unknown as QaLayout
      layout = qa
      mkdirSync(qa.workspace, { recursive: true })

      const wrappers = writeToolWrappers(qa, { node: process.execPath, dsh: dshBin, pnpm: pnpmBin })
      const environment = childEnvironment({
        qaRoot,
        runtimeHome: qa.runtimeHome,
        nodeBin: dirname(process.execPath),
        dshBin,
      })

      const fishTarball = await packFishBundle({ qaRoot, packs: qa.packs, pnpm: wrappers.pnpm, environment })
      if (!existsSync(fishTarball)) throw new Error(`the pack step did not produce ${fishTarball}`)

      // The second argument is `installProfile`'s `matrix` slot, which that
      // helper ignores (it only forwards the wrapper, the tarballs and the
      // environment to `dsh plugin --profile dsh-tui add`).
      await installProfile(wrappers.dsh, { bundledRow: true }, [fishTarball], repoRoot, environment)

      const profileDir = join(qa.dshHome, 'profiles', PROFILE_NAME)
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: readonly string[] } }
      }
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!bundles.includes(FISH_BUNDLE) || !bundles.includes(BASE_BUNDLE)) {
        throw new Error(`the profile install did not record both base layers: ${JSON.stringify(bundles)}`)
      }
      writeProfilePatch(profileDir)

      process.env.DSH_HOME = qa.dshHome
      delete process.env.PNPM_HOME
      const { appBoot, installAnchor } = await loadAppBoot(dshBin)
      const runtime = await loadDshRuntime(dshBin)
      lane = await bootLane({
        appBoot,
        installAnchor,
        dshHome: qa.dshHome,
        workspaceRoot: qa.workspace,
        runtime,
      })
    }, 600_000)

    afterAll(async () => {
      const booted = lane
      lane = undefined
      if (booted !== undefined) {
        try {
          for (const session of booted.terminals.list(booted.agent)) {
            await booted.terminals.kill(booted.agent, session.sessionId, 'bundled-row lane teardown').catch(() => {})
          }
        } catch { /* the owner may already be disposed */ }
        try { await booted.ctx.fiber.dispose() } catch { /* best effort */ }
      }
      // Last resort for a PTY that outlived its session: every pid was tracked
      // when its session opened, so it can never become somebody else's process.
      for (const entry of openedSessions) {
        const state = processState(entry.pid)
        if (state === undefined || state.startsWith('Z')) continue
        try { process.kill(entry.pid, 'SIGKILL') } catch { /* already gone */ }
      }
      openedSessions.length = 0
      callCounter = 0
      for (const [key, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      const qa = layout
      layout = undefined
      if (qa !== undefined) {
        try { cleanupQaRuntimeHome(qa) } catch { /* already gone */ }
      }
      if (qaRoot.length > 0) {
        try { rmSync(qaRoot, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      qaRoot = ''
    }, 120_000)

    it('resolves the name from the profile plane inside this bundle, never from the installation', () => {
      const current = requireLane()
      expect(current.layers).toEqual(expect.arrayContaining([BASE_BUNDLE, FISH_BUNDLE]))
      expect(current.profileDir.startsWith(`${current.dshHome}/`)).toBe(true)
      expect(current.dshHome.startsWith(tmpdir())).toBe(true)

      const matches = current.resolutionEntries.filter((entry) => entry.name === TOOL_TERMINAL)
      // The plan's own assumption: nothing in the dsh installation carries the
      // bundled package, so no installation-scope entry may exist.
      expect(matches.filter((entry) => entry.scope === 'installation')).toEqual([])
      expect(matches, `exactly one profile-scope entry, got ${JSON.stringify(matches)}`).toHaveLength(1)
      const entry = matches[0] as ResolutionEntry
      expect(entry.scope).toBe('profile')
      if (entry.packageDir === undefined) throw new Error(`the ${TOOL_TERMINAL} resolution entry carries no packageDir`)

      // The contract: the profile-plane name resolves to the copy THIS BUNDLE
      // ships (its own `node_modules`) and is declared by the bundle's own
      // manifest. It is asserted relative to the composed bundle LAYER rather
      // than to the profile directory, because that layer's provenance depends
      // on how the suite is launched (see the header): under `pnpm
      // test:composition` NODE_PATH makes the installation-first bundle lookup
      // find pnpm's workspace link, so the layer is the checkout; under a bare
      // `node … vitest.mjs` run it is the profile's installed copy. Both must
      // resolve the name INSIDE the bundle, and never from the installation.
      const bundleDir = realpathSync(current.fishPackageDir)
      expect(entry.declarer, `declarer ${entry.declarer}`).toBe(join(bundleDir, 'package.json'))
      expect(realpathSync(entry.packageDir), `packageDir ${entry.packageDir}`).toBe(
        realpathSync(join(bundleDir, 'node_modules', TOOL_TERMINAL)),
      )
    }, 60_000)

    it('mounts the profile-plane row, which stays pending on the entry-local terminals service — so nothing registers twice', () => {
      const current = requireLane()
      const row = current.row
      expect(row, `the profile patch must mount the "${ROW_ID}" row`).toBeDefined()
      expect(row?.options?.name).toBe(TOOL_TERMINAL)
      expect(row?.disabled).toBe(false)
      // Resolution is not activation. The tool package injects `terminals`,
      // which this bundle's group isolates, so at the profile plane the fiber
      // never leaves the pending state (0). It therefore never calls
      // `ctx.tools.register`, and the six names cannot be registered twice.
      expect(row?.fiber?.state, 'the row must not come up (2 would be a live second registration)').toBe(0)
      const missing = Object.keys(row?.fiber?.inject ?? {})
        .filter((name) => row?.ctx.get(name) === undefined)
      expect(missing, 'the one service the profile plane cannot supply').toEqual(['terminals'])
      // …and the boot says so out loud instead of swallowing it.
      expect(current.bootDiagnostics, `boot stderr was:\n${current.bootDiagnostics}`).toContain(
        `${ROW_ID} (${TOOL_TERMINAL}): pending (waiting for service: terminals)`,
      )
      // The row that owns the six names is the bundle's own group, and no row of
      // this composition recorded an activation error.
      expect(current.group.fiber?.state).toBe(2)
      const loader = service<LoaderService>(current.ctx, 'loader')
      const failed = [...loader.entries()]
        .filter((entry) => entry.fiber?.state === 3 && !entry.disabled)
        .map((entry) => entry.options?.id)
      expect(failed, 'no row may record an activation error').toEqual([])
      const pending = [...loader.entries()]
        .filter((entry) => entry.fiber?.state === 0 && !entry.disabled)
        .map((entry) => entry.options?.id)
      expect(pending, 'the probe row is the only inactive row').toEqual([ROW_ID])
    }, 60_000)

    it('keeps each of the six terminal_* tools registered exactly once and visible to the agent', () => {
      const current = requireLane()
      const agentTools = service<ToolsRuntime>(current.agent.ctx, 'tools')
      const agentSchemas = current.tools.schemas(current.agent).map((schema) => schema.name)
      const hostSchemas = current.tools.schemas().map((schema) => schema.name)
      for (const name of TERMINAL_TOOL_NAMES) {
        expect(current.tools.get(name, current.agent), `tools.get('${name}', agent)`).toBeDefined()
        expect(typeof current.tools.get(name, current.agent)?.execute, `${name}.execute`).toBe('function')
        expect(agentTools.get(name), `agent-scoped tools.get('${name}')`).toBeDefined()
        expect(agentSchemas.filter((entry) => entry === name), `agent schema ${name} appears once`).toHaveLength(1)
        expect(hostSchemas.filter((entry) => entry === name), `host schema ${name} appears once`).toHaveLength(1)
      }
    }, 60_000)

    it('still drives the surviving registration end to end: a real fish PTY opens and closes cleanly', async () => {
      const current = requireLane()
      const qa = layout
      if (qa === undefined) throw new Error('the QA layout was torn down before this test')
      const opened = await callTool<{
        sessionId: string
        type: string
        pid?: number
        status: { readonly kind: string }
        motd: string
      }>(current, 'terminal_open', { type: 'shell', name: SESSION_NAME, cwd: qa.workspace })

      expect(opened.type).toBe('shell')
      expect(opened.motd).toContain('dsh>')
      expect(opened.status.kind).toBe('running')
      if (opened.pid === undefined) throw new Error('terminal_open reported no PTY pid')
      openedSessions.push({ sessionId: opened.sessionId, pid: opened.pid })

      const closed = await callTool<{ sessionId: string; outcome: string }>(current, 'terminal_close', {
        sessionId: opened.sessionId,
      })
      expect(closed.outcome).toBe('closed')
      const listed = await callTool<readonly SessionSnapshot[]>(current, 'terminal_list', {})
      expect(listed).toEqual([])
      expect(current.terminals.hasOwnerActivity(current.agent)).toBe(false)
      expect(await waitForProcessGone(opened.pid, 15_000)).toBe(true)

      const index = openedSessions.findIndex((entry) => entry.sessionId === opened.sessionId)
      if (index >= 0) openedSessions.splice(index, 1)
    }, 120_000)
  },
)
