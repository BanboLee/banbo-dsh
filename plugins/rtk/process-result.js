/**
 * Process-result wrappers for the RTK shell executor: the fail-closed
 * execution handle for an RTK deny and deprecated compatibility helpers for
 * legacy consumers. The mounted plugin never calls the compatibility helpers,
 * so exit-3 (`ask`) execution remains silent.
 *
 * @module @banbolee/dsh-rtk/process-result
 */

import { RtkDenyError } from './rewrite-decision.js'

/** A captured stream with nothing in it: the fail-closed handle spawns nothing. */
const EMPTY_STREAM = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }

/**
 * A non-consuming reader over one fixed note, in the same offset vocabulary as
 * a real captured stderr stream.
 * @param {string} note
 * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessOutputReader}
 */
function noteReader(note) {
  const bytes = Buffer.from(note, 'utf8')
  return {
    readFrom: (fromByte) => ({
      text: bytes.subarray(Math.min(fromByte, bytes.length)).toString('utf8'),
      nextOffset: bytes.length,
      lossy: false,
    }),
  }
}

/**
 * The fail-closed execution handle for an RTK deny: already killed, no
 * delegate invocation, and the deny reason surfaced once through the read
 * path. It serves both access paths of the shell seam — a caller that keeps the
 * handle reads the reason as background output, and one that awaits `result()`
 * gets the typed {@link RtkDenyError} the denied foreground run would have
 * thrown.
 * @param {string} reason - the deny reason from the rtk oracle.
 * @returns {import('@deepseek-ai/dsh-shell').ShellExecution}
 */
export function deniedProcess(reason) {
  const note = `[rtk] rtk rewrite denied the command: ${reason}`
  let delivered = false
  /** @type {Promise<never> | undefined} */
  let denial
  return {
    status: 'killed',
    exitCode: null,
    signal: null,
    done: Promise.resolve(),
    observed: { stdout: EMPTY_STREAM, stderr: noteReader(note) },
    readOutput() {
      if (delivered) return { delta: '', lossy: false }
      delivered = true
      return { delta: note, lossy: false }
    },
    kill() {
      return false
    },
    result() {
      // Created on demand and memoized, like a real handle's result
      // projection; a denied process is never spawned, so nothing else can
      // settle it.
      denial ??= Promise.reject(new RtkDenyError(reason))
      return denial
    },
  }
}

/**
 * Legacy compatibility helper for consumers of the prior public API. The
 * mounted plugin does not call this helper; ask rewrites are silent at runtime.
 * @param {{ status: string; exitCode: number | null; signal: string | null; sandbox?: object; done: Promise<void>; readOutput: () => { delta: string; lossy: boolean }; kill: () => boolean }} inner
 * @param {string} note
 * @returns {{ readonly status: string; readonly exitCode: number | null; readonly signal: string | null; readonly sandbox?: object; readonly done: Promise<void>; readOutput: () => { delta: string; lossy: boolean }; kill: () => boolean }}
 */
export function withNoteProcess(inner, note) {
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

/**
 * Legacy compatibility helper for consumers of the prior public API. The
 * mounted plugin does not call this helper; ask rewrites are silent at runtime.
 * @param {{ stderr: { text: string }; [key: string]: unknown }} result
 * @param {string} note
 * @returns {{ stderr: { text: string }; [key: string]: unknown }}
 */
export function withNote(result, note) {
  const text = result.stderr.text.length > 0 ? `${result.stderr.text}\n[rtk] ${note}` : `[rtk] ${note}`
  return { ...result, stderr: { ...result.stderr, text } }
}
