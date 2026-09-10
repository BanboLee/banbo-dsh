/**
 * Model-facing grep output compression through `rtk pipe -f grep`.
 *
 * @module dsh-rtk/grep-compress
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Default bound on a single `rtk pipe` call before failing open. */
export const RTK_PIPE_TIMEOUT_MS = 5_000

/** Explicit output ceiling matching rtk's own 10 MiB RAW_CAP. */
const RTK_PIPE_MAX_BUFFER_BYTES = 10 * 1024 * 1024

/**
 * Waterfall listeners nest around the same execution object. Track one
 * in-flight chain so duplicate registrations share a single compression
 * attempt, then forget it when the outermost listener completes.
 * @type {WeakMap<object, { depth: number; attempted: boolean }>}
 */
const grepCompressionChains = new WeakMap()

/**
 * Execute a file with text supplied on stdin.
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeout: number; maxBuffer: number }} options
 * @param {string} input
 * @param {(error: Error | null, result?: { stdout: string; stderr: string }) => void} callback
 */
function execFileWithInput(file, args, options, input, callback) {
  const child = execFile(file, args, options, (error, stdout, stderr) => {
    callback(error, { stdout, stderr })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
}

const execFileWithInputAsync = promisify(execFileWithInput)

/**
 * Pipe text through `rtk pipe -f grep`. Any process failure fails open to the
 * original text and never escapes to the caller.
 * @param {string} text
 * @param {{ rtkBinary?: string | null; timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function rtkPipeCompress(text, { rtkBinary = 'rtk', timeoutMs = RTK_PIPE_TIMEOUT_MS } = {}) {
  if (rtkBinary === null) return text
  try {
    const result = await execFileWithInputAsync(
      rtkBinary,
      ['pipe', '-f', 'grep'],
      { timeout: timeoutMs, maxBuffer: RTK_PIPE_MAX_BUFFER_BYTES },
      text,
    )
    return result.stdout
  } catch {
    return text
  }
}

/**
 * Build a `tools/post-execute` waterfall listener. It delegates first so grep's
 * spill-recovery listener and every other downstream listener still run, then
 * compresses the effective text content while carrying downstream decision
 * fields forward.
 * @param {{ rtkBinary?: string | null; timeoutMs?: number }} [options]
 * @returns {(exec: { name: string }, result: { content: import('@deepseek-ai/cordis').ContentBlock[] }, next: () => Promise<object>) => Promise<object>}
 */
export function createGrepPostExecuteListener(options = {}) {
  return async (exec, result, next) => {
    let chain = grepCompressionChains.get(exec)
    if (chain === undefined) {
      chain = { depth: 0, attempted: false }
      grepCompressionChains.set(exec, chain)
    }
    chain.depth += 1
    try {
      const decision = await next()
      if (chain.attempted || exec.name !== 'grep' || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) {
        return decision
      }
      const content = decision.content ?? result.content
      if (content.length !== 1 || content[0]?.type !== 'text') {
        return decision
      }
      chain.attempted = true
      const text = content[0].text
      const compressed = await rtkPipeCompress(text, options)
      if (compressed === text) {
        return decision
      }
      return { ...decision, content: [{ ...content[0], text: compressed }] }
    } finally {
      chain.depth -= 1
      if (chain.depth === 0) {
        grepCompressionChains.delete(exec)
      }
    }
  }
}
