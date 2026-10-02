/**
 * REAL dsh-tui composition lane for the fish-shell L2 interactive terminal.
 *
 * `.omo/plans/fish-shell-tty-v3.md` §5.2 adds the `fish-terminal-group` isolate
 * group (official `@deepseek-ai/dsh-terminal` + this bundle's `terminal.js`, the
 * official `dsh-terminal-bash` backend with a fish argv and the harness home
 * contract + `dsh-tool-terminal` + this bundle's `terminal-tools` switch) and
 * §10's
 * v1 gate 1 requires the six `terminal_*` tools and the whole
 * `open → send → read → close` chain to work **in a real profile including the
 * dsh-tui combination**. The user's real deployment IS dsh-tui, so the existing
 * `@deepseek-ai/dsh-base` real lane
 * (`plugins/fish-shell/tests/terminal-session-real.spec.ts`) does not cover the
 * composition that actually ships: this lane adds the `dsh-tui` bundle layer
 * (whose 24 KB patch is applied last, over dsh-base and over this bundle).
 *
 * What it builds (all of it through the repository's own QA infra, no
 * hand-written profile overlay):
 *
 *   - `createQaLayout` + `writeToolWrappers` give an isolated QA tree whose
 *     `dsh`/`pnpm` children come from wrappers on a private PATH;
 *   - `packBundles` packs the real global `@deepseek-harness-tui/dsh-tui`
 *     installation (staged copy + hoisted pack) and this bundle's packed shape
 *     (staged `pnpm install --prod` + hoisted pack, so the bundled
 *     `@deepseek-ai/dsh-tool-terminal` lands inside the tarball);
 *   - `installProfile` installs both into `$DSH_HOME/profiles/dsh-tui` with the
 *     real `dsh plugin add` CLI, `--offline`, under a fresh temporary
 *     `$DSH_HOME` (the real `~/.config/dsh` is never read or written);
 *   - the profile is then booted in-process exactly like the `dsh` CLI boots it
 *     (`loadProfile` → root `cordis.yml` rewritten to the empty root →
 *     `createRuntimeResolution`/`PluginPackages` prepare hook → the bundle
 *     layers' patches + the profile's own empty user layer), so a real
 *     `agentLoop` session can be created and the six tools driven through the
 *     real `tools` registry.
 *
 * Assertions (all of them are the L2 surface, none of them is a smoke print):
 * the bundle layer + the dsh-tui layer are both in the composition, the
 * `fish-terminal-group` row mounted, `terminals` is isolated into that group
 * while all six `terminal_*` tools are visible to the real agent (registry,
 * agent-scoped registry, host and agent schemas), the backend is this bundle's
 * `terminal.js` — the official `dsh-terminal-bash` class — configured with
 * `shellPath: fish`, `terminal_open` gets a
 * live fish PTY whose motd carries `dsh>`, `terminal_send` settles with the
 * command output in its viewport and a non-empty `waitReason`, `terminal_read`
 * reads the same scrollback back, and `terminal_close` empties `terminal_list`
 * and leaves no PTY process behind. Signal delivery and background jobs are
 * deliberately NOT repeated here: the dsh-base real lane already covers them on
 * the same bundle.
 *
 * Interactive rows are ASSERTED, not explained away: `packBundles` packs the
 * published `bundledDependencies` together with the dependency set (union — see
 * `stageTuiPackage` in `scripts/qa/lib/profile.mjs`), so the QA tarball carries
 * the vendored `@dsh-std/*`, the mathjax vendor copy and the bundled
 * `@deepseek-harness-tui/dsh-auth` that the `plugin-host`, `extensions` and
 * `oauth` rows import. Those three rows and the front door therefore activate;
 * the assertions below pin their cordis fiber state and the services they own,
 * because while the packing path overwrote that list the three rows failed
 * their imports and the `dsh-tui` row stayed pending on the `tui*` services —
 * a gap of the QA packing path, never of this bundle.
 *
 * Gating: this lane needs the global `dsh` CLI, a global `dsh-tui` beside it,
 * `fish` and `pnpm`. When a prerequisite is missing it does not report a silent
 * pass — it registers a SKIPPED test whose name names what is missing.
 * `RUN_REAL_FISH_TUI=1` forces the lane open and then a missing prerequisite
 * FAILS LOUD with an install hint instead.
 *
 * Cleanup: every session is closed, every leftover PTY pid is killed, the
 * booted tree is disposed, `DSH_HOME`/`PNPM_HOME` are restored, the QA runtime
 * home symlink is removed and the whole temporary tree is deleted.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertIsolatedQaRoot,
  buildQaEnvironment,
  cleanupQaRuntimeHome,
  createQaLayout,
} from '../../scripts/qa/lib/environment.mjs'
import {
  installProfile,
  packBundles,
  targetTuiPackagePath,
  writeToolWrappers,
} from '../../scripts/qa/lib/profile.mjs'
import {
  loadAppBoot,
  openProfileModuleResolution,
  repoRoot,
  resolveDshInstallationBin,
  type AppBootModule,
} from './profile-loader'

const FORCED = process.env.RUN_REAL_FISH_TUI === '1'
/** `installProfile` hard-codes this name, so the in-process boot must use it too. */
const PROFILE_NAME = 'dsh-tui'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const FISH_BUNDLE = '@banbolee/dsh-fish-shell'
const TUI_BUNDLE = '@deepseek-harness-tui/dsh-tui'
const GROUP_ID = 'fish-terminal-group'
const TUI_ROW_ID = 'dsh-tui'
/**
 * The interactive dsh-tui rows and the services each one owns (its patch rows):
 * `dsh-tui-plugin-host` is the plugin-interop anchor (`ctx.tuiPluginHost`),
 * `dsh-tui-extensions` mounts the plugin-facing UI seams, `dsh-tui-auth` owns
 * subscription OAuth (`ctx.dshAuth`), and the front door row (`dsh-tui`)
 * injects every one of them. Before the QA packing fix the first three could
 * not import their vendored bundles at all.
 */
const INTERACTIVE_ROWS: ReadonlyArray<{ readonly id: string, readonly services: readonly string[] }> = [
  { id: 'dsh-tui-plugin-host', services: ['tuiPluginHost'] },
  { id: 'dsh-tui-extensions', services: ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiToast', 'tuiThemes'] },
  { id: 'dsh-tui-auth', services: ['dshAuth'] },
  { id: TUI_ROW_ID, services: [] },
]
const SESSION_NAME = 'dsh-tui-main'
const SENTINEL = 'DSH_TUI_LANE_SENTINEL'
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
const TUI_HINT = 'install it beside the global dsh CLI with `npm install -g @deepseek-harness-tui/dsh-tui@0.11.2`'
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
/** The globally installed dsh-tui package `targetTuiPackagePath` resolves beside `dsh`. */
const tuiPackage: string | undefined = dshBinary === undefined
  ? undefined
  : (() => {
    try {
      const candidate = targetTuiPackagePath(realpathSync(dshBinary))
      return existsSync(join(candidate, 'package.json')) ? candidate : undefined
    } catch {
      return undefined
    }
  })()

const missingPrerequisites = [
  ...(dshBinary === undefined ? [`the \`dsh\` CLI on PATH — ${DSH_HINT}`] : []),
  ...(tuiPackage === undefined ? [`the global ${TUI_BUNDLE} package — ${TUI_HINT}`] : []),
  ...(fishBinary === undefined ? [`the \`fish\` shell on PATH — ${FISH_HINT}`] : []),
  ...(pnpmBinary === undefined ? ['`pnpm` on PATH (the pack and profile-install steps run through it)'] : []),
]
/**
 * A missing prerequisite is a SKIP with its reason spelled out, never a silent
 * pass — but `RUN_REAL_FISH_TUI=1` turns the same condition into a fail-loud
 * setup error, like the other real lanes of this repository.
 */
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

interface TerminalToolDefinition {
  readonly name: string
  readonly execute?: unknown
}

interface ToolsRuntime {
  get(name: string, scope?: unknown): TerminalToolDefinition | undefined
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

interface TerminalBackendLike {
  readonly type: string
  readonly config?: { readonly shellPath?: string; readonly shellArgs?: readonly string[] }
}

interface TerminalsService {
  listBackends(): readonly string[]
  readonly backends?: ReadonlyMap<string, TerminalBackendLike>
  list(owner: unknown): readonly SessionSnapshot[]
  kill(owner: unknown, sessionId: string, reason?: string): Promise<boolean>
  hasOwnerActivity(owner: unknown): boolean
}

interface LoaderEntry {
  readonly options?: { readonly id?: string; readonly name?: string }
  readonly disabled?: boolean
  readonly ctx: { get(name: string): unknown }
  /** Cordis fiber state: 2 running, 3 activation error, 0 pending (`_getState`). */
  readonly fiber?: { readonly state?: number }
}

interface LoaderService {
  entries(): Iterable<LoaderEntry>
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
  readonly group: LoaderEntry
  readonly terminals: TerminalsService
  readonly tools: ToolsRuntime
  readonly agent: RealAgent
}

let qaRoot = ''
let layout: QaLayout | undefined
let lane: Lane | undefined
let mainSession: { readonly sessionId: string; readonly pid: number } | undefined
const openedSessions: Array<{ readonly sessionId: string; readonly pid: number }> = []
let callCounter = 0
const savedEnvironment = {
  DSH_HOME: process.env.DSH_HOME,
  PNPM_HOME: process.env.PNPM_HOME,
}

function service<T>(ctx: { get(name: string): unknown }, name: string): T {
  const found = ctx.get(name)
  if (found === undefined || found === null) throw new Error(`the booted dsh-tui profile is missing the "${name}" service`)
  return found as T
}

function requireLane(): Lane {
  if (lane === undefined) throw new Error('the real dsh-tui lane did not boot (see the beforeAll output)')
  return lane
}

function requireMainSession(): { readonly sessionId: string; readonly pid: number } {
  if (mainSession === undefined) throw new Error('the terminal session was not opened by an earlier test')
  return mainSession
}

/**
 * Child environment for `dsh`/`pnpm`: the QA lane's isolated HOME/PATH/DSH_HOME
 * plus two real-run overrides. `PNPM_HOME` is absent by construction (the
 * package-manager env dir it names may be unwritable, which makes every pnpm
 * child fail), and the engine manager is switched off because the dsh-tui
 * package pins `packageManager: pnpm@11.21.0`, whose engine store lives under
 * the REAL home that this lane deliberately does not use.
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
  for (const expected of [BASE_BUNDLE, FISH_BUNDLE, TUI_BUNDLE]) {
    if (!layers.includes(expected)) {
      throw new Error(`the installed dsh-tui profile is missing the ${expected} layer: ${layers.join(', ')}`)
    }
  }
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
  const ctx = await input.appBoot.boot(
    'dsh',
    join(profile.dir, 'cordis.yml'),
    patches,
    prepare,
  ) as unknown as RealBootContext

  const loader = service<LoaderService>(ctx, 'loader')
  const group = [...loader.entries()].find((entry) => entry.options?.id === GROUP_ID)
  if (group === undefined) throw new Error(`the bundle patch did not mount the "${GROUP_ID}" row inside the dsh-tui profile`)
  const tuiRow = [...loader.entries()].find((entry) => entry.options?.id === TUI_ROW_ID)
  if (tuiRow === undefined || tuiRow.options?.name !== TUI_BUNDLE) {
    throw new Error(`the dsh-tui bundle patch did not contribute its "${TUI_ROW_ID}" row`)
  }
  const terminals = service<TerminalsService>(group.ctx, 'terminals')
  const tools = service<ToolsRuntime>(ctx, 'tools')

  const llm = service<{ registerAdapter(providers: readonly string[], adapter: unknown): unknown }>(ctx, 'llm')
  llm.registerAdapter(['dsh-tui-lane-mock'], input.runtime.createStubAdapter())
  const agentLoop = service<AgentLoopService>(ctx, 'agentLoop')
  const agent = await agentLoop.create(
    input.runtime.SessionId(SESSION_NAME),
    { provider: 'dsh-tui-lane-mock', model: 'dsh-tui-lane-mock' },
    { cwd: input.workspaceRoot },
  )
  return { ctx, dshHome: input.dshHome, profileDir: profile.dir, layers, group, terminals, tools, agent }
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
    throw new Error(`${name} failed in the real dsh-tui lane: ${detail}`)
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
    ? 'real dsh-tui composition: the fish L2 terminal surface works inside a real dsh-tui profile'
    : `real dsh-tui composition: NOT RUN — ${skipReason}`,
  () => {
    if (!shouldRun) {
      it.skip(`real dsh-tui composition lane skipped — ${skipReason}`, () => {})
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
      const tuiDir = tuiPackage as string

      qaRoot = assertIsolatedQaRoot(mkdtempSync(join(tmpdir(), 'banbo-dsh-tui-lane-')), repoRoot)
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

      const tuiVersion = (JSON.parse(readFileSync(join(tuiDir, 'package.json'), 'utf8')) as { version: string }).version
      const fishVersion = (JSON.parse(
        readFileSync(join(repoRoot, 'plugins', 'fish-shell', 'package.json'), 'utf8'),
      ) as { version: string }).version

      // `packBundles` has no subset parameter: it packs the dsh-tui installation
      // and every bundle of the QA matrix. Only the two layers this lane needs
      // are installed (see the header): extra bundles would drag rtk/codegraph/
      // lsp rows into a profile that is here to prove ONE composition.
      const tarballs = await packBundles(repoRoot, qa, wrappers.pnpm, environment, tuiDir) as string[]
      const wanted = [
        join(qa.packs, `deepseek-harness-tui-dsh-tui-${tuiVersion}.tgz`),
        join(qa.packs, `banbolee-dsh-fish-shell-${fishVersion}.tgz`),
      ]
      for (const tarball of wanted) {
        if (!existsSync(tarball)) {
          throw new Error(`the QA pack step did not produce ${tarball}; it produced:\n${tarballs.join('\n')}`)
        }
      }
      // The second argument is `installProfile`'s `matrix` slot, which that
      // helper ignores (it only forwards the wrapper, the tarballs and the
      // environment to `dsh plugin --profile dsh-tui add`).
      await installProfile(wrappers.dsh, { dshTui: tuiVersion }, wanted, repoRoot, environment)

      const profileDir = join(qa.dshHome, 'profiles', PROFILE_NAME)
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: readonly string[] } }
      }
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!bundles.includes(FISH_BUNDLE) || !bundles.includes(TUI_BUNDLE)) {
        throw new Error(`the profile install did not record both layers: ${JSON.stringify(bundles)}`)
      }

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
            await booted.terminals.kill(booted.agent, session.sessionId, 'dsh-tui lane teardown').catch(() => {})
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
      mainSession = undefined
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

    it('mounts the bundle group inside the dsh-tui composition and exposes all six terminal_* tools to a real agent', () => {
      const current = requireLane()
      // The composition really carries the dsh-tui layer, and the whole QA tree
      // is temporary: the real `~/.config/dsh` was never touched.
      expect(current.layers).toEqual(expect.arrayContaining([BASE_BUNDLE, FISH_BUNDLE, TUI_BUNDLE]))
      expect(current.profileDir.startsWith(`${current.dshHome}/`)).toBe(true)
      expect(current.dshHome.startsWith(tmpdir())).toBe(true)

      // §2.9 realm boundary: `terminals` is entry-local to the group while the
      // six tools register into the shared host tools registry.
      expect(current.ctx.get('terminals')).toBeUndefined()
      expect(current.group.options?.name).toBe('cordis:group')

      const backends = current.terminals.listBackends()
      expect(backends.length).toBeGreaterThan(0)
      expect(backends).toContain('shell')
      const shellBackend = current.terminals.backends?.get('shell')
      expect(shellBackend?.type).toBe('shell')
      expect(shellBackend?.config?.shellPath).toBe('fish')

      const agentTools = service<ToolsRuntime>(current.agent.ctx, 'tools')
      for (const name of TERMINAL_TOOL_NAMES) {
        const hostScoped = current.tools.get(name, current.agent)
        expect(hostScoped, `tools.get('${name}', agent)`).toBeDefined()
        expect(typeof hostScoped?.execute, `${name}.execute`).toBe('function')
        expect(agentTools.get(name), `agent-scoped tools.get('${name}')`).toBeDefined()
      }

      const agentSchemas = current.tools.schemas(current.agent).map((schema) => schema.name)
      for (const name of TERMINAL_TOOL_NAMES) expect(agentSchemas, `agent schema ${name}`).toContain(name)
      const hostSchemas = current.tools.schemas().map((schema) => schema.name)
      for (const name of TERMINAL_TOOL_NAMES) expect(hostSchemas, `host schema ${name}`).toContain(name)

      // The bundle's host plane still replaced bash with fish, and `bash` stays
      // hidden from this agent.
      expect(agentSchemas).toContain('fish')
      expect(agentSchemas).not.toContain('bash')
    }, 60_000)

    it('activates the interactive dsh-tui rows instead of leaving them pending', () => {
      const current = requireLane()
      const loader = service<LoaderService>(current.ctx, 'loader')
      const rows = [...loader.entries()]

      // Cordis fiber states (`_getState` in cordis/lib/index.js): 2 running,
      // 3 activation (import) error, 0 pending. A row whose activation never
      // completed reports either 0 or no fiber at all (verified by reverting the
      // packing fix: `dsh-tui-plugin-host` then fails this assertion), so 2 is
      // the only value that proves the row really came up.
      for (const row of INTERACTIVE_ROWS) {
        const entry = rows.find((candidate) => candidate.options?.id === row.id)
        expect(entry, `the composed patch must mount the "${row.id}" row`).toBeDefined()
        expect(entry?.disabled, `"${row.id}" must not be administratively disabled`).toBe(false)
        expect(
          entry?.fiber?.state,
          `"${row.id}" must be running (2) — pending rows report 0 or no fiber, import failures report 3`,
        ).toBe(2)
      }

      // The services those rows own are reachable from the composition root:
      // a pending or import-failed row never provides them.
      for (const row of INTERACTIVE_ROWS) {
        for (const name of row.services) {
          expect(current.ctx.get(name), `"${row.id}" must provide ${name}`).toBeDefined()
        }
      }
    }, 60_000)

    it('opens a real fish PTY whose motd carries the dsh prompt', async () => {
      const current = requireLane()
      const qa = layout
      if (qa === undefined) throw new Error('the QA layout was torn down before this test')
      const opened = await callTool<{
        sessionId: string
        name?: string
        type: string
        pid?: number
        status: { kind: string }
        motd: string
      }>(current, 'terminal_open', { type: 'shell', name: SESSION_NAME, cwd: qa.workspace })

      expect(opened.type).toBe('shell')
      expect(opened.motd).toContain('dsh>')
      expect(opened.status.kind).toBe('running')
      if (opened.pid === undefined) throw new Error('terminal_open reported no PTY pid')
      mainSession = { sessionId: opened.sessionId, pid: opened.pid }
      openedSessions.push({ sessionId: opened.sessionId, pid: opened.pid })
    }, 90_000)

    it('sends input, settles with a wait reason, and reads the output back', async () => {
      const current = requireLane()
      const session = requireMainSession()

      const sent = await callTool<{
        kind: string
        viewport: string
        waitReason: string
        sessionStatus: { kind: string }
      }>(current, 'terminal_send', {
        sessionId: session.sessionId,
        text: `echo ${SENTINEL}; echo SHELL_VERSION=$FISH_VERSION`,
      })
      expect(sent.kind).toBe('foreground')
      expect(sent.viewport).toContain(SENTINEL)
      expect(sent.waitReason.length).toBeGreaterThan(0)
      expect(sent.sessionStatus.kind).toBe('running')
      // Version shape only: CI fish differs from the developer machine's fish.
      expect(sent.viewport).toMatch(/SHELL_VERSION=\d+\.\d+\.\d+/)

      const read = await callTool<{ text: string; totalLines: number; lineEnd: number }>(
        current,
        'terminal_read',
        { sessionId: session.sessionId },
      )
      expect(read.text).toContain(SENTINEL)
      expect(read.text).toMatch(/SHELL_VERSION=\d+\.\d+\.\d+/)
      expect(read.totalLines).toBeGreaterThan(0)

      const listed = await callTool<readonly SessionSnapshot[]>(current, 'terminal_list', {})
      expect(listed.map((entry) => entry.sessionId)).toContain(session.sessionId)
    }, 120_000)

    it('closes the session, then lists nothing and leaves no process behind', async () => {
      const current = requireLane()
      const session = requireMainSession()

      const closed = await callTool<{ sessionId: string; outcome: string }>(current, 'terminal_close', {
        sessionId: session.sessionId,
      })
      expect(closed.outcome).toBe('closed')

      const listed = await callTool<readonly SessionSnapshot[]>(current, 'terminal_list', {})
      expect(listed).toEqual([])
      expect(current.terminals.hasOwnerActivity(current.agent)).toBe(false)
      expect(await waitForProcessGone(session.pid, 15_000)).toBe(true)

      const index = openedSessions.findIndex((entry) => entry.sessionId === session.sessionId)
      if (index >= 0) openedSessions.splice(index, 1)
      mainSession = undefined
    }, 120_000)
  },
)
