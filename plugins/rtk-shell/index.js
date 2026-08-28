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

import { execFile, spawnSync } from 'node:child_process'
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
 * Map one `rtk rewrite` outcome onto the exhaustive {@link RtkRewriteDecision}.
 * @param {number} code - the rtk process exit code.
 * @param {string} stdout - captured stdout.
 * @param {string} stderr - captured stderr.
 * @param {string} command - the original command.
 * @param {string} askNote - the note stamped for exit 3 (ask) rewrites.
 * @returns {RtkRewriteDecision}
 */
function mapRtkExit(code, stdout, stderr, command, askNote) {
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
  return mapRtkExit(code, stdout, stderr, command, askNote)
}

/**
 * Synchronous variant of {@link rtkRewriteDecision} for `start()`: the
 * background path must consult the oracle before the delegated
 * {@link SandboxBashExecutor.start} runs, so a synchronous delegate/provider
 * failure (e.g. `ctx.sandbox.confine` throwing) propagates from the `start()`
 * call itself exactly like the baseline. A missing, hung, or signal-killed
 * oracle still fails open to passthrough and never blocks execution.
 * @param {string} command - the shell command to rewrite.
 * @param {{ rtkBinary?: string; timeoutMs?: number; askNote?: string }} [options] - oracle knobs.
 * @returns {RtkRewriteDecision}
 */
export function rtkRewriteDecisionSync(command, { rtkBinary = 'rtk', timeoutMs = RTK_REWRITE_TIMEOUT_MS, askNote = RTK_ASK_NOTE } = {}) {
  const result = spawnSync(rtkBinary, ['rewrite', command], { timeout: timeoutMs, encoding: 'utf8' })
  // Fail open: missing binary (result.error) or a timeout/signal kill
  // (status === null) never blocks command execution.
  if (result.error !== undefined || result.status === null) {
    return { kind: 'passthrough' }
  }
  return mapRtkExit(result.status, result.stdout ?? '', result.stderr ?? '', command, askNote)
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
   * delegated provider spawns it. The oracle is consulted synchronously so the
   * delegated {@link SandboxBashExecutor.start} runs inside this call: a
   * synchronous provider failure (e.g. `ctx.sandbox.confine` throwing)
   * propagates from here exactly like the baseline, never relabeled as an RTK
   * failure. Deny still fails closed as a killed, noted process with zero
   * delegate calls.
   * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec - a resolved spec.
   * @returns {import('@deepseek-ai/dsh-shell').ShellProcess}
   */
  start(spec) {
    const decision = rtkRewriteDecisionSync(spec.command, this._rtkOptions())
    if (decision.kind === 'deny') {
      return this._deniedProcess(decision.reason)
    }
    const target = decision.kind === 'rewrite' ? { ...spec, command: decision.command } : spec
    // Delegate startup errors (confine throwing, runner spawn failure) escape
    // synchronously here with their original type and message, matching the
    // baseline SandboxBashExecutor.start() contract.
    const inner = super.start(target)
    if (decision.kind === 'rewrite' && decision.note !== undefined) {
      return this._withNoteProcess(inner, decision.note)
    }
    return inner
  }

  /**
   * The fail-closed background handle for an RTK deny: already killed, no
   * delegate invocation, and the deny reason surfaced once through the read
   * path.
   * @param {string} reason
   * @returns {import('@deepseek-ai/dsh-shell').ShellProcess}
   */
  _deniedProcess(reason) {
    let delivered = false
    return {
      status: 'killed',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput() {
        if (delivered) return { delta: '', lossy: false }
        delivered = true
        return { delta: `[rtk] rtk rewrite denied the command: ${reason}`, lossy: false }
      },
      kill() {
        return false
      },
    }
  }

  /**
   * Wrap a live delegated process so the exit-3 approval note is prefixed to
   * the first read; every lifecycle fact is delegated live through getters so
   * it stays in sync as the underlying process settles.
   * @param {import('@deepseek-ai/dsh-shell').ShellProcess} inner
   * @param {string} note
   * @returns {import('@deepseek-ai/dsh-shell').ShellProcess}
   */
  _withNoteProcess(inner, note) {
    let delivered = false
    return {
      get status() {
        return inner.status
      },
      get exitCode() {
        return inner.exitCode
      },
      get signal() {
        return inner.signal
      },
      get sandbox() {
        return inner.sandbox
      },
      get done() {
        return inner.done
      },
      readOutput() {
        const read = inner.readOutput()
        if (delivered) return read
        delivered = true
        const separator = read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''
        return { ...read, delta: `[rtk] ${note}${separator}${read.delta}` }
      },
      kill() {
        return inner.kill()
      },
    }
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
