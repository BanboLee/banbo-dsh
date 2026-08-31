/**
 * Public entrypoint of `dsh-rtk`: a general-purpose Cordis function
 * plugin that decorates whatever shell executor the host mounts as `ctx.shell`.
 * Every command is transparently rewritten through `rtk rewrite` before the
 * delegate executes it; sandbox confinement, result facts, and lifecycle
 * semantics are inherited verbatim from the delegate because this plugin only
 * wraps the live `ctx.shell` object's `run`/`start` methods — it never mounts
 * (or replaces) a shell provider, so it coexists with any executor (bash,
 * fish, ...) without a duplicate service registration.
 *
 * Re-exports the {@link module:dsh-rtk/rewrite-decision} oracle and the
 * {@link module:dsh-rtk/process-result} wrappers' public surface.
 *
 * @module dsh-rtk
 */

import { deniedProcess, withNote, withNoteProcess } from './process-result.js'
import { createGrepPostExecuteListener } from './grep-compress.js'
import { RTK_ASK_NOTE, RTK_REWRITE_TIMEOUT_MS, RtkDenyError, rtkRewriteDecision, rtkRewriteDecisionSync } from './rewrite-decision.js'

/** Cordis trace proxies expose their stable service target through this symbol. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * Shared ownership for each decorated shell. Weak keys avoid extending a
 * shell's lifetime or adding plugin-specific properties to a host service.
 * @type {WeakMap<object, {
 *   refs: number;
 *   originalRun: Function;
 *   originalStart: Function;
 *   opts: { rtkBinary: string; timeoutMs: number; askNote: string };
 *   grepCompress: boolean;
 * }>}
 */
const decorations = new WeakMap()

/** Bundle row id this plugin is mounted under (`cordis.patch.yml`). */
export const name = 'rtk'

/** Decorates the live shell executor and the model-facing tools pipeline. */
export const inject = ['shell', 'tools']

/**
 * Plugin configuration schema: four rtk integration knobs. A plain object
 * implementing the standard-schema interface (no external validator): unknown
 * keys are ignored; rewrite settings plus grep post-execute compression are
 * normalized with their defaults.
 */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: 'dsh-rtk',
    validate(value) {
      const input = value ?? {}
      return {
        value: {
          rtkBinary: input.rtkBinary ?? 'rtk',
          rewriteTimeoutMs: input.rewriteTimeoutMs ?? RTK_REWRITE_TIMEOUT_MS,
          askNote: input.askNote ?? RTK_ASK_NOTE,
          grepCompress: input.grepCompress ?? true,
        },
      }
    },
  },
}

/**
 * Decorate the live `ctx.shell` executor with the `rtk rewrite` decision.
 *
 * `run`/`start` are replaced with wrappers that consult the rtk oracle first
 * (async for the foreground path, synchronous for the background path so a
 * delegate startup failure propagates from the `start()` call frame exactly
 * like the baseline). Deny fails closed with a deterministic `RtkDenyError`
 * (foreground) or a killed, noted process (background) and zero delegate
 * calls; exit-3 `ask` is implemented as rewrite-with-note. The originals are
 * restored when the last owning plugin fiber unloads. Duplicate mounts share
 * the first mount's configuration and only increase the ownership reference
 * count. When enabled, grep results are also compressed exactly once after
 * downstream post-execute listeners run.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {object} [config] - validated config; falls back to defaults.
 * @param {string} [config.rtkBinary]
 * @param {number} [config.rewriteTimeoutMs]
 * @param {string} [config.askNote]
 * @param {boolean} [config.grepCompress]
 */
export default function apply(ctx, config) {
  const shell = ctx.shell
  const shellTarget = shell[CORDIS_ORIGINAL] ?? shell
  let decoration = decorations.get(shellTarget)
  if (decoration === undefined) {
    const rtkBinary = config?.rtkBinary ?? 'rtk'
    const rewriteTimeoutMs = config?.rewriteTimeoutMs ?? RTK_REWRITE_TIMEOUT_MS
    const askNote = config?.askNote ?? RTK_ASK_NOTE
    const originalRun = shellTarget.run
    const originalStart = shellTarget.start
    const opts = { rtkBinary, timeoutMs: rewriteTimeoutMs, askNote }
    decoration = {
      refs: 0,
      originalRun,
      originalStart,
      opts,
      grepCompress: config?.grepCompress ?? true,
    }
    decorations.set(shellTarget, decoration)
    shellTarget.run = async (spec) => {
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      const decision = await rtkRewriteDecision(spec.command, opts)
      if (decision.kind === 'deny') {
        throw new RtkDenyError(decision.reason)
      }
      const target = decision.kind === 'rewrite' ? { ...spec, command: decision.command } : spec
      const result = await originalRun.call(shellTarget, target)
      if (decision.kind === 'rewrite' && decision.note !== undefined) {
        return withNote(result, decision.note)
      }
      return result
    }
    shellTarget.start = (spec) => {
      const decision = rtkRewriteDecisionSync(spec.command, opts)
      if (decision.kind === 'deny') {
        return deniedProcess(decision.reason)
      }
      const target = decision.kind === 'rewrite' ? { ...spec, command: decision.command } : spec
      // Delegate startup errors (confine throwing, runner spawn failure) escape
      // synchronously here with their original type and message, matching the
      // baseline SandboxBashExecutor.start() contract.
      const inner = originalStart.call(shellTarget, target)
      if (decision.kind === 'rewrite' && decision.note !== undefined) {
        return withNoteProcess(inner, decision.note)
      }
      return inner
    }
  }
  decoration.refs += 1
  // Each mount owns one reference. Cordis may unload fibers in any order, so
  // only the final disposer restores the exact pre-decoration method objects.
  ctx.effect(() => () => {
    decoration.refs -= 1
    if (decoration.refs > 0) return
    shellTarget.run = decoration.originalRun
    shellTarget.start = decoration.originalStart
    decorations.delete(shellTarget)
  })
  // Cordis owns listeners per fiber. Register on each owner so non-LIFO
  // disposal leaves coverage; the listener's per-execution guard compresses
  // once, and all registrations use the first mount's shared options.
  if (decoration.grepCompress) {
    ctx.on('tools/post-execute', createGrepPostExecuteListener(decoration.opts), { prepend: true })
  }
}

// Cordis reads plugin metadata off the entry object itself: attach the named
// exports so both `ctx.plugin(defaultImport)` and a namespace-object load
// honor the injection dependency and config schema.
apply.inject = inject
apply.Config = Config

export { RTK_ASK_NOTE, RTK_REWRITE_TIMEOUT_MS, RtkDenyError, rtkRewriteDecision, rtkRewriteDecisionSync } from './rewrite-decision.js'
export { deniedProcess, withNote, withNoteProcess } from './process-result.js'
export { RTK_PIPE_TIMEOUT_MS, createGrepPostExecuteListener, rtkPipeCompress } from './grep-compress.js'
