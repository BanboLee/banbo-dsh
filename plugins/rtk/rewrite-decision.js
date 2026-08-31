/**
 * The `rtk rewrite` decision oracle: exit-code contract, constants, the deny
 * error, and the async/sync invocations that map one `rtk rewrite` outcome
 * onto the exhaustive {@link RtkRewriteDecision} union. The async variant
 * powers the foreground {@link run} path; the synchronous variant powers the
 * background {@link start} path so a delegated startup failure can propagate
 * from the `start()` call frame exactly like the baseline executor. Neither
 * variant ever throws for a missing, hung, or failed oracle — those fail open
 * to passthrough so execution is never blocked.
 *
 * @module dsh-rtk/rewrite-decision
 */

import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

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
 * background path must consult the oracle before the delegated executor's
 * `start` runs, so a synchronous delegate/provider failure (e.g. a sandbox
 * `confine` throwing) propagates from the `start()` call itself exactly like
 * the baseline. A missing, hung, or signal-killed oracle still fails open to
 * passthrough and never blocks execution.
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
