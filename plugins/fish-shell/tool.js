/**
 * Model-facing `fish` tool for DeepSeek Harness.
 *
 * Registers a `fish` tool that runs commands through `fish -c` and returns
 * the collected output. The tool is self-contained (only Node built-ins) and
 * does not depend on the executor's `ctx.shell` service, so it can be mounted
 * in any profile; the `fish` executor (this package's default export)
 * independently supplies `ctx.shell` for consumers that resolve it.
 *
 * The tool description teaches fish syntax because models default to bash
 * idioms; without it, every `export`/`$(...)`/`if then fi` would fail under
 * fish.
 *
 * @module dsh-fish-shell/tool
 */

import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

export const name = 'fish-tool'
export const inject = ['tools']

/** Path to the fish binary. */
const FISH_BIN = 'fish'
/** Per-stream in-memory output cap; output beyond this is truncated and flagged. */
const MAX_OUTPUT_BYTES = 64 * 1024
/** Default per-call timeout when the model does not pass one. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Model-friendly environment overrides: disable colors, pagers, and
 * interactive terminal features that would garble tool output. The same set
 * the harness bash tool uses, plus FISH_PAGER.
 */
const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  FISH_PAGER: 'cat',
}

/**
 * The model-facing tool description. Written from the model's perspective:
 * the most important fact is that this is FISH, not bash, so the model must
 * translate bash idioms before running them.
 */
const TOOL_DESCRIPTION = `Execute a fish shell command (\`fish -c\`) and return its stdout/stderr. Each call runs in a fresh non-login fish: no state (cwd, variables, functions, history) persists between calls — pass \`workdir\` instead of using \`cd\`. This tool uses the FISH shell, NOT bash; translate bash commands to fish syntax first:
- Variables: \`set -gx NAME value\` (not \`export NAME=value\`); read them as \`$NAME\`. Use \`env\` to see exported variables.
- Conditionals/loops: \`if ...; ...; end\`, \`for x in ...; ...; end\`, \`while ...; ...; end\`, \`switch\` instead of \`case\`.
- Chaining: \`a; and b\` / \`a; or b\` (fish 3 also accepts \`&&\` / \`||\`); background a job with \`cmd &\` and wait with \`wait\`.
- Command substitution: \`(cmd)\` (fish 3 also accepts \`$(cmd)\`); arithmetic: \`math '1 + 2'\`; string processing: \`string ...\`.
- Expansion: \`~\`, \`$VAR\`, and globs like \`*.md\` expand; an unmatched glob is an error, not a literal.
- Non-zero exits are reported as \`[exit code: N]\`. Long output is truncated to its tail.`

/**
 * Run one command through `fish -c` with bounded output collection, an
 * optional timeout, and optional upstream cancellation. Kills the whole
 * process group on timeout/cancel so background children of the shell do not
 * survive it.
 * @param {object} options
 * @param {string} options.command - the fish command text.
 * @param {string | undefined} options.cwd - working directory.
 * @param {number | undefined} options.timeoutMs - per-call timeout; default applies.
 * @param {AbortSignal | undefined} options.signal - upstream cancellation.
 * @returns {Promise<object>} the settled foreground result.
 */
function runFish({ command, cwd, timeoutMs, signal }) {
  const deadline = timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(FISH_BIN, ['-c', command], {
      cwd: cwd ?? process.cwd(),
      env: { ...ENV_OVERRIDES, ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so kill(-pid) reaches background children too.
      detached: true,
    })
    const makeCollect = () => {
      let bytes = 0
      let truncated = false
      const parts = []
      const onData = (chunk) => {
        const take = Math.max(0, MAX_OUTPUT_BYTES - bytes)
        if (chunk.length > take) {
          truncated = true
          parts.push(chunk.subarray(0, take))
        } else {
          parts.push(chunk)
        }
        bytes += Math.min(chunk.length, take)
      }
      return { parts, truncated: () => truncated, onData }
    }
    const stdout = makeCollect()
    const stderr = makeCollect()
    child.stdout.on('data', stdout.onData)
    child.stderr.on('data', stderr.onData)

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGKILL')
    }, deadline)
    const onAbort = () => {
      aborted = true
      killGroup('SIGTERM')
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        aborted = true
        killGroup('SIGTERM')
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    function killGroup(sig) {
      try {
        process.kill(-child.pid, sig)
      } catch {
        // The group may already be gone; the close handler settles.
        try { child.kill(sig) } catch { /* already closed */ }
      }
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error) // infrastructure failure: fish missing, cwd unusable
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        kind: 'foreground',
        exitCode: code,
        signal: sig,
        timedOut,
        aborted,
        timeoutMs: deadline,
        stdout: { text: Buffer.concat(stdout.parts).toString('utf8'), truncated: stdout.truncated() },
        stderr: { text: Buffer.concat(stderr.parts).toString('utf8'), truncated: stderr.truncated() },
      })
    })
  })
}

/** Append a truncation notice to a stream's text. */
function streamText(stream) {
  if (!stream.truncated) return stream.text
  return `${stream.text}\n[output truncated]`
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers — the same marker contract the
 * harness bash tool uses, so the model reads both shells identically.
 * @param {object} result - the settled foreground result.
 * @returns {string} the model-facing text.
 */
function renderResult(result) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

const PARAMETERS = {
  command: {
    type: 'string',
    required: true,
    description: 'The fish command to execute.',
  },
  description: {
    type: 'string',
    required: true,
    description: 'Clear, concise description of what this command does in active voice, '
      + '5-10 words (shown in the UI). Examples: "git status" → "Show working tree status".',
  },
  workdir: {
    type: 'string',
    description: 'Working directory for this command. Defaults to the session workspace; '
      + 'a relative path is resolved against it.',
  },
  timeoutMs: {
    type: 'number',
    description: 'Timeout in milliseconds. The command is killed on expiry.',
  },
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'exitCode', 'signal', 'timedOut', 'aborted', 'stdout', 'stderr'],
    properties: {
      kind: { type: 'string', const: 'foreground' },
      exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      timedOut: { type: 'boolean' },
      aborted: { type: 'boolean' },
      timeoutMs: { type: 'number' },
      stdout: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'truncated'],
        properties: {
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      stderr: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'truncated'],
        properties: {
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
    },
  },
  render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
}

/** Resolve an explicit workdir, making a relative one session-workspace-relative. */
function resolveWorkdir(modelWorkdir, exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolve(sessionCwd, modelWorkdir)
  }
  return modelWorkdir
}

async function execute(args, exec) {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  const result = await runFish({
    command: args.command,
    cwd: resolveWorkdir(args.workdir, exec),
    timeoutMs: args.timeoutMs,
    signal: exec?.signal,
  })
  if (result.aborted) {
    const error = new Error('tool call aborted')
    error.name = 'AbortError'
    throw error
  }
  return result
}

/**
 * Cordis plugin entry: register the `fish` tool once the tool registry is up.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'fish',
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    execute,
  })
}
