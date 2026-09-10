/**
 * Process-result wrappers for the RTK shell executor: the fail-closed
 * background handle for an RTK deny and deprecated compatibility helpers for
 * legacy consumers. The mounted plugin never calls the compatibility helpers,
 * so exit-3 (`ask`) execution remains silent.
 *
 * @module dsh-rtk/process-result
 */

/**
 * The fail-closed background handle for an RTK deny: already killed, no
 * delegate invocation, and the deny reason surfaced once through the read
 * path.
 * @param {string} reason
 * @returns {{ status: string; exitCode: number | null; signal: string | null; done: Promise<void>; readOutput: () => { delta: string; lossy: boolean }; kill: () => boolean }}
 */
export function deniedProcess(reason) {
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
