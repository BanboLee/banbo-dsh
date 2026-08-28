/**
 * Public entrypoint of `dsh-rtk-shell`. Re-exports the RTK rewrite decision
 * oracle, the note/deny process wrappers' public surface, and the
 * {@link RtkShellExecutor} mounted as `ctx.shell` by the bundle patch. All
 * implementation lives in {@link module:dsh-rtk-shell/rewrite-decision},
 * {@link module:dsh-rtk-shell/process-result}, and
 * {@link module:dsh-rtk-shell/executor}.
 *
 * @module dsh-rtk-shell
 */

export { RtkShellExecutor, default } from './executor.js'
export { RTK_ASK_NOTE, RTK_REWRITE_TIMEOUT_MS, RtkDenyError, rtkRewriteDecision, rtkRewriteDecisionSync } from './rewrite-decision.js'
