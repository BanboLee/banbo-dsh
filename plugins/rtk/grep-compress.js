/**
 * Model-facing grep output compression through `rtk pipe -f grep`.
 *
 * The listener below is this plugin's structural seam onto the `tools` service:
 * rtk deliberately does not depend on `@deepseek-ai/dsh-tools`, so the shapes it
 * must satisfy are declared here as mirrors of that package's 0.1.7-rc.2
 * `tools/post-execute` contract.
 *
 * @module @banbolee/dsh-rtk/grep-compress
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Default bound on a single `rtk pipe` call before failing open. */
export const RTK_PIPE_TIMEOUT_MS = 5_000

/** Explicit output ceiling matching rtk's own 10 MiB RAW_CAP. */
const RTK_PIPE_MAX_BUFFER_BYTES = 10 * 1024 * 1024

/** One model-facing content block, as `@deepseek-ai/dsh-llm` declares it. */
/** @typedef {import('@deepseek-ai/dsh-llm').ContentBlock} ContentBlock */

/**
 * The dispatched call this listener observes: the `tools/post-execute`
 * subset it consumes, namely `ToolExecution.name` plus the caller cancellation
 * signal every async listener must forward.
 * @typedef {{ readonly name: string; readonly signal?: AbortSignal }} PostExecuteExecution
 */

/**
 * A dispatched `tools/post-execute` result, mirroring the fields of
 * `Readonly<ToolExecutionResult>` this plugin reasons about (success and failure
 * results alike). `value`, `error`, and the message members stay opaque because
 * their real types live in packages this plugin does not depend on.
 * @typedef {{ readonly isError: boolean; readonly content: readonly ContentBlock[]; readonly value?: unknown; readonly error?: unknown; readonly additionalContexts?: readonly unknown[] }} PostExecuteResult
 */

/**
 * The `accept` decision that projects content blocks this listener may replace;
 * its `value` accept sibling carries the canonical payload instead.
 * @typedef {{ kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: readonly unknown[] }} PostToolContentDecision
 */

/**
 * The `tools/post-execute` waterfall decision, mirroring `PostToolDecision` from
 * `@deepseek-ai/dsh-tools@0.1.7-rc.2`. `additionalContexts` stays opaque here
 * because its `UserMessage` member comes from `@deepseek-ai/dsh-session`, which
 * this plugin does not depend on.
 * @typedef {PostToolContentDecision | { kind: 'accept'; value: unknown; content?: never; additionalContexts?: readonly unknown[] } | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: readonly unknown[] }} PostToolDecision
 */

/**
 * Whether one decision accepts content this listener may replace: an `accept`
 * without an own `value` (the `value` form is authoritative and must be
 * carried through untouched).
 * @param {PostToolDecision} decision
 * @returns {decision is PostToolContentDecision}
 */
function acceptsReplaceableContent(decision) {
  return decision.kind === 'accept' && !Object.hasOwn(decision, 'value')
}

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
 * @param {{ timeout: number; maxBuffer: number; signal?: AbortSignal }} options
 * @param {string} input
 * @param {(error: Error | null, result: { stdout: string; stderr: string }) => void} callback
 */
function execFileWithInput(file, args, options, input, callback) {
  const child = execFile(file, args, options, (error, stdout, stderr) => {
    callback(error, { stdout, stderr })
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(input)
}

const execFileWithInputAsync = promisify(execFileWithInput)

/**
 * Pipe text through `rtk pipe -f grep`. Any process failure — including the
 * caller's cancellation, which kills the pipe child immediately — fails open to
 * the original text and never escapes to the caller.
 * @param {string} text
 * @param {{ rtkBinary?: string | null; timeoutMs?: number; signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function rtkPipeCompress(text, { rtkBinary = 'rtk', timeoutMs = RTK_PIPE_TIMEOUT_MS, signal } = {}) {
  if (rtkBinary === null) return text
  try {
    const result = await execFileWithInputAsync(
      rtkBinary,
      ['pipe', '-f', 'grep'],
      {
        timeout: timeoutMs,
        maxBuffer: RTK_PIPE_MAX_BUFFER_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      },
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
 * fields forward. The call's own cancellation signal is forwarded to the pipe,
 * so an aborted call fails open immediately instead of waiting out the pipe
 * timeout.
 * @param {{ rtkBinary?: string | null; timeoutMs?: number }} [options]
 * @returns {(exec: PostExecuteExecution, result: PostExecuteResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>}
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
      if (chain.attempted || exec.name !== 'grep' || !acceptsReplaceableContent(decision)) {
        return decision
      }
      const content = decision.content ?? result.content
      if (content.length !== 1) {
        return decision
      }
      const first = content[0]
      if (first?.type !== 'text') {
        return decision
      }
      chain.attempted = true
      const text = first.text
      const compressed = await rtkPipeCompress(text, {
        ...options,
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      if (compressed === text) {
        return decision
      }
      return { ...decision, content: [{ ...first, text: compressed }] }
    } finally {
      chain.depth -= 1
      if (chain.depth === 0) {
        grepCompressionChains.delete(exec)
      }
    }
  }
}
