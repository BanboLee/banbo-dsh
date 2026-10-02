/**
 * REAL `minimal`-preset composition lane for the fish-shell L2 interactive
 * terminal: the second half of `.omo/plans/fish-shell-tty-v3.md` §9 item 1
 * (the dsh-tui half is `fish-pty-dsh-tui.spec.ts`).
 *
 * What it builds, entirely through this repository's own QA infra:
 *
 *   - `createQaLayout` + `writeToolWrappers` give an isolated QA tree whose
 *     `dsh`/`pnpm` children come from wrappers on a private PATH;
 *   - this bundle is packed exactly the way `scripts/qa/lib/profile.mjs` packs
 *     it for `packBundles` — a staged copy (no `node_modules`), a hoisted
 *     `--prod --config.auto-install-peers=false` install, then a hoisted
 *     `pack` — so the bundled `@deepseek-ai/dsh-tool-terminal` lands inside the
 *     tarball. `packBundles` itself is NOT used here: it stages and packs the
 *     global `@deepseek-harness-tui/dsh-tui` installation first, and this lane
 *     deliberately does not depend on dsh-tui (the CI `composition` job does
 *     not install it). A lane that could only ever skip is not a lane;
 *   - `installProfile` installs that ONE tarball into `$DSH_HOME/profiles/dsh-tui`
 *     with the real `dsh plugin add` CLI, `--offline`, under a fresh temporary
 *     `$DSH_HOME`. The profile name is hard-coded by the helper; the
 *     composition is dsh-base + this bundle, NOT the dsh-tui one, and the lane
 *     asserts that (`dsh-base` is the profile's implicit first layer);
 *   - the profile's own patch plane (`cordis.patch.yml`, the documented way a
 *     user declares a preset) then carries two things:
 *       1. the `agent-preset-registry` row the official `web` bundle ships —
 *          dsh-base carries no preset roster, so without it a declared preset
 *          has nothing to register into — with `default: minimal`;
 *       2. the OFFICIAL minimal preset declaration, read byte-for-byte from the
 *          installed `@deepseek-ai/dsh-web-app` package's
 *          `presets/minimal.patch.yml`. The minimal preset is NOT declared by
 *          dsh-base: in 0.2.0-rc.1 it is one of the ordered patch files of
 *          `@deepseek-ai/dsh-web-app` (`dsh.bundle.patch` lists
 *          `./presets/{standard,ptc,minimal,cordis}.patch.yml`), and
 *          `@deepseek-ai/dsh-agent-preset` is only the generic declaration
 *          plugin that registers such a row into the registry. This lane
 *          therefore takes the official text as data rather than transcribing
 *          it, and asserts the file it read is the minimal declaration.
 *   - the profile is booted in-process exactly like the `dsh` CLI boots it
 *     (`loadProfile` → root `cordis.yml` rewritten to the empty root →
 *     `createRuntimeResolution`/`PluginPackages` prepare hook → the bundle
 *     layers' patches + the profile's own patch plane), and the agent is
 *     created the way the API session controller creates one: through
 *     `ctx.agents.create` with a setup callback that calls
 *     `agentPresets.mount(agentCtx, 'minimal')`, so the agent really runs
 *     INSIDE the minimal preset realm.
 *
 * Assertions (the L2 surface plus the coexistence question):
 *   - both layers are in the composition and the dsh-tui layer is not;
 *   - the host-plane `fish-terminal-group` row mounted, and `terminals` is
 *     entry-local to it (invisible at the composition root);
 *   - the minimal preset mounted EVERY row: `resolve('minimal')` reports no
 *     `broken` activation (the registry's mount audit rejects a subtree with a
 *     failed row or with a service leaked into the root realm), the agent is
 *     bound to it (`composedPreset`), and it is the configured default;
 *   - the two `terminals` registries coexist as separate instances: the host
 *     group's is the fish-configured official backend, the preset realm's is
 *     the minimal preset's own bash backend (`shellPath` unset) — this is the
 *     realm boundary §3.2 predicted, asserted rather than explained away;
 *   - all six `terminal_*` tools are visible to the preset-bound agent, each
 *     name exactly ONCE in both the agent and host schema lists: the minimal
 *     preset's `persistent-shell` group and this bundle's `fish-terminal-group`
 *     register no shared name, so there is no double registration;
 *   - the policy really swapped the preset's persistent bash for persistent
 *     fish in this composition: the agent sees `fish` and no `bash`, and the
 *     agent-scoped `fish` is the PERSISTENT form (parameters carry only
 *     `command`, the one-shot host tool has `description` too) that shadows
 *     the global one. Its state survives across two calls, which is what
 *     "minimal keeps its persistent semantics in fish" means;
 *   - the six tools themselves are the host group's own definitions (object
 *     identity), so the preset-layer swap did not shadow or duplicate them;
 *   - the L2 chain works while the preset is mounted: `terminal_open` gets a
 *     live fish PTY whose motd carries `dsh>`, `terminal_send` settles with the
 *     command output and a non-empty `waitReason`, `terminal_read` reads the
 *     same scrollback back, and `terminal_close` empties the listing and
 *     leaves no PTY process behind.
 *
 * Gating: this lane needs the global `dsh` CLI, `fish`, `pnpm`, and the
 * installed `@deepseek-ai/dsh-web-app` preset declarations beside the `dsh`
 * installation. When a prerequisite is missing it registers a SKIPPED test
 * whose name names what is missing — never a silent pass. `RUN_REAL_FISH_TUI=1`
 * forces the lane open, and then a missing prerequisite FAILS LOUD.
 *
 * Cleanup: the agent handle and the booted tree are disposed, every leftover
 * PTY pid is killed (including any fish child of this process), `DSH_HOME`/
 * `PNPM_HOME` are restored, the QA runtime home symlink is removed and the
 * whole temporary tree is deleted. The real `~/.config/dsh` is never read or
 * written.
 */

import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const TUI_BUNDLE = '@deepseek-harness-tui/dsh-tui'
const WEB_APP = '@deepseek-ai/dsh-web-app'
const GROUP_ID = 'fish-terminal-group'
const PRESET_ID = 'minimal'
const PROVIDER = 'fish-minimal-lane-mock'
const SESSION_NAME = 'fish-pty-minimal'
const SENTINEL = 'FISH_MINIMAL_LANE_SENTINEL'
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
const WEB_APP_HINT = `install a dsh release that ships ${WEB_APP} (the \`web\` profile template)`

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
/** The `@deepseek-ai/dsh` package directory the CLI binary belongs to. */
const installationRoot = dshBinary === undefined
  ? undefined
  : dirname(dirname(resolveDshInstallationBin(dshBinary)))
/**
 * The OFFICIAL minimal preset declaration, resolved through the installation's
 * own module resolution (so a pnpm-shaped global install works as well as the
 * flat npm one). dsh-base ships no preset roster: in 0.2.0-rc.1 the built-in
 * presets are ordered patch files of `@deepseek-ai/dsh-web-app`.
 */
const officialPresetFile: string | undefined = (() => {
  if (installationRoot === undefined) return undefined
  try {
    const require = createRequire(join(installationRoot, 'package.json'))
    const packageDir = dirname(require.resolve(`${WEB_APP}/package.json`))
    return join(packageDir, 'presets', 'minimal.patch.yml')
  } catch {
    return undefined
  }
})()

const missingPrerequisites = [
  ...(dshBinary === undefined ? [`the \`dsh\` CLI on PATH — ${DSH_HINT}`] : []),
  ...(fishBinary === undefined ? [`the \`fish\` shell on PATH — ${FISH_HINT}`] : []),
  ...(pnpmBinary === undefined ? ['`pnpm` on PATH (the pack and profile-install steps run through it)'] : []),
  ...(officialPresetFile === undefined
    ? [`the installed ${WEB_APP} preset declarations beside the \`dsh\` CLI — ${WEB_APP_HINT}`]
    : []),
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

interface ToolDefinition {
  readonly name?: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
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

/** The `@deepseek-ai/dsh-agent-preset-registry` surface this lane drives. */
interface PresetRegistryService {
  readonly defaultId: string
  /** Registry-owned mount audit: any failed row or leaked service surfaces as `broken`. */
  resolve(id?: string): Promise<{ readonly id: string; readonly broken?: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ readonly id: string }>
  composedPreset(ctx: unknown): string | undefined
  /** The agent's instance of a service its preset realm mounted. */
  serviceFor(agent: unknown, name: string): unknown
}

interface RealAgent {
  readonly id: string
  readonly ctx: { get(name: string): unknown }
  readonly session: { readonly id: string }
}

/** The `@deepseek-ai/dsh-agent` registry's `create` (an owned agent + disposer). */
interface AgentsService {
  create(options: {
    readonly sessionId: unknown
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: { readonly provider?: string; readonly model?: string }
    readonly setup?: (agentCtx: unknown, agent: RealAgent) => Promise<void> | void
  }): Promise<{ readonly agent: RealAgent; dispose(): Promise<void> }>
}

interface RealBootContext {
  readonly fiber: { dispose(): Promise<void> }
  get(name: string): unknown
}

interface DshRuntime {
  SessionId(id: string): unknown
  createStubAdapter(): unknown
}

/** The `@deepseek-ai/dsh-llm` adapter surface this lane has to satisfy. */
interface LlmAdapterLike {
  resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }>
  stream(): AsyncGenerator<never, void, void>
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
  readonly hostGroup: LoaderEntry
  readonly terminals: TerminalsService
  readonly tools: ToolsRuntime
  readonly presets: PresetRegistryService
  readonly agent: RealAgent
  readonly disposeAgent: () => Promise<void>
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
  if (found === undefined || found === null) {
    throw new Error(`the booted minimal-preset profile is missing the "${name}" service`)
  }
  return found as T
}

function requireLane(): Lane {
  if (lane === undefined) throw new Error('the real minimal-preset lane did not boot (see the beforeAll output)')
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
 * child fail), and the engine manager is switched off because a packed bundle
 * can pin a `packageManager` whose engine store lives under the REAL home that
 * this lane deliberately does not use.
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
 * without that helper's unconditional dsh-tui staging step (see the header).
 * The bundled `@deepseek-ai/dsh-tool-terminal` must be a real file inside the
 * tarball, and pnpm refuses to pack bundled dependencies on the default linker.
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

/**
 * Write the profile's own patch plane: the registry row the official `web`
 * bundle ships (dsh-base carries none) with `default: minimal`, then the
 * official minimal declaration verbatim.
 */
function writeProfilePatch(profileDir: string, officialPreset: string): void {
  const presetText = officialPreset.endsWith('\n') ? officialPreset : `${officialPreset}\n`
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# The user patch plane of this QA profile. dsh-base ships no preset roster,',
    '# so the registry the official `web` bundle declares is restated here with',
    '# `minimal` as the default; the declaration below is copied verbatim.',
    '- insert:',
    '    - id: agent-preset-registry',
    "      name: '@deepseek-ai/dsh-agent-preset-registry'",
    '      config:',
    `        default: ${PRESET_ID}`,
    '',
    `# ── ${WEB_APP}/presets/minimal.patch.yml, byte for byte ──`,
    presetText,
  ].join('\n'))
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

/** Boot the installed profile the way the `dsh` CLI does, then bind a minimal agent. */
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
  if (layers.includes(TUI_BUNDLE)) {
    throw new Error(`this lane proves the minimal-preset composition, but the profile carries ${TUI_BUNDLE}`)
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
  const hostGroup = [...loader.entries()].find((entry) => entry.options?.id === GROUP_ID)
  if (hostGroup === undefined) throw new Error(`the bundle patch did not mount the "${GROUP_ID}" row`)
  const terminals = service<TerminalsService>(hostGroup.ctx, 'terminals')
  const tools = service<ToolsRuntime>(ctx, 'tools')
  const presets = service<PresetRegistryService>(ctx, 'agentPresets')
  const agents = service<AgentsService>(ctx, 'agents')

  const llm = service<{ registerAdapter(providers: readonly string[], adapter: unknown): unknown }>(ctx, 'llm')
  llm.registerAdapter([PROVIDER], input.runtime.createStubAdapter())
  // The API session controller's own creation shape: the setup callback binds
  // the still-unpublished agent to the preset before it is announced.
  const handle = await agents.create({
    sessionId: input.runtime.SessionId(SESSION_NAME),
    meta: { cwd: input.workspaceRoot, agentPreset: PRESET_ID },
    agentOptions: { provider: PROVIDER, model: PROVIDER },
    setup: async (agentCtx) => { await presets.mount(agentCtx, PRESET_ID) },
  })
  return {
    ctx,
    dshHome: input.dshHome,
    profileDir: profile.dir,
    layers,
    hostGroup,
    terminals,
    tools,
    presets,
    agent: handle.agent,
    disposeAgent: () => handle.dispose(),
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
    throw new Error(`${name} failed in the real minimal-preset lane: ${detail}`)
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

/** Every `fish` process this node process still owns (a PTY that outlived its session). */
function ownFishChildren(): number[] {
  const probe = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  if (probe.status !== 0) return []
  const pids: number[] = []
  for (const line of (probe.stdout ?? '').split('\n')) {
    const [pid, ppid, comm] = line.trim().split(/\s+/)
    if (pid === undefined || ppid === undefined || comm === undefined) continue
    if (ppid !== String(process.pid) || comm !== 'fish') continue
    pids.push(Number(pid))
  }
  return pids
}

describe(
  shouldRun
    ? 'real minimal-preset composition: the fish L2 terminal surface coexists with the minimal preset'
    : `real minimal-preset composition: NOT RUN — ${skipReason}`,
  () => {
    if (!shouldRun) {
      it.skip(`real minimal-preset composition lane skipped — ${skipReason}`, () => {})
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
      const presetFile = officialPresetFile as string

      const officialPreset = readFileSync(presetFile, 'utf8')
      // The declaration this lane composes has to BE the minimal one: a moved
      // or reshaped official file must fail here, not silently compose nothing.
      if (!/^\s*-?\s*id: preset-minimal$/m.test(officialPreset) || !/\bid: minimal$/m.test(officialPreset)) {
        throw new Error(`${presetFile} is not the official minimal preset declaration:\n${officialPreset}`)
      }

      qaRoot = assertIsolatedQaRoot(mkdtempSync(join(tmpdir(), 'banbo-dsh-minimal-lane-')), repoRoot)
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
      await installProfile(wrappers.dsh, { preset: PRESET_ID }, [fishTarball], repoRoot, environment)

      const profileDir = join(qa.dshHome, 'profiles', PROFILE_NAME)
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: readonly string[] } }
      }
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!bundles.includes(FISH_BUNDLE) || !bundles.includes(BASE_BUNDLE)) {
        throw new Error(`the profile install did not record both base layers: ${JSON.stringify(bundles)}`)
      }
      writeProfilePatch(profileDir, officialPreset)

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
            await booted.terminals.kill(booted.agent, session.sessionId, 'minimal lane teardown').catch(() => {})
          }
        } catch { /* the owner may already be disposed */ }
        try { await booted.disposeAgent() } catch { /* best effort */ }
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
      // The preset-layer persistent fish owns its own PTY (never in the L2
      // listing): with the tree disposed it must be gone, so anything still
      // parented to this process is reaped here rather than leaked.
      for (const pid of ownFishChildren()) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
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

    it('boots dsh-base + this bundle with the official minimal preset, and keeps all six terminal_* tools visible', async () => {
      const current = requireLane()
      // The composition really is the base-backed one, and the whole QA tree is
      // temporary: the real `~/.config/dsh` was never touched.
      expect(current.layers).toEqual(expect.arrayContaining([BASE_BUNDLE, FISH_BUNDLE]))
      expect(current.layers).not.toContain(TUI_BUNDLE)
      expect(current.profileDir.startsWith(`${current.dshHome}/`)).toBe(true)
      expect(current.dshHome.startsWith(tmpdir())).toBe(true)

      // The host-plane L2 group: `terminals` is entry-local to it (§2.9 realm
      // boundary), while the six tools register into the shared host registry.
      expect(current.ctx.get('terminals')).toBeUndefined()
      expect(current.hostGroup.options?.name).toBe('cordis:group')

      // The official declaration really mounted: the registry's audit rejects a
      // subtree with a failed row (or with a service leaked into the root
      // realm), so a definition with no `broken` is every minimal row up.
      const resolved = await current.presets.resolve(PRESET_ID)
      expect(resolved.id).toBe(PRESET_ID)
      expect(resolved.broken, 'the minimal preset must mount every row without a broken activation').toBeUndefined()
      expect(current.presets.defaultId).toBe(PRESET_ID)
      expect(current.presets.composedPreset(current.agent.ctx)).toBe(PRESET_ID)

      // Two `terminals` registries, two realms: the L2 group's is this bundle's
      // `terminal.js` (the official class) driven with fish argv, the minimal
      // preset's own persistent-shell machinery keeps the plain bash one.
      const presetTerminals = current.presets.serviceFor(current.agent, 'terminals') as TerminalsService | undefined
      expect(presetTerminals, "the minimal preset's isolate realm must publish its own terminals").toBeDefined()
      expect(presetTerminals).not.toBe(current.terminals)
      expect(presetTerminals?.listBackends().length).toBeGreaterThan(0)
      // The minimal preset's persistent-shell group keeps the OFFICIAL bash
      // backend (its `terminal-bash` row configures only a timeout), so its
      // resolved shell is bash — never this bundle's fish argv.
      expect(presetTerminals?.backends?.get('shell')?.config?.shellPath).toMatch(/bash$/)
      expect(presetTerminals?.backends?.get('shell')?.config?.shellPath).not.toBe('fish')

      const backends = current.terminals.listBackends()
      expect(backends.length).toBeGreaterThan(0)
      expect(backends).toContain('shell')
      expect(current.terminals.backends?.get('shell')?.type).toBe('shell')
      expect(current.terminals.backends?.get('shell')?.config?.shellPath).toBe('fish')

      // §9-8's double-registration worry, asserted for this composition: each of
      // the six names is visible to the preset-bound agent exactly ONCE.
      const agentTools = service<ToolsRuntime>(current.agent.ctx, 'tools')
      const agentSchemas = current.tools.schemas(current.agent).map((schema) => schema.name)
      const hostSchemas = current.tools.schemas().map((schema) => schema.name)
      for (const name of TERMINAL_TOOL_NAMES) {
        const hostScoped = current.tools.get(name, current.agent)
        expect(hostScoped, `tools.get('${name}', agent)`).toBeDefined()
        expect(typeof hostScoped?.execute, `${name}.execute`).toBe('function')
        expect(agentTools.get(name), `agent-scoped tools.get('${name}')`).toBeDefined()
        expect(agentSchemas.filter((entry) => entry === name), `agent schema ${name} appears once`).toHaveLength(1)
        expect(hostSchemas.filter((entry) => entry === name), `host schema ${name} appears once`).toHaveLength(1)
      }

      // The policy's minimal branch really ran: bash is hidden and the agent's
      // single shell tool is the PERSISTENT fish (parameters carry only
      // `command`), shadowing the host one-shot tool.
      expect(agentSchemas).toContain('fish')
      expect(agentSchemas).not.toContain('bash')
      const globalFish = current.tools.get('fish')
      const agentFish = current.tools.get('fish', current.agent)
      expect(agentFish).not.toBe(globalFish)
      // Both definitions are object-root JSON Schemas by the time the registry
      // has normalized them; the DISCRIMINATOR is the property map. The host
      // one-shot tool declares `description`/`workdir`/`timeoutMs`/
      // `run_in_background` beside `command`; the persistent form (the minimal
      // preset's contract, see `persistent.js`) declares `command` alone.
      const globalFishProperties = ((globalFish?.parameters ?? {}) as {
        readonly properties?: Record<string, unknown>
      }).properties ?? {}
      const agentFishProperties = ((agentFish?.parameters ?? {}) as {
        readonly properties?: Record<string, unknown>
      }).properties ?? {}
      expect(Object.keys(globalFishProperties)).toContain('description')
      expect(Object.keys(globalFishProperties)).toContain('run_in_background')
      expect(Object.keys(agentFishProperties)).toEqual(['command'])
      expect(agentFish?.description).toContain('persistent fish shell')
    }, 120_000)

    it('drives the preset-layer persistent fish and leaves the host L2 tools untouched', async () => {
      const current = requireLane()
      // The tools the agent sees are the HOST group's own definitions: the
      // preset-layer swap shadows `fish`, never the six `terminal_*` tools.
      for (const name of TERMINAL_TOOL_NAMES) {
        expect(current.tools.get(name, current.agent), `${name} must be the host definition`).toBe(
          current.tools.get(name),
        )
      }

      const first = await callTool<unknown>(current, 'fish', {
        command: 'set -gx FISH_MINIMAL_LANE_VAR hello-from-minimal',
      })
      expect(typeof first, 'the persistent fish output schema is a plain string').toBe('string')
      expect(String(first)).toContain('[Command finished with exit code 0]')

      const second = await callTool<unknown>(current, 'fish', { command: 'echo got-$FISH_MINIMAL_LANE_VAR' })
      expect(String(second)).toContain('got-hello-from-minimal')
    }, 120_000)

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
