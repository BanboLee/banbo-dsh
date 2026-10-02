/**
 * REAL L2 interactive-terminal lane (F6 of `.omo/plans/fish-shell-tty-v3.md`),
 * gated behind `DSH_REAL_FISH_PTY=1` exactly like the existing
 * `persistent-real.spec.ts` — no second gate variable exists, so a CI job that
 * already opens that lane covers this one too.
 *
 * The lane installs THIS bundle into a REAL isolated DSH profile through the
 * real `dsh plugin` CLI (`dsh.profile.bundles` = `@deepseek-ai/dsh-base` +
 * `@banbolee/dsh-fish-shell`), boots it, and drives a real agent created by the
 * real `agentLoop`. Everything it asserts is the S0-verified product shape:
 *
 *   1. the bundle's `fish-terminal-group` is the only mount for the terminals
 *      surface: `terminals` is isolated into the group realm while the six
 *      `terminal_*` tools land in the shared tools registry, so a real agent
 *      sees all six through `tools.get(name, agent)`, its own agent-scoped
 *      registry, and its schemas;
 *   2. the group's backend is this bundle's `terminal` module — the OFFICIAL
 *      `dsh-terminal-bash` backend configured with `shellPath: fish` plus the
 *      harness home contract in the child environment (`listBackends()` reports
 *      `shell`, not `fish`);
 *   3. `terminal_open` returns a live fish PTY whose motd carries `dsh>`;
 *   4. `terminal_send` settles with the command output in its viewport and a
 *      non-empty `waitReason`, and `terminal_read` reads the same scrollback;
 *   5. `terminal_signal SIGINT` really kills the foreground `sleep 300` while
 *      the shell itself keeps answering on the same session;
 *   6. `terminal_send { run_in_background: true }` yields a job whose output
 *      `job_output` returns and which `job_kill` (argument name `job_id`)
 *      terminates with the `killed` terminal status;
 *   7. `terminal_close` empties `terminal_list` and the PTY pid is gone;
 *   8. a second boot under the standing `workspace-write` policy (the mode
 *      `dsh-base` reads from `DSH_PERMISSION_MODE`) still spawns the PTY, still
 *      writes inside the session workspace, and denies a write outside it;
 *   9. §9-2: a standing-policy switch through the permission-preset service —
 *      the same write path the `/permission` command uses — is REFUSED while
 *      this owner holds a live session; the refusal commits no `sandbox/mode`
 *      event and the original session keeps answering. The fence is the one in
 *      `@deepseek-ai/dsh-terminal-bash`; the control that proves the refusal is
 *      that fence (and not a dead entry point) runs on the workspace-write lane
 *      below, where the same service switches the same way once its session is
 *      closed, and succeeds;
 *  10. §9-6: a SECOND real agent in the same profile cannot read, send to, or
 *      close the first agent's session (`FOREIGN_SESSION`), sees an empty
 *      terminal list, and the first agent is untouched;
 *  11. §9-3: a third boot under the standing `read-only` policy keeps all six
 *      `terminal_*` tools visible and records what the sandbox actually does
 *      there — whether the PTY spawns and what happens to a write inside the
 *      session workspace (the assertion text is the recorded semantics, not an
 *      assumption);
 *  12. the harness home contract: `$DSH_HOME` inside the session is THIS
 *      profile's isolated home, a nested `dsh --profile <this profile>
 *      --dump-config` composes THIS profile's tree (a positive COUNT of rows
 *      naming this bundle, not just a zero exit status), and the same command
 *      under a foreign home fails — the content count plus the control prove
 *      the nested launcher resolves the home the session was booted with.
 *
 * The fish version is asserted only as "present and `\d+\.\d+\.\d+`": CI
 * runners ship a different fish than a developer machine (4.0.0 vs 3.7.1) and
 * pinning the value would be a false red on one of them.
 *
 * Isolation and cleanup: everything lives under one OS temporary tree (temp
 * `DSH_HOME`, temp workspace, staged bundle copy) — the real `~/.config/dsh` is
 * never touched; `DSH_HOME`, `DSH_PERMISSION_MODE` and `PNPM_HOME` are restored
 * after the lane; every session is closed, every leftover PTY pid is killed,
 * and the temporary tree is removed. The staged copy is what receives the
 * `pnpm install --prod` of the packed shape: never the checkout (that would
 * prune the workspace devDependencies and rewrite its node_modules layout).
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedProfile, type IsolatedProfile } from '../../../tests/helpers/profile'
import {
  loadAppBoot,
  openProfileModuleResolution,
  repoRoot,
  resolveDshInstallationBin,
  type AppBootModule,
} from '../../../tests/composition/profile-loader'

const REAL_FISH_PTY = process.env.DSH_REAL_FISH_PTY === '1'
const PROFILE_NAME = 'fish-terminal-real'
const BUNDLE_NAME = '@banbolee/dsh-fish-shell'
const GROUP_ID = 'fish-terminal-group'
const MAIN_SESSION = 'real-main'
const CONFINED_SESSION = 'real-confined'
const READ_ONLY_SESSION = 'real-readonly'
/** A second real agent inside the SAME profile, for the owner-isolation lane. */
const FOREIGN_AGENT_SESSION = 'real-agent-b'
/** The three standing file-effect modes `dsh-base` reads from `DSH_PERMISSION_MODE`. */
type SandboxMode = 'danger-full-access' | 'workspace-write' | 'read-only'

/** The six names `@deepseek-ai/dsh-tool-terminal` registers (S0 gate1 log, line 18). */
const TERMINAL_TOOL_NAMES = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
] as const
/** Sandbox denial wording across bwrap (`Read-only file system`) and seatbelt. */
const OUTSIDE_WRITE_DENIAL = /read-only file system|permission denied|operation not permitted|denied/i

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const fishBinary = findOnPath('fish')
const dshBinary = findOnPath('dsh')

/**
 * The gate is the ONLY skip. Once `DSH_REAL_FISH_PTY=1` is open, a missing
 * `fish` or `dsh` binary FAILS in `beforeAll` with an install hint: this lane
 * is a real profile, and a silent skip would report green coverage that never
 * ran.
 */
const realDescribe = REAL_FISH_PTY ? describe : describe.skip

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

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
  read(owner: unknown, sessionId: string, request?: unknown): unknown
  kill(owner: unknown, sessionId: string, reason?: string): Promise<boolean>
  hasOwnerActivity(owner: unknown): boolean
}

interface LoaderEntry {
  readonly options?: { readonly id?: string; readonly name?: string }
  readonly ctx: { get(name: string): unknown }
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

/**
 * `ctx.permissionPresets` (`@deepseek-ai/dsh-permission-presets`): the preset
 * switch the `/permission` command handler and the settings UI drive. `set`
 * writes `permission/preset` and then the changed knobs through their canonical
 * setters — `setSandboxMode(session, mode)` → `session.append('sandbox/mode')`.
 */
interface PermissionPresetService {
  readonly names: readonly string[]
  set(session: unknown, name: string): void
}

/** `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), the effective-mode reader. */
interface SandboxPolicyLike {
  readonly defaultMode: string
  resolve(request?: { readonly session?: unknown }): { readonly mode: string }
  overrideOf(session: unknown): string | undefined
}

interface RealBootContext {
  readonly fiber: { dispose(): Promise<void> }
  get(name: string): unknown
}

interface RealLane {
  readonly name: string
  readonly ctx: RealBootContext
  readonly group: LoaderEntry
  readonly terminals: TerminalsService
  readonly tools: ToolsRuntime
  readonly agent: RealAgent
  /** `sandboxPolicy.defaultMode` captured at boot (the standing mode). */
  readonly standingMode: string
}

interface CommandResult {
  readonly status: number | null
  readonly output: string
  readonly error: string | undefined
}

interface DshRuntime {
  SessionId(id: string): unknown
  createStubAdapter(): unknown
}

interface BootInputs {
  readonly appBoot: AppBootModule
  readonly installAnchor: string
  readonly dshHome: string
  readonly mode: SandboxMode
  readonly sessionName: string
  readonly adapterPrefix: string
}

let isolated: IsolatedProfile | undefined
let workspaceRoot = ''
let bootInputs: BootInputs | undefined
let dshRuntime: DshRuntime | undefined
let mainLane: RealLane | undefined
let confinedLane: RealLane | undefined
let readOnlyLane: RealLane | undefined
/** The second real agent of the owner-isolation lane (§9-6). */
let foreignAgent: RealAgent | undefined
let mainSession: { readonly sessionId: string; readonly pid: number } | undefined
const openedSessions: Array<{ readonly lane: RealLane; readonly sessionId: string; readonly pid: number }> = []
const outsideWritePaths: string[] = []
let callCounter = 0
const savedEnvironment = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
  PNPM_HOME: process.env.PNPM_HOME,
}

function service<T>(ctx: { get(name: string): unknown }, name: string): T {
  const found = ctx.get(name)
  if (found === undefined || found === null) throw new Error(`real profile is missing the "${name}" service`)
  return found as T
}

function requireMainLane(): RealLane {
  if (mainLane === undefined) throw new Error('the default real lane did not boot (see beforeAll output)')
  return mainLane
}

function requireMainSession(): { readonly sessionId: string; readonly pid: number } {
  if (mainSession === undefined) throw new Error('the main terminal session was not opened by an earlier test')
  return mainSession
}

/**
 * Child environment for `dsh`/`pnpm`: the exact `NODE_ENV=development`
 * convention of this repository, plus the two overrides a real run needs.
 * `PNPM_HOME` is DROPPED because a `PNPM_HOME` that points at a missing or
 * unwritable package-manager directory makes every pnpm child fail with
 * "create the package-manager env directory … Permission denied" (the S0 probes
 * delete it for the same reason); pnpm then falls back to its own default store.
 */
function childEnvironment(dshHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', DSH_HOME: dshHome }
  delete environment.PNPM_HOME
  return environment
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 240_000,
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error?.message,
  }
}

function requireSuccess(
  label: string,
  command: string,
  args: readonly string[],
  result: CommandResult,
  hint?: string,
): void {
  if (result.status === 0) return
  throw new Error([
    `real L2 lane: ${label} failed (status ${String(result.status)}${result.error === undefined ? '' : `, ${result.error}`})`,
    `command: ${command} ${args.join(' ')}`,
    result.output.trim(),
    hint ?? '',
  ].filter((part) => part.length > 0).join('\n'))
}

async function loadDshRuntime(dshBin: string): Promise<DshRuntime> {
  const packageRoot = dirname(dirname(resolveDshInstallationBin(dshBin)))
  const llmModule = (await import(
    pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href
  )) as { LlmAdapter: new () => LlmAdapterLike }
  const sessionModule = (await import(
    pathToFileURL(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href
  )) as { SessionId(id: string): unknown }
  // The agent loop is never run in this lane (the six tools are executed
  // directly), so the adapter only has to satisfy registration.
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

/** Boot one lane's complete profile resolution (each boot reads the mode env). */
async function bootLane(input: BootInputs): Promise<RealLane> {
  const runtime = dshRuntime
  if (runtime === undefined) throw new Error('the dsh runtime modules were not loaded')
  const previousMode = process.env.DSH_PERMISSION_MODE
  process.env.DSH_PERMISSION_MODE = input.mode
  try {
    const profile = input.appBoot.loadProfile('dsh', PROFILE_NAME, input.installAnchor, input.dshHome)
    const layers = profile.layers.map((layer) => layer.packageName)
    if (!layers.includes(BUNDLE_NAME)) {
      throw new Error(`the isolated profile booted without the bundle layer: ${layers.join(', ')}`)
    }
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
    if (group === undefined) throw new Error(`the bundle patch did not mount the "${GROUP_ID}" row`)
    const terminals = service<TerminalsService>(group.ctx, 'terminals')
    const tools = service<ToolsRuntime>(ctx, 'tools')
    const standingMode = (ctx.get('sandboxPolicy') as { defaultMode?: string } | undefined)?.defaultMode
    if (standingMode === undefined) throw new Error('no sandboxPolicy.defaultMode in the real profile')

    const llm = service<{ registerAdapter(providers: readonly string[], adapter: unknown): unknown }>(ctx, 'llm')
    llm.registerAdapter([input.adapterPrefix], runtime.createStubAdapter())
    const agentLoop = service<AgentLoopService>(ctx, 'agentLoop')
    const agent = await agentLoop.create(
      runtime.SessionId(input.sessionName),
      { provider: input.adapterPrefix, model: input.adapterPrefix },
      { cwd: workspaceRoot },
    )
    return { name: input.sessionName, ctx, group, terminals, tools, agent, standingMode }
  } finally {
    if (previousMode === undefined) delete process.env.DSH_PERMISSION_MODE
    else process.env.DSH_PERMISSION_MODE = previousMode
  }
}

function requireDshRuntime(): DshRuntime {
  if (dshRuntime === undefined) throw new Error('the dsh runtime modules were not loaded (see beforeAll output)')
  return dshRuntime
}

/**
 * Create one additional REAL agent in an already-booted lane's profile, through
 * the same `agentLoop` service the lane's own agent came from. Used by the
 * owner-isolation lane: the second agent must be registered with `ctx.agents`
 * for `dsh-terminal`'s `isLiveOwner` check to be meaningful.
 */
async function createAgentInLane(lane: RealLane, sessionName: string, adapterPrefix: string): Promise<RealAgent> {
  const runtime = requireDshRuntime()
  const agentLoop = service<AgentLoopService>(lane.ctx, 'agentLoop')
  return agentLoop.create(
    runtime.SessionId(sessionName),
    { provider: adapterPrefix, model: adapterPrefix },
    { cwd: workspaceRoot },
  )
}

/** Execute one tool as `agent` and hand back the raw result, errors included. */
async function executeTool(
  lane: RealLane,
  agent: RealAgent,
  name: string,
  args: unknown,
  signalTimeoutMs = 120_000,
): Promise<ToolResult> {
  callCounter += 1
  return lane.tools.execute({
    callId: `${agent.id}-${callCounter}`,
    name,
    arguments: args,
    signal: AbortSignal.timeout(signalTimeoutMs),
    agent,
  })
}

/** The failure detail a `ToolResult` carries, whatever form it took. */
function errorText(result: ToolResult): string {
  return result.error?.message
    ?? result.content?.map((block) => block.text ?? '').join('')
    ?? 'no detail'
}

/** {@link callTool}, driven as one specific agent instead of the lane's own. */
async function callToolAs<T>(
  lane: RealLane,
  agent: RealAgent,
  name: string,
  args: unknown,
  signalTimeoutMs = 120_000,
): Promise<T> {
  const result = await executeTool(lane, agent, name, args, signalTimeoutMs)
  if (result.isError) {
    throw new Error(`${name} failed in the "${lane.name}" lane for agent "${agent.id}": ${errorText(result)}`)
  }
  return result.value as T
}

async function callTool<T>(
  lane: RealLane,
  name: string,
  args: unknown,
  signalTimeoutMs = 120_000,
): Promise<T> {
  const result = await executeTool(lane, lane.agent, name, args, signalTimeoutMs)
  if (result.isError) throw new Error(`${name} failed in the "${lane.name}" lane: ${errorText(result)}`)
  return result.value as T
}

function trackSession(lane: RealLane, sessionId: string, pid: number): void {
  openedSessions.push({ lane, sessionId, pid })
}

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

async function waitFor<T>(
  description: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)
    await delay(200)
  }
}

beforeAll(async () => {
  if (!REAL_FISH_PTY) return
  // Both binaries are required once the gate is open, so a missing one must not
  // degrade into a skip; the disjunction below also narrows both to `string`.
  if (fishBinary === undefined || dshBinary === undefined) {
    throw new Error([
      'DSH_REAL_FISH_PTY=1 is open, but this lane cannot run:',
      ...(fishBinary === undefined
        ? ['  - `fish` is not on PATH: install it (`apt-get install fish` on Linux, `brew install fish` on macOS) and re-run.']
        : []),
      ...(dshBinary === undefined
        ? ['  - the `dsh` CLI is not on PATH: `npm install -g @deepseek-ai/dsh@0.2.0-rc.1`.']
        : []),
      `PATH searched: ${process.env.PATH ?? ''}`,
      'This lane refuses to skip silently once its gate is open.',
    ].join('\n'))
  }

  isolated = createIsolatedProfile(PROFILE_NAME)
  const dshHome = isolated.dshHome
  const profileDir = isolated.profile
  workspaceRoot = join(dshHome, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  process.env.DSH_HOME = dshHome
  delete process.env.PNPM_HOME

  const { appBoot, installAnchor } = await loadAppBoot(dshBinary)
  appBoot.initProfile(profileDir, ['@deepseek-ai/dsh-base'])
  // The profile plane: an empty root config and an empty profile patch. The
  // terminal rows under test come from the BUNDLE's own patch, never from a
  // hand-written overlay here, and a missing `cordis.yml` fails the boot.
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

  // Stage a copy of the bundle and install ITS production tree with the hoisted
  // linker: that is the packed/deployed shape (bundled dependencies as real
  // files inside the package directory, never symlinks into this checkout), and
  // the profile install below then resolves `@deepseek-ai/dsh-tool-terminal`
  // from inside the linked package exactly as it does for a published tarball.
  const staged = join(dshHome, 'staged-fish-shell')
  cpSync(join(repoRoot, 'plugins', 'fish-shell'), staged, {
    recursive: true,
    filter: (entry) => basename(entry) !== 'node_modules' && basename(entry) !== 'tests',
  })
  const environment = childEnvironment(dshHome)
  const installArgs = ['install', '--prod', '--config.node-linker=hoisted', '--config.auto-install-peers=false']
  requireSuccess(
    'staging pnpm install',
    'pnpm',
    installArgs,
    runCommand('pnpm', installArgs, { cwd: staged, env: environment }),
    'A pnpm store without @deepseek-ai/dsh-tool-terminal is the usual cause; run a plain `pnpm install` in this workspace first.',
  )

  const addArgs = [
    'plugin', '--profile', PROFILE_NAME, 'add', '-w', staged,
    '--offline', '--config.auto-install-peers=false',
  ]
  requireSuccess(
    'dsh plugin add of the staged bundle',
    dshBinary,
    addArgs,
    runCommand(dshBinary, addArgs, { cwd: profileDir, env: environment }),
  )
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: readonly string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(BUNDLE_NAME)) {
    throw new Error(`the profile install did not record the bundle layer: ${JSON.stringify(bundles)}`)
  }

  dshRuntime = await loadDshRuntime(dshBinary)
  bootInputs = { appBoot, installAnchor, dshHome, mode: 'danger-full-access', sessionName: MAIN_SESSION, adapterPrefix: 'real-main-mock' }
  mainLane = await bootLane(bootInputs)
}, 600_000)

afterAll(async () => {
  for (const lane of [mainLane, confinedLane, readOnlyLane]) {
    if (lane === undefined) continue
    try {
      for (const session of lane.terminals.list(lane.agent)) {
        await lane.terminals.kill(lane.agent, session.sessionId, 'real lane teardown').catch(() => {})
      }
    } catch { /* the owner may already be disposed */ }
    try { await lane.ctx.fiber.dispose() } catch { /* best effort */ }
  }
  // Last resort for a PTY that outlived its session: the pid was tracked when
  // the session opened, so it can never become somebody else's process.
  for (const entry of openedSessions) {
    const state = processState(entry.pid)
    if (state === undefined || state.startsWith('Z')) continue
    try { process.kill(entry.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  for (const path of outsideWritePaths) {
    try { rmSync(path, { force: true }) } catch { /* outside the workspace: best effort */ }
  }
  mainLane = undefined
  confinedLane = undefined
  readOnlyLane = undefined
  foreignAgent = undefined
  bootInputs = undefined
  dshRuntime = undefined
  mainSession = undefined
  openedSessions.length = 0
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const profile = isolated
  isolated = undefined
  await profile?.cleanup()
}, 120_000)

realDescribe('real L2 terminal sessions in an isolated DSH profile', () => {
  it('mounts the bundle group and exposes all six terminal_* tools to a real agent', async () => {
    const lane = requireMainLane()
    expect(lane.standingMode).toBe('danger-full-access')

    // §2.9 realm boundary: `terminals` is entry-local to the group, while the
    // six tools register into the shared host tools registry.
    expect(lane.ctx.get('terminals')).toBeUndefined()
    expect(lane.group.options?.name).toBe('cordis:group')

    const backends = lane.terminals.listBackends()
    expect(backends.length).toBeGreaterThan(0)
    expect(backends).toContain('shell')
    const shellBackend = lane.terminals.backends?.get('shell')
    expect(shellBackend?.type).toBe('shell')
    expect(shellBackend?.config?.shellPath).toBe('fish')

    const agentTools = service<ToolsRuntime>(lane.agent.ctx, 'tools')
    for (const name of TERMINAL_TOOL_NAMES) {
      const hostScoped = lane.tools.get(name, lane.agent)
      expect(hostScoped, `tools.get('${name}', agent)`).toBeDefined()
      expect(typeof hostScoped?.execute, `${name}.execute`).toBe('function')
      expect(agentTools.get(name), `agent-scoped tools.get('${name}')`).toBeDefined()
    }

    const agentSchemas = lane.tools.schemas(lane.agent).map((schema) => schema.name)
    for (const name of TERMINAL_TOOL_NAMES) expect(agentSchemas, `agent schema ${name}`).toContain(name)
    const hostSchemas = lane.tools.schemas().map((schema) => schema.name)
    for (const name of TERMINAL_TOOL_NAMES) expect(hostSchemas, `host schema ${name}`).toContain(name)

    // The bundle's host plane still replaced bash with fish, and `bash` stays
    // hidden from this agent.
    expect(agentSchemas).toContain('fish')
    expect(agentSchemas).not.toContain('bash')
  }, 60_000)

  it('opens a real fish PTY whose motd carries the dsh prompt', async () => {
    const lane = requireMainLane()
    const opened = await callTool<{
      sessionId: string
      name?: string
      type: string
      pid?: number
      status: { kind: string }
      motd: string
    }>(lane, 'terminal_open', { type: 'shell', name: MAIN_SESSION, cwd: workspaceRoot })

    expect(opened.type).toBe('shell')
    expect(opened.motd).toContain('dsh>')
    expect(opened.status.kind).toBe('running')
    if (opened.pid === undefined) throw new Error('terminal_open reported no PTY pid')
    mainSession = { sessionId: opened.sessionId, pid: opened.pid }
    trackSession(lane, opened.sessionId, opened.pid)
  }, 90_000)

  it('sends input, settles with a wait reason, and reads the output back', async () => {
    const lane = requireMainLane()
    const session = requireMainSession()
    const sentinel = 'REAL_LANE_SENTINEL'

    const sent = await callTool<{
      kind: string
      viewport: string
      waitReason: string
      sessionStatus: { kind: string }
    }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: `echo ${sentinel}; echo SHELL_VERSION=$FISH_VERSION`,
    })
    expect(sent.kind).toBe('foreground')
    expect(sent.viewport).toContain(sentinel)
    expect(sent.waitReason.length).toBeGreaterThan(0)
    expect(sent.sessionStatus.kind).toBe('running')
    // Version shape only: CI fish differs from the developer machine's fish.
    expect(sent.viewport).toMatch(/SHELL_VERSION=\d+\.\d+\.\d+/)

    const read = await callTool<{ text: string; totalLines: number; lineEnd: number }>(
      lane,
      'terminal_read',
      { sessionId: session.sessionId },
    )
    expect(read.text).toContain(sentinel)
    expect(read.text).toMatch(/SHELL_VERSION=\d+\.\d+\.\d+/)
    expect(read.totalLines).toBeGreaterThan(0)

    const listed = await callTool<readonly SessionSnapshot[]>(lane, 'terminal_list', {})
    expect(listed.map((entry) => entry.sessionId)).toContain(session.sessionId)
  }, 120_000)

  it('boots the session with the harness home contract, so a nested dsh resolves the same home', async () => {
    const lane = requireMainLane()
    const session = requireMainSession()
    const dshHome = isolated?.dshHome
    if (dshHome === undefined) throw new Error('the isolated profile home is not available')

    // One send, four facts: the home the session carries, the nested launcher's
    // status on it, HOW MANY of its composed rows name this bundle (the
    // isolated profile lives under this temp home, so no other home can produce
    // its rows), and the control that the same command fails under a foreign
    // home. The row COUNT is the part with independent teeth: a status-only
    // command can satisfy an exit-status assertion, but only a real
    // `--dump-config` of THIS profile yields `dsh-fish-shell` rows. The equality
    // assertion below covers both failure shapes the bug had: an unset
    // `DSH_HOME` (empty) and the default `~/.dsh` fallback.
    //
    // `--dump-config` is the cheap nested command: it composes the profile tree
    // and exits without booting a session or a TUI.
    const sent = await callTool<{ viewport: string; waitReason: string }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: [
        'echo HOME_CONTRACT=$DSH_HOME',
        `dsh --profile ${PROFILE_NAME} --dump-config >/dev/null 2>&1; echo NESTED_STATUS=$status`,
        `set -l dump (dsh --profile ${PROFILE_NAME} --dump-config 2>&1 | string match '*dsh-fish-shell*'); echo NESTED_ROWS=(count $dump)`,
        `env DSH_HOME=/nonexistent-dsh-home dsh --profile ${PROFILE_NAME} --dump-config >/dev/null 2>&1; echo FOREIGN_HOME_STATUS=$status`,
      ].join('; '),
    })
    expect(sent.waitReason.length).toBeGreaterThan(0)

    expect(sent.viewport).toContain(`HOME_CONTRACT=${dshHome}`)
    expect(sent.viewport).toContain('NESTED_STATUS=0')
    // Positive and content-bearing: the dump really carries THIS profile's rows.
    expect(sent.viewport).toMatch(/NESTED_ROWS=[1-9]\d*/)
    // The control: without the inherited home the profile does not exist, so a
    // zero here would mean the positive assertions above passed for free.
    expect(sent.viewport).not.toContain('FOREIGN_HOME_STATUS=0')
  }, 120_000)

  it('delivers SIGINT to the foreground process group of a live session', async () => {
    const lane = requireMainLane()
    const session = requireMainSession()

    const started = await callTool<{ waitReason: string }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: 'sleep 300',
    })
    expect(started.waitReason.length).toBeGreaterThan(0)

    const signalled = await callTool<{ delivered: boolean; targetPgid: number }>(lane, 'terminal_signal', {
      sessionId: session.sessionId,
      signal: 'SIGINT',
    })
    expect(signalled.delivered).toBe(true)
    expect(Number.isInteger(signalled.targetPgid)).toBe(true)
    // State change: the interrupted foreground process group is gone …
    expect(await waitForProcessGone(signalled.targetPgid, 15_000)).toBe(true)
    // … and the shell itself survived, still answering on the SAME session.
    const recovered = await callTool<{ viewport: string }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: 'echo SIGINT_RECOVERED',
    })
    expect(recovered.viewport).toContain('SIGINT_RECOVERED')
  }, 120_000)

  it('runs a background send as a job, reads it with job_output, and cancels it with job_kill', async () => {
    const lane = requireMainLane()
    const session = requireMainSession()

    const started = await callTool<{ kind: string; jobId: string }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: 'while true; echo BG_TICK; sleep 1; end',
      run_in_background: true,
    })
    expect(started.kind).toBe('background')
    expect(started.jobId.length).toBeGreaterThan(0)

    // A running job (the loop never returns to a prompt): `job_output` reads its
    // consumed delta while the job is still live.
    const read = await waitFor('the background pty-send job to produce output', 30_000, async () => {
      const output = await callTool<{ text: string; job: { id: string; kind: string; status: string } }>(
        lane,
        'job_output',
        { job_id: started.jobId },
      )
      return output.text.includes('BG_TICK') ? output : undefined
    })
    expect(read.job.id).toBe(started.jobId)
    expect(read.job.kind).toBe('pty-send')
    expect(read.job.status).toBe('running')

    // `job_id` — not `jobId` — is the parameter name of the job controls.
    const killed = await callTool<{ outcome: string; job: { id: string; status: string } }>(lane, 'job_kill', {
      job_id: started.jobId,
    })
    expect(killed.job.id).toBe(started.jobId)
    expect(killed.outcome).toBe('cancellation-requested')

    const settled = await waitFor('the killed job to reach a terminal status', 30_000, async () => {
      const jobs = await callTool<ReadonlyArray<{ id: string; status: string }>>(lane, 'job_list', {})
      const job = jobs.find((entry) => entry.id === started.jobId)
      if (job === undefined) return undefined
      return job.status === 'running' || job.status === 'stopping' ? undefined : job
    })
    expect(settled.status).toBe('killed')
  }, 180_000)

  it('refuses a standing-policy switch while a live session is open (§9-2)', async () => {
    const lane = requireMainLane()
    const session = requireMainSession()
    const presets = service<PermissionPresetService>(lane.ctx, 'permissionPresets')
    const policy = service<SandboxPolicyLike>(lane.ctx, 'sandboxPolicy')

    expect(lane.standingMode).toBe('danger-full-access')
    expect(presets.names).toContain('read-only')
    const currentMode = policy.overrideOf(lane.agent.session) ?? policy.defaultMode
    expect(currentMode).toBe('danger-full-access')
    expect(policy.resolve({ session: lane.agent.session }).mode).toBe(currentMode)

    // The entry point under test is the real preset switch: `/permission
    // read-only` → `permissionPresets.apply` → `setSandboxMode(session, mode)`
    // → `session.append('sandbox/mode')`. `@deepseek-ai/dsh-terminal-bash`
    // registers an `internal/dispatch` listener for exactly that commit and
    // throws while THIS owner has an open session or a spawn in progress, so
    // the call must be refused synchronously — not silently dropped.
    let rejection: unknown
    try {
      presets.set(lane.agent.session, 'read-only')
    } catch (error) {
      rejection = error
    }
    expect(rejection, 'the policy switch must be refused, not accepted').toBeInstanceOf(Error)
    expect((rejection as Error).message).toMatch(
      new RegExp(`cannot change sandbox mode from "${currentMode}" to "read-only" while persistent terminal sessions are open`),
    )

    // The refusal is not cosmetic: the fence throws BEFORE the event commits,
    // so the effective mode is still the standing one. (NOT asserted here: the
    // `permission/preset` identity event is appended BEFORE the knob writes, so
    // the rejected switch does leave that one event behind — the fence guards
    // the mode, not the whole preset transaction.)
    expect(policy.resolve({ session: lane.agent.session }).mode).toBe(currentMode)
    expect(policy.overrideOf(lane.agent.session)).toBe(currentMode)

    // …and the live session itself was not disturbed by the rejected switch.
    const survived = await callTool<{ viewport: string; sessionStatus: { kind: string } }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: 'echo FENCE_SURVIVED',
    })
    expect(survived.viewport).toContain('FENCE_SURVIVED')
    expect(survived.sessionStatus.kind).toBe('running')
  }, 120_000)

  it("keeps a second agent out of the first agent's session (§9-6)", async () => {
    const lane = requireMainLane()
    const session = requireMainSession()
    const inputs = bootInputs
    if (inputs === undefined) throw new Error('the lane did not finish its setup')
    foreignAgent ??= await createAgentInLane(lane, FOREIGN_AGENT_SESSION, inputs.adapterPrefix)
    const intruder = foreignAgent
    expect(intruder.id).not.toBe(lane.agent.id)

    // The registry is owner-scoped: B sees an empty list while A's session is
    // published, and every operation on A's id is refused at the exact-owner
    // check (`expectOwned` in `@deepseek-ai/dsh-terminal`: `PTY session <id>
    // belongs to another agent`, `TerminalError` code `FOREIGN_SESSION`; the
    // tool surface reports the message because a TerminalError is not a
    // `HarnessError`, so `dsh-tools` carries no `error.info.code`).
    const listed = await callToolAs<readonly SessionSnapshot[]>(lane, intruder, 'terminal_list', {})
    expect(listed).toEqual([])

    const read = await executeTool(lane, intruder, 'terminal_read', { sessionId: session.sessionId })
    expect(read.isError).toBe(true)
    expect(errorText(read)).toMatch(/belongs to another agent/)

    // The stable code behind that message is `FOREIGN_SESSION`; the registry
    // throws it (not a `HarnessError`), so assert it where it is carried.
    let foreignError: unknown
    try {
      lane.terminals.read(intruder, session.sessionId)
    } catch (error) {
      foreignError = error
    }
    expect((foreignError as { code?: string } | undefined)?.code).toBe('FOREIGN_SESSION')

    const sent = await executeTool(lane, intruder, 'terminal_send', {
      sessionId: session.sessionId,
      text: 'echo INTRUDER_WROTE_HERE',
    })
    expect(sent.isError).toBe(true)
    expect(errorText(sent)).toMatch(/belongs to another agent/)

    const closed = await executeTool(lane, intruder, 'terminal_close', { sessionId: session.sessionId })
    expect(closed.isError).toBe(true)
    expect(errorText(closed)).toMatch(/belongs to another agent/)

    // A's session survived all three attempts: same id, still listed for A,
    // still running, still owned by A.
    expect(lane.terminals.list(intruder)).toEqual([])
    expect(lane.terminals.list(lane.agent).map((entry) => entry.sessionId)).toContain(session.sessionId)
    expect(lane.terminals.hasOwnerActivity(lane.agent)).toBe(true)
    const mine = await callTool<{ viewport: string; sessionStatus: { kind: string } }>(lane, 'terminal_send', {
      sessionId: session.sessionId,
      text: 'echo OWNER_STILL_HERE',
    })
    expect(mine.viewport).toContain('OWNER_STILL_HERE')
    expect(mine.sessionStatus.kind).toBe('running')
  }, 120_000)

  it('closes the session, then lists nothing and leaves no process behind', async () => {
    const lane = requireMainLane()
    const session = requireMainSession()

    const closed = await callTool<{ sessionId: string; outcome: string }>(lane, 'terminal_close', {
      sessionId: session.sessionId,
    })
    expect(closed.outcome).toBe('closed')

    const listed = await callTool<readonly SessionSnapshot[]>(lane, 'terminal_list', {})
    expect(listed).toEqual([])
    expect(lane.terminals.hasOwnerActivity(lane.agent)).toBe(false)
    expect(await waitForProcessGone(session.pid, 15_000)).toBe(true)

    const index = openedSessions.findIndex((entry) => entry.sessionId === session.sessionId)
    if (index >= 0) openedSessions.splice(index, 1)
    mainSession = undefined
  }, 120_000)

  it('spawns the PTY under the standing workspace-write policy and denies writes outside the workspace', async () => {
    const inputs = bootInputs
    if (inputs === undefined) throw new Error('the lane did not finish its setup')
    confinedLane ??= await bootLane({
      ...inputs,
      mode: 'workspace-write',
      sessionName: CONFINED_SESSION,
      adapterPrefix: 'real-confined-mock',
    })
    const lane = confinedLane
    expect(lane.standingMode).toBe('workspace-write')

    const opened = await callTool<{ sessionId: string; pid?: number; motd: string }>(lane, 'terminal_open', {
      type: 'shell',
      name: CONFINED_SESSION,
      cwd: workspaceRoot,
    })
    expect(opened.motd).toContain('dsh>')
    if (opened.pid === undefined) throw new Error('the confined terminal_open reported no PTY pid')
    trackSession(lane, opened.sessionId, opened.pid)

    // The enforcement seam really wrapped the PTY with the fish backend, so the
    // denial below is the sandbox's and not merely POSIX file permissions. The
    // Linux chain falls through to landlock when bwrap is unusable, so the bwrap
    // wording is asserted only for the bwrap runner (S0's evidence) — the two
    // write assertions are what prove confinement on every runner.
    const argsProbe = spawnSync('ps', ['-p', String(opened.pid), '-o', 'args='], { encoding: 'utf8' })
    const commandLine = (argsProbe.stdout ?? '').trim()
    expect(commandLine).toContain('fish')
    const sandboxRunner = (lane.ctx.get('sandbox') as {
      selectedRunner?: { runner?: string }
    } | undefined)?.selectedRunner
    if (sandboxRunner?.runner === 'bwrap') expect(commandLine.startsWith('bwrap')).toBe(true)

    const inside = await callTool<{ viewport: string }>(lane, 'terminal_send', {
      sessionId: opened.sessionId,
      text: 'echo CONFINE_INSIDE_OK > ./confined-inside.txt; echo INSIDE_EXIT=$status',
    })
    expect(inside.viewport).toContain('INSIDE_EXIT=0')
    expect(existsSync(join(workspaceRoot, 'confined-inside.txt'))).toBe(true)

    // `/etc` is a read-only bind (NOT `/tmp`: the confined profile gives the
    // session a private tmpfs there, so a successful write would never reach the
    // host and would prove nothing).
    const outsidePath = `/etc/dsh-fish-terminal-real-${opened.pid}.txt`
    outsideWritePaths.push(outsidePath)
    const outside = await callTool<{ viewport: string }>(lane, 'terminal_send', {
      sessionId: opened.sessionId,
      text: `echo out > ${outsidePath}; echo ETC_EXIT=$status`,
    })
    expect(outside.viewport).toMatch(OUTSIDE_WRITE_DENIAL)
    expect(outside.viewport).toMatch(/ETC_EXIT=[1-9]/)
    expect(existsSync(outsidePath)).toBe(false)

    const closed = await callTool<{ outcome: string }>(lane, 'terminal_close', { sessionId: opened.sessionId })
    expect(closed.outcome).toBe('closed')
    expect(await waitForProcessGone(opened.pid, 15_000)).toBe(true)
    const index = openedSessions.findIndex((entry) => entry.sessionId === opened.sessionId)
    if (index >= 0) openedSessions.splice(index, 1)

    // Fence control (§9-2): the SAME preset switch on the SAME lane succeeds
    // once no session holds it, so the refusal the main lane records is the
    // terminal fence and not a broken entry point or a no-op switch.
    const presets = service<PermissionPresetService>(lane.ctx, 'permissionPresets')
    const policy = service<SandboxPolicyLike>(lane.ctx, 'sandboxPolicy')
    expect(policy.resolve({ session: lane.agent.session }).mode).toBe('workspace-write')
    expect(() => presets.set(lane.agent.session, 'read-only')).not.toThrow()
    expect(policy.resolve({ session: lane.agent.session }).mode).toBe('read-only')
  }, 300_000)

  it('records the read-only standing-policy behavior of the same backend (§9-3)', async () => {
    const inputs = bootInputs
    if (inputs === undefined) throw new Error('the lane did not finish its setup')
    readOnlyLane ??= await bootLane({
      ...inputs,
      mode: 'read-only',
      sessionName: READ_ONLY_SESSION,
      adapterPrefix: 'real-readonly-mock',
    })
    const lane = readOnlyLane
    expect(lane.standingMode).toBe('read-only')
    expect(service<SandboxPolicyLike>(lane.ctx, 'sandboxPolicy').defaultMode).toBe('read-only')

    // The tool surface does not shrink with the standing mode.
    const agentSchemas = lane.tools.schemas(lane.agent).map((schema) => schema.name)
    for (const name of TERMINAL_TOOL_NAMES) expect(agentSchemas, `read-only agent schema ${name}`).toContain(name)

    // Recorded semantics (1): `read-only` is a FILE-EFFECT mode, not a
    // capability gate — the PTY spawns and the shell answers exactly like it
    // does under the other two modes.
    const opened = await callTool<{
      sessionId: string
      pid?: number
      motd: string
      status: { kind: string }
    }>(lane, 'terminal_open', { type: 'shell', name: READ_ONLY_SESSION, cwd: workspaceRoot })
    expect(opened.motd).toContain('dsh>')
    expect(opened.status.kind).toBe('running')
    if (opened.pid === undefined) throw new Error('the read-only terminal_open reported no PTY pid')
    trackSession(lane, opened.sessionId, opened.pid)

    // Recorded semantics (2): every write is denied, including one INSIDE the
    // session workspace — under `read-only` the resolved policy has no writable
    // root at all, so the workspace is not a write boundary here.
    const insidePath = join(workspaceRoot, 'readonly-inside.txt')
    const inside = await callTool<{ viewport: string }>(lane, 'terminal_send', {
      sessionId: opened.sessionId,
      text: 'echo inside > ./readonly-inside.txt; echo READONLY_INSIDE_EXIT=$status',
    })
    expect(inside.viewport).toMatch(OUTSIDE_WRITE_DENIAL)
    expect(inside.viewport).toMatch(/READONLY_INSIDE_EXIT=[1-9]/)
    expect(existsSync(insidePath)).toBe(false)

    // Recorded semantics (3): outside the workspace is denied the same way
    // (same runner, same denial dialect as the workspace-write lane above).
    const outsidePath = `/etc/dsh-fish-terminal-readonly-${opened.pid}.txt`
    outsideWritePaths.push(outsidePath)
    const outside = await callTool<{ viewport: string }>(lane, 'terminal_send', {
      sessionId: opened.sessionId,
      text: `echo out > ${outsidePath}; echo READONLY_ETC_EXIT=$status`,
    })
    expect(outside.viewport).toMatch(OUTSIDE_WRITE_DENIAL)
    expect(outside.viewport).toMatch(/READONLY_ETC_EXIT=[1-9]/)
    expect(existsSync(outsidePath)).toBe(false)

    const closed = await callTool<{ outcome: string }>(lane, 'terminal_close', { sessionId: opened.sessionId })
    expect(closed.outcome).toBe('closed')
    expect(await waitForProcessGone(opened.pid, 15_000)).toBe(true)
    const index = openedSessions.findIndex((entry) => entry.sessionId === opened.sessionId)
    if (index >= 0) openedSessions.splice(index, 1)
  }, 300_000)
})
