/**
 * Process/result note wrappers for the RTK shell executor: the fail-closed
 * background handle for an RTK deny, the live-getter wrapper that prefixes an
 * exit-3 approval note to the first background read, and the foreground
 * stderr-note appender. Pure functions over structural process/result shapes;
 * no delegate or oracle logic lives here.
 *
 * @module dsh-rtk-shell/process-result
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
 * Wrap a live delegated process so the exit-3 approval note is prefixed to
 * the first read; every lifecycle fact is delegated live through getters so
 * it stays in sync as the underlying process settles.
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
 * Append a deterministic note to a settled result's stderr, preserving the
 * delegate's own stderr text and every other result fact.
 * @param {{ stderr: { text: string }; [key: string]: unknown }} result
 * @param {string} note
 * @returns {{ stderr: { text: string }; [key: string]: unknown }}
 */
export function withNote(result, note) {
  const text = result.stderr.text.length > 0 ? `${result.stderr.text}\n[rtk] ${note}` : `[rtk] ${note}`
  return { ...result, stderr: { ...result.stderr, text } }
}
