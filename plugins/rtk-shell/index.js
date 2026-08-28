/**
 * RTK shell executor for DeepSeek Harness: a `SandboxBashExecutor` subclass
 * that transparently asks `rtk rewrite` before every command and hands the
 * rewritten command to the delegated bash-sandbox provider. Sandbox
 * confinement, credential scrub, bounded output collection, timeout clamping,
 * abort handling, and every `ShellRunResult`/`ShellProcess` fact are inherited
 * verbatim from the delegate — only the command text that reaches it changes.
 *
 * Exit-code contract (matches `rtk rewrite` and the upstream hooks):
 * - exit 0: rewrite and run `rtk <command>`.
 * - exit 1: no rewrite — delegate the original command unchanged.
 * - exit 2: deny — fail closed with a deterministic {@link RtkDenyError} and
 *   zero delegate invocations (foreground) or a killed, noted background
 *   process.
 * - exit 3: ask — implemented as rewrite-with-note (no interactive approval);
 *   the deterministic {@link RTK_ASK_NOTE} is appended to the result stderr
 *   (foreground) or prefixed to the first background read.
 * - missing/hung `rtk` (ENOENT/ETIMEDOUT/other failures): fail open to
 *   passthrough so execution is never blocked, mirroring the upstream hooks'
 *   graceful-degradation contract.
 *
 * Mounted as `ctx.shell` by the bundle patch in place of `bash-sandbox`; the
 * package never mounts a second shell provider.
 *
 * @module dsh-rtk-shell
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

/** Default bound on a single `rtk rewrite` oracle call before failing open. */
export const RTK_REWRITE_TIMEOUT_MS = 5_000

/**
 * Deterministic approval note for `rtk rewrite` exit 3 (`ask`): the plan
 * implements ask as rewrite-with-note instead of interactive approval.
 */
export const RTK_ASK_NOTE = 'rtk rewrite exit 3 (ask) ran the rewritten command without interactive approval'

/**
 * The decision from one `rtk rewrite` invocation. Exhaustive: a rewrite
 * (with an optional approval note), a passthrough, or a deny.
 * @typedef {{ kind: 'rewrite'; command: string; note?: string } | { kind: 'passthrough' } | { kind: 'deny'; reason: string }} RtkRewriteDecision
 */

/**
 * A deterministic, typed failure for an `rtk rewrite` deny (exit 2). Carries
 * the deny reason and a stable machine code so tool layers can branch on it.
 */
export class RtkDenyError extends Error {
  /** @param {string} reason - the deny reason from the rtk oracle. */
  constructor(reason) {
    super(reason)
    this.name = 'RtkDenyError'
    this.code = 'RTK_DENY'
    /** @type {string} */
    this.reason = reason
  }
}

const execFileAsync = promisify(execFile)

/**
 * Invoke the `rtk rewrite` oracle for one command and map its exit code to an
 * exhaustive {@link RtkRewriteDecision}. Never throws for a missing, hung, or
 * failed oracle — those fail open to passthrough.
 * @param {string} command - the shell command to rewrite.
 * @param {{ rtkBinary?: string; timeoutMs?: number; askNote?: string }} [options] - oracle knobs.
 * @returns {Promise<RtkRewriteDecision>}
 */
export async function rtkRewriteDecision(command, { rtkBinary = 'rtk', timeoutMs = RTK_REWRITE_TIMEOUT_MS, askNote = RTK_ASK_NOTE } = {}) {
  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const result = await execFileAsync(rtkBinary, ['rewrite', command], { timeout: timeoutMs })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    const failure = /** @type {{ code?: number | string; killed?: boolean; stdout?: string; stderr?: string }} */ (error)
    // Fail open: a hung or missing rtk never blocks command execution.
    if (failure?.killed === true || failure?.code === 'ETIMEDOUT' || failure?.code === 'ENOENT') {
      return { kind: 'passthrough' }
    }
    code = typeof failure?.code === 'number' ? failure.code : 0
    stdout = failure?.stdout ?? ''
    stderr = failure?.stderr ?? ''
  }
  const rewritten = stdout.trim()
  const changed = rewritten.length > 0 && rewritten !== command
  if (code === 2) {
    return { kind: 'deny', reason: stderr.trim() || 'rtk rewrite denied the command' }
  }
  if (code === 3) {
    return changed ? { kind: 'rewrite', command: rewritten, note: askNote } : { kind: 'passthrough' }
  }
  if (code === 0) {
    return changed ? { kind: 'rewrite', command: rewritten } : { kind: 'passthrough' }
  }
  // Any other exit (1 = no rewrite, or unknown) delegates unchanged.
  return { kind: 'passthrough' }
}

/**
 * Sandbox-preserving RTK shell executor. Registers as `ctx.shell` in place of
 * the base executor and requires the same `ctx.sandbox`/`ctx.sandboxPolicy`
 * providers; the tool layer is unchanged. `resolve()` is inherited verbatim
 * from the sandbox executor so every spec field fills identically.
 */
export class RtkShellExecutor extends SandboxBashExecutor {
  /**
   * The bash-sandbox knobs plus the rtk oracle knobs, reused verbatim: the
   * schemastery `object` schema preserves unknown keys, so `rtkBinary`,
   * `rewriteTimeoutMs`, and `askNote` ride through validation untouched and
   * the constructor reads them from the composition entry (a settings scope
   * re-sourced through the inherited bash-local namespace does not carry them).
   */
  static Config = LocalBashExecutor.Config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('@deepseek-ai/dsh-bash-local').Config & { rtkBinary?: string; rewriteTimeoutMs?: number; askNote?: string }} config - the composition entry.
   */
  constructor(ctx, config) {
    super(ctx, config)
    this.rtkBinary = config.rtkBinary ?? 'rtk'
    this.rewriteTimeoutMs = config.rewriteTimeoutMs ?? RTK_REWRITE_TIMEOUT_MS
    this.askNote = config.askNote ?? RTK_ASK_NOTE
  }

  /**
   * Run a command in the foreground, applying the `rtk rewrite` decision
   * before the delegated provider executes it.
   * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec - a resolved spec.
   * @returns {Promise<import('@deepseek-ai/dsh-shell').ShellRunResult>}
   */
  async run(spec) {
    if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
    const decision = await rtkRewriteDecision(spec.command, this._rtkOptions())
    if (decision.kind === 'deny') {
      throw new RtkDenyError(decision.reason)
    }
    const target = decision.kind === 'rewrite' ? { ...spec, command: decision.command } : spec
    const result = await super.run(target)
    if (decision.kind === 'rewrite' && decision.note !== undefined) {
      return this._withNote(result, decision.note)
    }
    return result
  }

  /**
   * Start a background process, applying the `rtk rewrite` decision before the
   * delegated provider spawns it. The handle is returned immediately; the real
   * process starts once the oracle answers, and `done` settles exactly once.
   * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec - a resolved spec.
   * @returns {import('@deepseek-ai/dsh-shell').ShellProcess}
   */
  start(spec) {
    const options = this._rtkOptions()
    /** @type {import('@deepseek-ai/dsh-shell').ShellProcess | null} */
    let inner = null
    /** @type {string | undefined} */
    let pendingNote = undefined
    /** @type {string | undefined} */
    let failureNote = undefined
    let killedBeforeSpawn = false

    /** @type {import('@deepseek-ai/dsh-shell').ShellProcess} */
    let proc = /** @type {import('@deepseek-ai/dsh-shell').ShellProcess} */ (/** @type {unknown} */ (null))
    proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: (async () => {
        try {
          const decision = await rtkRewriteDecision(spec.command, options)
          if (killedBeforeSpawn) return
          if (decision.kind === 'deny') {
            proc.status = 'killed'
            failureNote = `rtk rewrite denied the command: ${decision.reason}`
            return
          }
          const target = decision.kind === 'rewrite' ? { ...spec, command: decision.command } : spec
          if (decision.kind === 'rewrite' && decision.note !== undefined) {
            pendingNote = decision.note
          }
          inner = super.start(target)
          await inner.done
          proc.exitCode = inner.exitCode
          proc.signal = inner.signal
          proc.status = inner.status
          proc.sandbox = inner.sandbox
        } catch (error) {
          proc.status = 'killed'
          failureNote = `rtk rewrite failed: ${String(error)}`
        }
      })(),
      readOutput() {
        if (failureNote !== undefined) {
          const note = failureNote
          failureNote = undefined
          return { delta: `[rtk] ${note}`, lossy: false }
        }
        if (inner === null) return { delta: '', lossy: false }
        const read = inner.readOutput()
        if (pendingNote !== undefined) {
          const note = pendingNote
          pendingNote = undefined
          const separator = read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''
          return { ...read, delta: `[rtk] ${note}${separator}${read.delta}` }
        }
        return read
      },
      kill() {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        if (inner !== null) return inner.kill()
        killedBeforeSpawn = true
        return true
      },
    }
    return proc
  }

  /** @returns {{ rtkBinary: string; timeoutMs: number; askNote: string }} */
  _rtkOptions() {
    return { rtkBinary: this.rtkBinary, timeoutMs: this.rewriteTimeoutMs, askNote: this.askNote }
  }

  /**
   * Append a deterministic note to a settled result's stderr, preserving the
   * delegate's own stderr text and every other result fact.
   * @param {import('@deepseek-ai/dsh-shell').ShellRunResult} result
   * @param {string} note
   * @returns {import('@deepseek-ai/dsh-shell').ShellRunResult}
   */
  _withNote(result, note) {
    const text = result.stderr.text.length > 0 ? `${result.stderr.text}\n[rtk] ${note}` : `[rtk] ${note}`
    return { ...result, stderr: { ...result.stderr, text } }
  }
}

export default RtkShellExecutor
