/**
 * The RTK shell executor for DeepSeek Harness: a `SandboxBashExecutor`
 * subclass that transparently asks `rtk rewrite` before every command and
 * hands the rewritten command to the delegated bash-sandbox provider. Sandbox
 * confinement, credential scrub, bounded output collection, timeout clamping,
 * abort handling, and every `ShellRunResult`/`ShellProcess` fact are inherited
 * verbatim from the delegate — only the command text that reaches it changes.
 *
 * Exit-code contract (matches `rtk rewrite` and the upstream hooks):
 * - exit 0: rewrite and run `rtk <command>`.
 * - exit 1: no rewrite — delegate the original command unchanged.
 * - exit 2: deny — fail closed with a deterministic `RtkDenyError` and zero
 *   delegate invocations (foreground) or a killed, noted background process.
 * - exit 3: ask — implemented as rewrite-with-note (no interactive approval);
 *   the deterministic `RTK_ASK_NOTE` is appended to the result stderr
 *   (foreground) or prefixed to the first background read.
 * - missing/hung `rtk` (ENOENT/ETIMEDOUT/other failures): fail open to
 *   passthrough so execution is never blocked, mirroring the upstream hooks'
 *   graceful-degradation contract.
 *
 * Mounted as `ctx.shell` by the bundle patch in place of `bash-sandbox`; the
 * package never mounts a second shell provider.
 *
 * @module dsh-rtk-shell/executor
 */

import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { deniedProcess, withNote, withNoteProcess } from './process-result.js'
import { RTK_ASK_NOTE, RTK_REWRITE_TIMEOUT_MS, RtkDenyError, rtkRewriteDecision, rtkRewriteDecisionSync } from './rewrite-decision.js'

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
      return withNote(result, decision.note)
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
      return deniedProcess(decision.reason)
    }
    const target = decision.kind === 'rewrite' ? { ...spec, command: decision.command } : spec
    // Delegate startup errors (confine throwing, runner spawn failure) escape
    // synchronously here with their original type and message, matching the
    // baseline SandboxBashExecutor.start() contract.
    const inner = super.start(target)
    if (decision.kind === 'rewrite' && decision.note !== undefined) {
      return withNoteProcess(inner, decision.note)
    }
    return inner
  }

  /** @returns {{ rtkBinary: string; timeoutMs: number; askNote: string }} */
  _rtkOptions() {
    return { rtkBinary: this.rtkBinary, timeoutMs: this.rewriteTimeoutMs, askNote: this.askNote }
  }
}

export default RtkShellExecutor
