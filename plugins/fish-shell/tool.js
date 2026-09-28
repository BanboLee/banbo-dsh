/**
 * Model-facing `fish` tool for DeepSeek Harness.
 *
 * Registers a `fish` tool that executes commands through the harness `fish`
 * executor (`ctx.shell`, the {@link FishSandboxExecutor} mounted by this
 * bundle) instead of spawning its own subprocess. Going through `ctx.shell`
 * means every call inherits the executor's sandbox confinement, credential
 * scrub, bounded output collection, timeout clamping, and result facts —
 * the standalone-spawn version this module used to carry was removed because
 * it bypassed all of that.
 *
 * The functional surface mirrors the official `@deepseek-ai/dsh-tool-bash`
 * (the harness's model-facing `bash` tool) with shell-specific wording
 * swapped to fish: background execution through `ctx.jobs` (the process's
 * non-consuming stream readers as the registry's pull sources, with the
 * sandbox facts joined to the job outcome), same-turn sandbox escalation through
 * `ctx.approval` (strictly-wider modes only, fail-closed), canonical
 * foreground results carrying the complete sandbox facts
 * (`enforcement`/`runnerFailed`), terminal/generic UI presentation, and the
 * `tool:fish` exit-code prompt section. On top of that it keeps this
 * bundle's fish-specific teaching: the description translates bash idioms,
 * and failed runs carry a `[fish syntax]` hint naming the exact fix.
 *
 * @module @banbolee/dsh-fish-shell/tool
 */

/// <reference path="./job-kind.d.ts" />

import { isAbsolute, resolve } from 'node:path'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'
import { DSH_ENV_PREFIX, parseExitStatus } from '@deepseek-ai/dsh-shell'

/**
 * Type-only reference so `@deepseek-ai/dsh-shell-env`'s module augmentation
 * (`ctx.shellEnv`, the service `inject` above requires) joins this checkJs
 * program: the bundle patch mounts the package at runtime, and this module has
 * no reason to import it as a value.
 * @typedef {import('@deepseek-ai/dsh-shell-env').ShellEnvRegistry} ShellEnvRegistry
 */

/**
 * One captured stream with its truncation facts.
 * @typedef {object} FishOutputStream
 * @property {string} text
 * @property {boolean} truncated
 * @property {string} [spillPath]
 */

/**
 * Sandbox facts carried into the canonical result (`ShellSandboxInfo` as
 * lossless JSON).
 * @typedef {object} FishSandboxFacts
 * @property {import('@deepseek-ai/dsh-sandbox').SandboxMode} mode
 * @property {boolean} denied
 * @property {import('@deepseek-ai/dsh-sandbox').SandboxEnforcement} [enforcement]
 * @property {boolean} [runnerFailed]
 */

/**
 * The `fish` tool's parsed arguments. Registration is raw JSON Schema, so the
 * registry hands the body `unknown`; these are the fields the tool validates
 * and narrows at runtime, typed as the schema admits them (every one optional).
 * @typedef {object} FishToolArgs
 * @property {string} [command] - the fish command to execute.
 * @property {string} [description] - the one-line UI description.
 * @property {string} [workdir] - optional working directory (session-relative when not absolute).
 * @property {number} [timeoutMs] - optional foreground deadline.
 * @property {boolean} [run_in_background] - run as a `ctx.jobs` background job.
 * @property {string} [sandbox_permissions] - one-shot escalation target.
 * @property {string} [justification] - the escalation's one-sentence reason.
 */

/**
 * The canonical JSON value of one foreground fish run — the `foreground`
 * branch of `OUTPUT_SCHEMA` and what `renderResult` renders. Structural on
 * purpose: a replay holds this projection, not the executor's
 * `ShellRunResult`.
 * @typedef {object} FishForegroundValue
 * @property {number | null} exitCode
 * @property {string | null} signal
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {number} timeoutMs
 * @property {FishOutputStream} stdout
 * @property {FishOutputStream} stderr
 * @property {FishSandboxFacts} [sandbox]
 */

export const name = 'fish-tool'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/**
 * The model-facing tool description. Written from the model's perspective:
 * the most important fact is that this is FISH, not bash, so the model must
 * translate bash idioms before running them. Structured like the official
 * bash tool description (markers, `DSH_*` environment facts, background
 * execution, sandbox escalation) on top of the fish syntax teaching.
 */
const BASE_TOOL_DESCRIPTION = `Execute a fish shell command (\`fish -c\`) and return its stdout/stderr. Each call runs in a fresh non-login fish: no state (cwd, variables, functions, history) persists between calls — pass \`workdir\` instead of using \`cd\`. This tool uses the FISH shell, NOT bash; translate bash commands to fish syntax first:
- Variables: \`set -gx NAME value\` (not \`export NAME=value\`); read them as \`$NAME\`. Use \`env\` to see exported variables.
- Conditionals/loops: \`if ...; ...; end\`, \`for x in ...; ...; end\`, \`while ...; ...; end\`, \`switch\` instead of \`case\`.
- Chaining: \`a; and b\` / \`a; or b\` (fish 3 also accepts \`&&\` / \`||\`); background a job with \`cmd &\` and wait with \`wait\`.
- Command substitution: \`(cmd)\` (fish 3 also accepts \`$(cmd)\`); arithmetic: \`math '1 + 2'\`; string processing: \`string ...\`.
- Expansion: \`~\`, \`$VAR\`, and globs like \`*.md\` expand; an unmatched glob is an error, not a literal.
- Commands may run under a file sandbox; a blocked file operation is reported as \`[sandbox: file access denied under <mode> mode]\` — a policy denial, not a bug in the command; do not retry another way.
- Non-zero exits are reported as \`[exit code: N]\`. Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.
- Set \`run_in_background: true\` for long-running commands: the call returns a job id immediately; read its output with \`job_output\` and stop it with \`job_kill\`. No timeout applies.
Bash idioms fish REJECTS with exit 127 — translate before running:
  \`VAR=x\` / \`export VAR=x\`      → \`set VAR x\` / \`set -gx VAR x\`
  \`for i in ...; do ...; done\`    → \`for i in ...; ...; end\`
  \`if [ c ]; then ...; fi\`        → \`if test c; ...; end\`
  \`cmd <<'EOF' ... EOF\` (heredoc) → \`printf '...' | cmd\` (fish has no heredoc)
If fish rejects your command, retry with the fish form from the table — failed results carry a [fish syntax] hint naming the exact fix.`

const ESCALATION_TOOL_DESCRIPTION = 'Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.'

const TOOL_DESCRIPTION = `${BASE_TOOL_DESCRIPTION}\n${ESCALATION_TOOL_DESCRIPTION}`

/**
 * The tool description for one composition: the escalation prose is appended
 * only when the composition advertises escalation targets.
 * @param {readonly import('@deepseek-ai/dsh-sandbox').SandboxMode[]} escalationModes - targets this composition advertises.
 * @returns {string} the model-facing description.
 */
function fishDescription(escalationModes) {
  return escalationModes.length === 0 ? BASE_TOOL_DESCRIPTION : TOOL_DESCRIPTION
}

/**
 * Targeted fish-syntax correction for a failed run. Models default to bash
 * idioms; when fish rejects a command the stderr carries a diagnostic like
 * "Unsupported use of '='. In fish, use 'set ...'". Instead of making the
 * model guess, map the exact diagnostic to the fish form. Returns '' when
 * there's nothing to correct.
 */
const FISH_SYNTAX_HINTS = [
  {
    pattern: /Unsupported use of '='\. In fish, please use 'set/i,
    hint: 'bash assignment `VAR=x` → fish `set VAR x` (export: `set -gx VAR x`)',
  },
  {
    pattern: /Expected a string, but found a redirection/i,
    hint: 'bash heredoc `cmd <<EOF` has no fish equivalent — use `printf \'...\' | cmd` or `echo ... | cmd`',
  },
  {
    pattern: /Missing end to balance this for loop/i,
    hint: 'bash `for x in ...; do ...; done` → fish `for x in ...; ...; end`',
  },
  {
    pattern: /Missing end to balance this if/i,
    hint: 'bash `if [ c ]; then ...; fi` → fish `if test c; ...; end`',
  },
  {
    pattern: /Unexpected end of string, quotes are not balanced/i,
    hint: 'unbalanced quotes — fish strings must close (`"..."` or `\'...\'`); check escaping',
  },
  {
    pattern: /No matches for wildcard/i,
    hint: 'unmatched glob is an error in fish — quote the path or check the pattern (e.g. `"*.json"`)',
  },
]

/**
 * Find a fish syntax hint for one stderr text, or '' when none applies.
 * @param {string} stderrText - the failed run's stderr text.
 * @returns {string} the mapped hint, or `''` when nothing applies.
 */
function fishSyntaxHint(stderrText) {
  for (const { pattern, hint } of FISH_SYNTAX_HINTS) {
    if (pattern.test(stderrText)) return hint
  }
  return ''
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then sandbox/timeout/signal/exit markers — the same marker
 * contract the harness bash tool uses, so the model reads both shells
 * identically. A denied run under an escalation-advertising composition
 * additionally carries the shared same-turn escalation hint.
 * @param {FishForegroundValue} result - the canonical foreground value from the executor.
 * @param {readonly string[]} [escalationModes] - the escalation targets this
 *   composition advertises; non-empty appends the same-turn escalation hint
 *   after a denial marker (default `[]`: no hint).
 * @returns {string} the model-facing text.
 */
function renderResult(result, escalationModes = []) {
  /**
   * @param {FishOutputStream} stream - one captured stream of the canonical value.
   * @returns {string} its text plus the truncation notice when it was cut.
   */
  const streamText = (stream) => {
    if (!stream.truncated) return stream.text
    return `${stream.text}\n[output truncated${stream.spillPath !== undefined
      ? `; full output: ${stream.spillPath}`
      : '; full output: (unavailable)'}]`
  }
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  // When the command failed and fish named a syntax problem, append the exact
  // correction so the model retries in fish form instead of guessing. The exit
  // marker alone ("[exit code: 127]") doesn't say how to fix it.
  const syntaxHint = result.exitCode !== 0 ? fishSyntaxHint(err) : ''
  if (syntaxHint.length > 0) {
    if (!body.endsWith('\n')) body += '\n'
    body += `[fish syntax] ${syntaxHint}`
  }

  const markers = []
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs ?? 0}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Sandbox facts worth the job's terminal detail: a runner that never ran the
 * command, or a denial (with the escalation hint this composition offers).
 * The `ctx.jobs` registry owns the read path now, so these notes travel on the
 * outcome's detail line — the one line every reader (the model's status line,
 * the job roster row) shows — instead of being appended to each read.
 * @param {import('@deepseek-ai/dsh-shell').ShellSandboxInfo | undefined} sandbox - settled sandbox facts, when this was a confined process.
 * @param {readonly string[]} escalationModes - escalation targets advertised by this composition.
 * @returns {string[]} the notes to append, oldest first.
 */
function sandboxNotes(sandbox, escalationModes) {
  if (sandbox?.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  return []
}

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering. Sandbox facts
 * join the detail, since a job's terminal reason is the one line every
 * reader — the model's status line, the roster row — shows.
 * @param {import('@deepseek-ai/dsh-shell').ShellProcess} proc - the settled process handle.
 * @param {readonly string[]} [escalationModes] - escalation targets advertised by this composition.
 * @returns {{ status: 'completed' | 'killed', detail: string }} the outcome for the `ctx.jobs` registration.
 */
function processOutcome(proc, escalationModes = []) {
  /** @type {{ status: 'completed' | 'killed', detail: string }} */
  const base = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : {
    ...base,
    detail: `${base.detail}; ${notes.join(' ')}`,
  }
}

/**
 * The process's non-consuming stream readers as `ctx.jobs` pull sources
 * (ported from the official `@deepseek-ai/dsh-tool-bash`'s background
 * adaptation: the registry pumps these instead of the removed
 * `JobHooks.readOutput`). They bind lazily because the handle is published
 * only after asynchronous preparation; a read before then yields nothing, and
 * the pump keeps the model's consuming cursor untouched.
 * @param {() => import('@deepseek-ai/dsh-shell').ShellProcess | undefined} process - resolves the published handle, once preparation has one.
 * @returns {readonly import('@deepseek-ai/dsh-jobs').JobOutputSource[]} one source per stream, stdout first.
 */
function processSources(process) {
  /**
   * @param {'stdout' | 'stderr'} channel - stream label the registry attaches to this source's chunks.
   * @returns {import('@deepseek-ai/dsh-jobs').JobOutputSource} one non-consuming pull source.
   */
  const source = (channel) => ({
    channel,
    /** @param {number} fromByte - whole-stream offset to resume from (a prior read's `nextOffset`). */
    read: (fromByte) => {
      const live = process()
      return live === undefined
        ? { text: '', nextOffset: fromByte, lossy: false }
        : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * Synchronous job hooks over asynchronous shell preparation (ported from the
 * official `@deepseek-ai/dsh-tool-bash`): `ctx.jobs` admits the job and calls
 * `run()` synchronously, while `ctx.shell.execute` publishes its handle only
 * after preparation. Cancellation aborts the preparation signal (which also
 * stops the command during preparation) and kills an already-published
 * process; `done` spans preparation and settlement, and never rejects.
 * @param {(signal: AbortSignal) => Promise<import('@deepseek-ai/dsh-shell').ShellExecution>} start - starts the process under a job-owned cancellation signal.
 * @param {(proc: import('@deepseek-ai/dsh-shell').ShellProcess) => { status: 'completed' | 'killed', detail: string }} outcome - projects the settled process into the job outcome.
 * @returns {{ cancel: (reason?: string) => void, done: Promise<{ status: 'completed' | 'killed' | 'failed', detail: string }> }} the job's hooks.
 */
function processJob(start, outcome) {
  const controller = new AbortController()
  /** @type {import('@deepseek-ai/dsh-shell').ShellExecution | undefined} */
  let proc
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      proc?.kill()
    },
    done: (async () => {
      try {
        proc = await start(controller.signal)
        try {
          if (controller.signal.aborted) proc.kill()
        } finally {
          await proc.done
        }
        return outcome(proc)
      } catch (error) {
        return {
          status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    })(),
  }
}

/**
 * Detach the executor DTO from readonly Service Definition types into plain JSON data.
 * @param {import('@deepseek-ai/dsh-shell').ShellRunResult} result - the settled foreground result.
 * @returns {FishForegroundValue} the canonical value declared by OUTPUT_SCHEMA.
 */
function canonicalFishResult(result) {
  /**
   * @param {import('@deepseek-ai/dsh-shell').CollectedOutput} s - one captured stream of the settled result.
   * @returns {FishOutputStream} its lossless-JSON projection.
   */
  const stream = (s) => ({
    text: s.text,
    truncated: s.truncated,
    ...s.spillPath !== undefined ? { spillPath: s.spillPath } : {},
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: stream(result.stdout),
    stderr: stream(result.stderr),
    ...result.sandbox !== undefined ? { sandbox: {
      mode: result.sandbox.mode,
      denied: result.sandbox.denied,
      ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
      ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
    } } : {},
  }
}

/**
 * Present the PENDING state of one call in a UI: a foreground command is a
 * terminal card (cwd-headed); a background call is a generic execute card.
 * Total over malformed replay args: a non-object or a missing/non-string
 * command/description returns `undefined` so the UI falls back to its
 * generic presentation instead of throwing or minting an invalid title.
 * @param {any} args - the call's parsed arguments.
 * @returns {import('@deepseek-ai/dsh-tools').ToolCallView | undefined} the pending card intent.
 */
function presentFishCall(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  if (typeof args.command !== 'string' || typeof args.description !== 'string') return undefined
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...typeof args.workdir === 'string' ? { cwd: args.workdir } : {},
  }
}

/**
 * Present completed foreground output as a terminal card with an exit-status
 * pill (recovered via `parseExitStatus`); background acknowledgements and
 * execution errors use generic fenced output without an exit-status pill.
 * Total over malformed replay args/results: invalid inputs return
 * `undefined` (generic UI fallback) instead of throwing.
 * @param {any} args - the call's parsed arguments.
 * @param {any} result - the durable result projection (validated here, so malformed replays cannot throw).
 * @returns {import('@deepseek-ai/dsh-tools').ToolResultView | undefined} the completed card intent.
 */
function presentFishResult(args, result) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  if (typeof args.command !== 'string') return undefined
  if (typeof result !== 'object' || result === null || Array.isArray(result) || !Array.isArray(result.content)) return undefined
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  if (args.run_in_background === true || result.isError) {
    return {
      card: 'generic',
      content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
    }
  }
  const { body, ...exit } = parseExitStatus(raw)
  return {
    card: 'terminal',
    output: body,
    ...exit,
  }
}

/** Object-root JSON Schema for the tool's parameters (raw-registered). */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'description'],
  properties: {
    command: {
      type: 'string',
      description: 'The fish command to execute.',
    },
    description: {
      type: 'string',
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
      description: 'Timeout in milliseconds (clamped to the executor\'s configured cap). '
        + 'The command is killed on expiry.',
    },
  },
}

/**
 * The tool's parameters for one composition: the base parameters plus
 * `run_in_background`, and the escalation fields only when the mounted
 * executor advertises confinement (an unadvertised field is never parsed).
 * @param {readonly import('@deepseek-ai/dsh-sandbox').SandboxMode[]} escalationModes - targets the composition advertises; empty hides the escalation fields.
 */
function fishParameters(escalationModes) {
  return {
    ...PARAMETERS,
    properties: {
      ...PARAMETERS.properties,
      run_in_background: {
        type: 'boolean',
        description: 'Run in the background and return a job id immediately '
          + '(collect with job_output, stop with job_kill). No timeout applies.',
      },
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string',
          enum: [...escalationModes],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot '
            + 'retry of a command the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string',
          description: 'Required with sandbox_permissions: one sentence for the user explaining '
            + 'why this exact command needs the wider access.',
        },
      } : {},
    },
  }
}

/** Canonical output declaration: a background acknowledgment or a foreground
 * run. The rc.1 ToolRuntime dialect forbids `type`/`additionalProperties`
 * beside a `oneOf` root (exact-one branches), so the union is expressed as a
 * bare `oneOf` with each branch carrying its own object shape.
 * @type {import('@deepseek-ai/dsh-tools').JsonSchemaNode} */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'background' },
        jobId: { type: 'string' },
      },
      required: ['kind', 'jobId'],
    },
    {
      type: 'object',
      additionalProperties: false,
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
          properties: {
            text: { type: 'string' },
            truncated: { type: 'boolean' },
            spillPath: { type: 'string' },
          },
          required: ['text', 'truncated'],
        },
        stderr: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            truncated: { type: 'boolean' },
            spillPath: { type: 'string' },
          },
          required: ['text', 'truncated'],
        },
        sandbox: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string' },
            denied: { type: 'boolean' },
            enforcement: { type: 'string' },
            runnerFailed: { type: 'boolean' },
          },
          required: ['mode', 'denied'],
        },
      },
      required: ['kind', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
    },
  ],
}

/**
 * Resolve an explicit workdir: the sandbox policy's workspace root wins as
 * the base, then the session cwd; a relative path resolves against it.
 * @param {string | undefined} modelWorkdir - the model's `workdir` argument.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - the tool execution.
 * @param {string | undefined} policyWorkspaceRoot - the standing policy's workspace root.
 * @returns {string | undefined} the workdir for this call, or `undefined` to let the executor default it.
 */
function resolveWorkdir(modelWorkdir, exec, policyWorkspaceRoot) {
  const sessionCwd = policyWorkspaceRoot ?? exec?.agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolve(sessionCwd, modelWorkdir)
  }
  return modelWorkdir
}

/**
 * Cordis plugin entry: register the `fish` tool once the tool registry, the
 * `fish` executor, and the system-prompt registry are up. The per-agent fish
 * policy lives in the sibling `policy.js` module (mounted by the bundle
 * patch).
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 */
export function apply(ctx) {
  // Mirror dsh-tool-bash's policy path: when the mounted executor confines,
  // resolve each call's standing policy against the calling session so
  // /permission switches and the session workspace are honored, and fail loud
  // at load when the policy owner is missing.
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-fish: the mounted fish executor confines but ctx.sandboxPolicy is missing')
  }
  /**
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - the tool execution.
   * @returns {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy | undefined} the standing policy for this call's session, or `undefined` without a policy owner.
   */
  const resolveSandboxPolicy = (exec) => {
    if (sandboxPolicy === undefined) return undefined
    return sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  }

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to approveEscalation —
   * the same composition guard and ingredients as the official bash tool.
   * @param {string} mode - the requested `sandbox_permissions` value (the ladder check lives in `approveEscalation`).
   * @param {string} justification - the model's one-sentence reason, shown verbatim to the user.
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - the tool execution awaiting the decision.
   * @param {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy} standingPolicy - the call's standing policy (present whenever escalation is advertised).
   * @returns {Promise<import('@deepseek-ai/dsh-sandbox').SandboxMode>} the granted mode, consumed by this one call.
   */
  const approveFishEscalation = (mode, justification, exec, standingPolicy) => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    const effectiveMode = standingPolicy.mode
    return approveEscalation({
      requestedMode: mode,
      justification,
      effectiveMode,
      subject: 'command',
    }, {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: 'fish',
      signal: exec.signal,
    })
  }

  ctx.systemPrompt.section({
    name: 'tool:fish',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'Check the [exit code: N] marker on every fish result; investigate failures before moving on.',
  })

  /**
   * One `fish` tool call: validate the model's arguments, resolve the standing
   * policy and any same-turn escalation, then run through `ctx.shell`.
   * @param {FishToolArgs} args - the parsed call arguments (validated below).
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - the tool execution identity, agent, and cancellation.
   * @returns {Promise<{ kind: 'foreground' } & FishForegroundValue | { kind: 'background', jobId: string }>} the canonical value declared by OUTPUT_SCHEMA.
   */
  async function execute(args, exec) {
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      throw new Error('invalid command: expected a non-empty string')
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0) {
      throw new Error('invalid description: expected a non-empty string')
    }
    if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
      throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
    }
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    const standingPolicy = resolveSandboxPolicy(exec)
    const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
      // `escalationModes` is non-empty exactly when a policy owner is mounted,
      // so an escalation request always has a standing policy to widen.
      ? await approveFishEscalation(args.sandbox_permissions, args.justification, exec, /** @type {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy} */ (standingPolicy))
      : undefined
    // A one-shot escalation widens the standing policy for this call only.
    // `apply` fails loud when a confining executor has no policy owner, so an
    // approved mode implies a definite standing policy — the second guard makes
    // that explicit for the spread instead of spreading a possible `undefined`.
    const policy = approvedMode !== undefined && standingPolicy !== undefined
      ? { ...standingPolicy, mode: approvedMode }
      : standingPolicy
    const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
    const request = {
      command: args.command,
      ...workdir !== undefined ? { workdir } : {},
      ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      dshEnv: ctx.shellEnv.collect(exec),
      ...policy !== undefined ? { sandboxPolicy: policy } : {},
    }
    if (args.run_in_background === true) {
      const jobs = ctx.get('jobs')
      if (jobs === undefined) {
        throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      }
      if (exec.signal.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      /** @type {import('@deepseek-ai/dsh-shell').ShellExecution | undefined} */
      let proc
      return {
        kind: 'background',
        jobId: jobs.start({
          kind: 'fish',
          label: args.command,
          // The registry fences access by SESSION id: `owner` is the owning
          // session, not the live agent object (`JobSpec.owner?: SessionId`).
          ...exec.agent !== undefined ? { owner: exec.agent.id } : {},
          // The registry pumps output itself (0.1.7-rc.2 removed the
          // `JobHooks.readOutput` consumer), so the process's streams are
          // passed as pull sources bound to the handle published below.
          output: processSources(() => proc),
          run: () => processJob(async (signal) => {
            // Background work carries NO deadline: 0.1.5's `start()` armed no
            // timer at all (`startArgv` spawned with the caller's signal while
            // only `runArgv` built a `deadline(...)`), and the official
            // 0.1.7 `dsh-tool-bash` resolves its job lane the same way.
            // Without `onExpiry: 'none'` the resolved spec would default to
            // `'kill'` and silently reintroduce a timeout the documented
            // contract ("No timeout applies") never had.
            const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
            proc = await ctx.shell.execute({ ...spec, signal })
            return proc
          }, (started) => processOutcome(started, escalationModes)),
        }),
      }
    }
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      ...request,
      signal: exec?.signal,
    }))).result()
    if (result.aborted) {
      const error = new HarnessError('tool call aborted', TOOL_ABORTED)
      error.name = 'AbortError'
      throw error
    }
    return {
      kind: 'foreground',
      ...canonicalFishResult(result),
    }
  }

  ctx.tools.register({
    name: 'fish',
    description: fishDescription(escalationModes),
    parameters: fishParameters(escalationModes),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        // The canonical value crosses the lossless-JSON boundary, so it
        // arrives as `JsonValue`; OUTPUT_SCHEMA is what guarantees the shape.
        const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
        return [{
          type: 'text',
          text: record.kind === 'background'
            ? `started background job ${String(record.jobId)}`
            : renderResult(/** @type {FishForegroundValue} */ (value), escalationModes),
        }]
      },
    },
    execute,
    presentCall: presentFishCall,
    presentResult: presentFishResult,
  })
}

// Deterministic test surface: the tool description, the result renderers, and
// the UI presenters are pure, so unit tests can assert the bash→fish
// guidance, the syntax-hint injection, and the escalation-aware rendering
// without booting a harness or running a live shell.
export { FISH_SYNTAX_HINTS, TOOL_DESCRIPTION, fishDescription, fishSyntaxHint, presentFishCall, presentFishResult, renderResult }
