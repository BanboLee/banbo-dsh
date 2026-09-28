/**
 * The `rtk rewrite` decision oracle: exit-code contract, constants, the deny
 * error, and the async/sync invocations that map one `rtk rewrite` outcome
 * onto the exhaustive {@link RtkRewriteDecision} union. The async variant is the
 * one the decorated executor's `execute` entry point consults; the synchronous
 * variant remains for callers that must settle the decision before their own
 * synchronous return (the pre-0.1.7 background `start()` contract). Neither
 * variant ever throws for a missing, hung, or failed oracle — those fail open
 * to passthrough so execution is never blocked.
 *
 * @module @banbolee/dsh-rtk/rewrite-decision
 */

import { execFile, spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Default bound on a single `rtk rewrite` oracle call before failing open. */
export const RTK_REWRITE_TIMEOUT_MS = 5_000

/**
 * Legacy compatibility constant for callers that use the decision-oracle API
 * directly. The mounted plugin ignores this note so exit-3 (`ask`) remains silent.
 */
export const RTK_ASK_NOTE = 'rtk rewrite exit 3 (ask) ran the rewritten command without interactive approval'

/**
 * The decision from one `rtk rewrite` invocation. Exhaustive: a rewrite
 * (with an optional compatibility note), a passthrough, or a deny.
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
 * Return one canonical executable path, or undefined when it cannot be used.
 * @param {string} candidate
 * @returns {string | undefined}
 */
function executablePath(candidate) {
  if (process.platform === 'win32' && ['.bat', '.cmd'].includes(extname(candidate).toLowerCase())) return undefined
  try {
    if (!statSync(candidate).isFile()) return undefined
    accessSync(candidate, constants.X_OK)
    return realpathSync(candidate)
  } catch {
    return undefined
  }
}

/**
 * Resolve RTK independently of a command's cwd and PATH. Relative configured
 * paths use the Harness working directory; bare names use the trusted startup
 * PATH. The result is absolute so request-local PATH entries cannot replace or
 * disable the decision process. Windows batch shims are excluded because
 * execFile/spawnSync require a directly executable binary.
 * @param {string} command
 * @param {{ cwd?: string; path?: string; pathExt?: string }} [options]
 * @returns {string | undefined}
 */
export function resolveRtkBinary(command, {
  cwd = process.cwd(),
  path = process.env.PATH ?? '',
  pathExt = process.env.PATHEXT ?? '.COM;.EXE',
} = {}) {
  if (typeof command !== 'string' || command.length === 0) return undefined
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return executablePath(isAbsolute(command) ? command : resolve(cwd, command))
  }
  const extensions = process.platform === 'win32' && extname(command).length === 0
    ? pathExt.split(';').filter(extension => ['.COM', '.EXE'].includes(extension.toUpperCase()))
    : ['']
  for (const directory of path.split(delimiter)) {
    const base = resolve(directory || cwd, command)
    for (const extension of extensions) {
      const hit = executablePath(base + extension)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

// Keep the oracle's non-lookup environment aligned with the delegated shell.
// PATH/PATHEXT remain trusted so a request cannot replace the pinned executable
// or its script interpreter; the delegated command still receives its own PATH.
const SHELL_ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/**
 * Build the local subprocess environment for one resolved shell spec. The
 * declared shape mirrors Node's `ProcessEnv` because an explicit `undefined`
 * entry removes an inherited key; no `undefined` entry survives the merge.
 * @param {Record<string, string | undefined> | undefined} env
 * @param {Record<string, string | undefined> | undefined} dshEnv
 * @returns {Record<string, string | undefined>}
 */
function effectiveShellEnv(env, dshEnv) {
  const parent = scrubbedParentEnv()
  if (process.platform !== 'win32') {
    /** @type {Record<string, string | undefined>} */
    const merged = { ...parent, ...SHELL_ENV_OVERRIDES, ...env, ...dshEnv }
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) delete merged[key]
    }
    if (parent.PATH === undefined) delete merged.PATH
    else merged.PATH = parent.PATH
    return merged
  }
  let entries = Object.entries(parent)
  for (const layer of [SHELL_ENV_OVERRIDES, env, dshEnv]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      const normalized = key.toUpperCase()
      if (normalized === 'PATH' || normalized === 'PATHEXT') continue
      entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized)
      if (value !== undefined) entries.push([key, value])
    }
  }
  return Object.fromEntries(entries)
}

/**
 * Map one `rtk rewrite` outcome onto the exhaustive {@link RtkRewriteDecision}.
 * @param {number} code - the rtk process exit code.
 * @param {string} stdout - captured stdout.
 * @param {string} stderr - captured stderr.
 * @param {string} command - the original command.
 * @param {string} askNote - the compatibility note returned for exit 3 (ask).
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
 * failed oracle — those fail open to passthrough. A caller cancellation is not
 * an oracle failure: the in-flight child is killed immediately and the caller's
 * own abort reason propagates, so a cancelled command is never delegated after
 * waiting out the oracle.
 * @param {string} command - the shell command to rewrite.
 * @param {{ rtkBinary?: string | null; timeoutMs?: number; askNote?: string; cwd?: string; env?: Record<string, string | undefined>; dshEnv?: Record<string, string | undefined>; signal?: AbortSignal }} [options] - oracle knobs; null means startup resolution found no RTK.
 * @returns {Promise<RtkRewriteDecision>}
 */
export async function rtkRewriteDecision(command, { rtkBinary = 'rtk', timeoutMs = RTK_REWRITE_TIMEOUT_MS, askNote = RTK_ASK_NOTE, cwd, env, dshEnv, signal } = {}) {
  const executable = rtkBinary === null ? undefined : resolveRtkBinary(rtkBinary)
  if (executable === undefined) return { kind: 'passthrough' }
  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const result = await execFileAsync(executable, ['rewrite', '--', command], {
      timeout: timeoutMs,
      ...(cwd !== undefined ? { cwd } : {}),
      // `execFile` kills the child on abort and reports the cancellation
      // through the callback, so the oracle cannot outlive its caller.
      ...(signal !== undefined ? { signal } : {}),
      env: effectiveShellEnv(env, dshEnv),
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    // Cancellation wins over any oracle failure classification: propagating the
    // caller's own reason keeps cancellation immediate and identical to the
    // delegated executor's, instead of failing open and running a command the
    // caller already cancelled. (Checked before `killed`, which an abort also
    // reports.)
    if (signal?.aborted === true) signal.throwIfAborted()
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
 * Synchronous variant of {@link rtkRewriteDecision}, for a caller that must
 * settle the decision before its own synchronous return — the pre-0.1.7
 * background `start()` contract, where a synchronous delegate/provider failure
 * (e.g. a sandbox `confine` throwing) had to propagate from the `start()` call
 * itself. The decorated `execute` entry point is async and uses the async
 * variant. A missing, hung, or signal-killed oracle still fails open to
 * passthrough and never blocks execution.
 *
 * This variant deliberately takes no `signal`: `spawnSync` cannot be
 * interrupted by an abort (it blocks the event loop for up to `timeoutMs`), so
 * a cancellable caller must use {@link rtkRewriteDecision} instead.
 * @param {string} command - the shell command to rewrite.
 * @param {{ rtkBinary?: string | null; timeoutMs?: number; askNote?: string; cwd?: string; env?: Record<string, string | undefined>; dshEnv?: Record<string, string | undefined> }} [options] - oracle knobs; null means startup resolution found no RTK.
 * @returns {RtkRewriteDecision}
 */
export function rtkRewriteDecisionSync(command, { rtkBinary = 'rtk', timeoutMs = RTK_REWRITE_TIMEOUT_MS, askNote = RTK_ASK_NOTE, cwd, env, dshEnv } = {}) {
  const executable = rtkBinary === null ? undefined : resolveRtkBinary(rtkBinary)
  if (executable === undefined) return { kind: 'passthrough' }
  const result = spawnSync(executable, ['rewrite', '--', command], {
    timeout: timeoutMs,
    encoding: 'utf8',
    ...(cwd !== undefined ? { cwd } : {}),
    env: effectiveShellEnv(env, dshEnv),
  })
  // Fail open: missing binary (result.error) or a timeout/signal kill
  // (status === null) never blocks command execution.
  if (result.error !== undefined || result.status === null) {
    return { kind: 'passthrough' }
  }
  return mapRtkExit(result.status, result.stdout ?? '', result.stderr ?? '', command, askNote)
}
