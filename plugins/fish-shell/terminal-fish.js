/**
 * Library: the persistent `fish` PTY backend for DeepSeek Harness — a
 * `BashTerminalBackend` subclass that spawns `fish --no-config -i`
 * (config-overridable) instead of bash, with a fish prompt that speaks the
 * shared `LocalPtySession` readiness contract (OSC `133;D;<status>` + a
 * `dsh> ` prompt tail), and the same sandbox confinement and mode fence as
 * the official bash backend.
 *
 * The readiness contract was verified against real fish 4.0.0: with
 * `TERM=dumb` (the backend's child environment, same as official bash),
 * fish's reader emits no cursor/redraw sequences after the prompt text, so
 * the sanitizer sees exactly `dsh> ` after the OSC marker and readiness
 * settles promptly. The prompt setup is submitted as ONE line (semicolon
 * function bodies) and builds the ESC/BEL bytes at runtime through fish
 * `printf` escapes (`\x1b`, `\x07`), mirroring the official pwsh prompt's
 * runtime-escape approach — raw ESC bytes in submitted PTY input are
 * unreliable under a line editor.
 *
 * This module is NOT mounted by the bundle patch (there is no `fish-terminal`
 * host row): the `terminals` service is entry-local to the `minimal` preset
 * and invisible at the host/agent plane, so a patch row would stay pending
 * forever in host-plane profiles. Instead the policy's persistent tool
 * (`persistent.js`) constructs one `FishTerminalBackend` itself and drives
 * its sessions directly. `apply` below is kept for direct assembly and
 * tests (a context that already mounts the `terminals` registry).
 *
 * `@deepseek-ai/dsh-terminal-bash` does not export its private
 * `ensureSandboxModeFence`/`spawnArgv`/`startupSession` helpers, so the
 * minimal pieces this backend needs are copied here (marked with their
 * official source) rather than monkey-patching the official module.
 *
 * @module @banbolee/dsh-fish-shell/terminal-fish
 */

import { BashTerminalBackend } from '@deepseek-ai/dsh-terminal-bash'
import { TerminalBackendCleanupError } from '@deepseek-ai/dsh-terminal'

/** Cordis plugin name (used only for direct assembly/tests; the bundle patch
 * does NOT mount this plugin row — see the module doc). */
export const name = 'fish-terminal'
/** Required services: terminal registry, shared confinement policy, projection registry, and process substrate. */
export const inject = [
  'terminals',
  'sandboxPolicy',
  'sessionProjections',
  'subprocess',
]

/** Exact printable prompt emitted after the private marker (shared with the
 * official bash/pwsh backends' readiness contract). */
const CONTROLLED_PROMPT = 'dsh> '
/** Default fish executable (resolved on PATH by the subprocess provider). */
const DEFAULT_FISH_SHELL = 'fish'
/** Default fish arguments: interactive, without user config interference.
 * `--no-config` exists since fish 3.3 (the README is POSIX-only anyway) and
 * avoids a user `fish_prompt`/alias shadowing the controlled prompt. */
const DEFAULT_FISH_ARGS = ['--no-config', '-i']

/**
 * Defaults for the shared PTY/readiness surface, mirroring the official
 * `@deepseek-ai/dsh-terminal-bash` Config schema (the official module
 * materializes them through schemastery defaults; this backend has no
 * schemastery dependency, so defaulting is explicit here).
 */
const DEFAULT_PTY_CONFIG = {
  rows: 40,
  cols: 160,
  scrollbackLines: 1e4,
  scrollbackMaxBytes: 4 * 1024 * 1024,
  maxReadBytes: 256 * 1024,
  pollIntervalMs: 50,
  exactProbeAfterMs: 150,
  idleSilenceMs: 3e3,
  handoffGraceMs: 500,
  timeoutMs: 3e4,
  disposeGraceMs: 3e3,
}

/**
 * One-line fish prompt setup submitted before readiness: suppresses the
 * greeting and right prompt, and defines a prompt that emits the shared OSC
 * `133;D;<status>` + BEL marker followed by exactly `dsh> `. ESC/BEL are
 * built at runtime via fish `printf` escapes (no raw control bytes in
 * submitted input; verified against fish 4.0.0).
 */
export const FISH_PROMPT_SETUP = 'function fish_greeting; end; function fish_prompt; printf \'\\x1b]133;D;%s\\x07\' $status; echo -n \'dsh> \'; end; function fish_right_prompt; end;'

/**
 * Resolve the effective fish shell specification: an unset or empty
 * `shellPath`/`shellArgs` selects the defaults, a non-empty explicit value
 * wins. Mirrors the official `resolveConfig` (minus dialect selection).
 * @param config - the plugin configuration.
 * @returns the fully resolved configuration.
 */
export function resolveConfig(config) {
  return {
    backendType: config.backendType?.length > 0 ? config.backendType : 'fish',
    shellPath: config.shellPath !== undefined && config.shellPath.length > 0 ? config.shellPath : DEFAULT_FISH_SHELL,
    shellArgs: config.shellArgs !== undefined && config.shellArgs.length > 0 ? config.shellArgs : DEFAULT_FISH_ARGS,
    ...DEFAULT_PTY_CONFIG,
    ...Object.fromEntries(Object.entries(config).filter(([key]) => key in DEFAULT_PTY_CONFIG && config[key] !== undefined)),
  }
}

/**
 * Validate the effective configuration (mirrors the official
 * `validateConfig`).
 * @param config - the fully resolved configuration.
 * @returns the narrowed configuration.
 */
export function validateConfig(config) {
  const resolved = config
  if (resolved.backendType.length === 0) throw new Error('terminal-fish: backendType must be non-empty')
  if (resolved.shellPath.length === 0) throw new Error('terminal-fish: shellPath must be non-empty')
  for (const [field, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`terminal-fish: ${field} must be a positive safe integer`)
    }
  }
  if (resolved.maxReadBytes > resolved.scrollbackMaxBytes) throw new Error('terminal-fish: maxReadBytes must not exceed scrollbackMaxBytes')
  if (resolved.handoffGraceMs < resolved.pollIntervalMs) throw new Error('terminal-fish: handoffGraceMs must be at least pollIntervalMs so one readiness poll runs inside the grace window')
}

/**
 * Fish child environment: the official bash `childEnvironment` common set
 * (TERM=dumb so the reader emits no cursor/redraw sequences, PAGER=cat,
 * harness identity facts) minus the bash-only PS1/PROMPT_COMMAND.
 * @param spec - the spawn specification.
 * @returns the child environment.
 */
export function childEnvironment(spec) {
  return {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    DSH_SHELL: '1',
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: spec.sessionId,
  }
}

// Copied from the official `@deepseek-ai/dsh-terminal-bash` (not exported
// there): a per-owner fence refusing `sandbox/mode` changes while persistent
// terminal sessions are open or being created.
//
// Self-managed adaptation: the official copy asks the terminals registry
// (`state.pty.hasOwnerActivity(owner)`) whether the owner has activity, but
// the policy's persistent tool drives sessions WITHOUT a registry. Activity
// checkers are therefore injectable and AGGREGATED per owner: every
// `registerPersistentFish` manager that spawned for an owner contributes its
// own checker (the manager's owner→session tracking), and the fence refuses
// the mode change while ANY checker reports activity. Aggregation matters
// because managers can churn (persistent→one-shot→persistent): a single-slot
// overwrite would silently forget the first manager's still-open sessions.
// A call without a checker (the backend's own fence probe on every spawn)
// adds nothing, so it cannot clobber policy checkers; when no checker was
// ever contributed the fence falls back to the terminals registry probe
// (`ctx.terminals` may be absent — missing services resolve to `undefined`
// on a Cordis context, never a throw).
const sandboxModeFences = new WeakMap()
export function ensureSandboxModeFence(ctx, owner, hasActivity) {
  let state = sandboxModeFences.get(owner)
  if (state === undefined) {
    state = { ctx, checkers: new Set() }
    sandboxModeFences.set(owner, state)
    owner.ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args
      if (session !== owner.session || event.type !== 'sandbox/mode') return
      const current = sandboxModeFences.get(owner)
      if (current === undefined) return
      const currentMode = current.ctx.get('sessionProjections')?.stateOf(session, 'sandboxMode') ?? current.ctx.get('sandboxPolicy')?.defaultMode
      if (event.data.mode === currentMode) return
      const active = current.checkers.size > 0
        ? [...current.checkers].some((check) => check())
        : current.ctx.get('terminals')?.hasOwnerActivity(owner) ?? false
      if (active) throw new Error(`cannot change sandbox mode from "${currentMode}" to "${event.data.mode}" while persistent terminal sessions are open or being created; wait for creation to settle and close them first`)
    }, { global: true })
  } else {
    state.ctx = ctx
  }
  if (hasActivity !== undefined) state.checkers.add(hasActivity)
}

/**
 * Confine the fish argv through the shared sandbox policy, exactly like the
 * official `spawnArgv` (which is private to `@deepseek-ai/dsh-terminal-bash`
 * and therefore copied here).
 * @param ctx - the plugin context carrying the sandbox provider.
 * @param config - the resolved backend configuration.
 * @param policy - the resolved execution policy for this session.
 * @returns the (possibly confined) argv.
 */
export function spawnArgv(ctx, config, policy) {
  const argv = [config.shellPath, ...config.shellArgs]
  if (policy.mode === 'danger-full-access') return argv
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) throw new Error(`terminal-fish: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world`)
  return sandbox.confine(argv, {
    ...policy,
    mode: policy.mode,
  }).argv
}

/**
 * Bring the fish session to readiness: submit the prompt setup once, then
 * poll with empty sends until the fish prompt satisfies the shared
 * readiness contract (OSC `133;D;` + `dsh> ` tail). Mirrors the official
 * `startupSession` pwsh branch, with a startup deadline race.
 * @param session - the backend session.
 * @param timeoutMs - readiness deadline.
 * @param signal - optional cancellation.
 */
export async function startupSession(session, timeoutMs, signal) {
  let startupOperation
  const start = async () => {
    let viewport = ''
    for (;;) {
      const first = viewport.length === 0
      startupOperation = session.startSend({
        text: first ? FISH_PROMPT_SETUP : '',
        submit: first,
        ...(signal !== undefined ? { signal } : {}),
      })
      const result = await startupOperation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      viewport = result.viewport
      if (result.waitReason === 'stdin_read') break
    }
    session.motd = viewport
  }
  const races = []
  let onAbort
  if (signal !== undefined) {
    const aborted = Promise.withResolvers()
    onAbort = () => {
      aborted.reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    races.push(aborted.promise)
  }
  const deadline = Promise.withResolvers()
  const deadlineTimer = setTimeout(() => {
    startupOperation?.cancel()
    deadline.reject(new Error('PTY shell did not reach readiness before startup timeout'))
  }, timeoutMs)
  races.push(deadline.promise)
  try {
    signal?.throwIfAborted()
    await Promise.race([start(), ...races])
  } finally {
    clearTimeout(deadlineTimer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Local fish PTY backend registered under the configured type (`fish`):
 * spawns `fish --no-config -i` (config-overridable) with the fish child
 * environment, confined through the shared sandbox policy, and brings it to
 * readiness with the fish prompt setup. Everything else (bounded output,
 * readiness polling, terminal-protocol replies, cleanup) is inherited from
 * `BashTerminalBackend`/`LocalPtySession`.
 */
export class FishTerminalBackend extends BashTerminalBackend {
  async spawn(spec) {
    spec.signal?.throwIfAborted()
    ensureSandboxModeFence(this.ctx, spec.owner)
    // Resolve services through `ctx.get` (never property access): the
    // backend may be constructed with a plugin context whose inject list
    // does not declare these services (the policy plugin's ctx), and Cordis
    // property access would throw "cannot get property … without inject".
    // `ctx.get` resolves any registered service regardless of inject.
    const policy = this.ctx.get('sandboxPolicy').resolve({ session: spec.owner.session })
    const argv = spawnArgv(this.ctx, this.config, policy)
    if (argv[0] === undefined) throw new Error('terminal-fish: sandbox returned empty argv')
    const terminal = await this.spawnTerminal({
      argv,
      cwd: spec.cwd ?? policy.workspaceRoot,
      env: childEnvironment(spec),
      rows: this.config.rows,
      cols: this.config.cols,
      graceMs: this.config.disposeGraceMs,
      signal: spec.signal,
    })
    const session = this.createSession(terminal, this.config)
    try {
      await startupSession(session, this.config.timeoutMs, spec.signal)
      return session
    } catch (error) {
      try {
        await session.close('PTY startup failed')
      } catch (closeError) {
        throw new TerminalBackendCleanupError(error, closeError)
      }
      throw error
    }
  }
}

/**
 * Register the local fish PTY backend in a `terminals` registry. The bundle
 * patch does NOT mount this plugin (host-plane profiles have no `terminals`
 * service); this entry point is for direct assembly and tests — and for the
 * real `minimal` preset composition, whose entry-local registry can pick the
 * backend up explicitly. Plugin configuration mirrors the official
 * `@deepseek-ai/dsh-terminal-bash` Config surface (sans dialect), with fish
 * defaults: backend type `fish`, `fish --no-config -i` argv.
 * @param ctx - the harness context.
 * @param config - optional backend configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  validateConfig(resolved)
  ctx.terminals.registerBackend(new FishTerminalBackend(ctx, resolved))
}
