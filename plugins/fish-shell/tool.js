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
 * swapped to fish: background execution through `ctx.jobs` (with lossy-read
 * and sandbox notices), same-turn sandbox escalation through
 * `ctx.approval` (strictly-wider modes only, fail-closed), canonical
 * foreground results carrying the complete sandbox facts
 * (`enforcement`/`runnerFailed`), terminal/generic UI presentation, and the
 * `tool:fish` exit-code prompt section. On top of that it keeps this
 * bundle's fish-specific teaching: the description translates bash idioms,
 * and failed runs carry a `[fish syntax]` hint naming the exact fix.
 *
 * @module @banbolee/dsh-fish-shell/tool
 */

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

/** Find a fish syntax hint for one stderr text, or '' when none applies. */
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
 * @param {object} result - the settled foreground result from the executor.
 * @param {readonly string[]} [escalationModes] - the escalation targets this
 *   composition advertises; non-empty appends the same-turn escalation hint
 *   after a denial marker (default `[]`: no hint).
 * @returns {string} the model-facing text.
 */
function renderResult(result, escalationModes = []) {
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
 * Shape one background-process read into the `job_output` delta the model
 * sees: the incremental delta, plus the lossy-read notice (with full-stream
 * spill paths) when in-memory truncation dropped unread bytes, and the
 * settled sandbox facts (runner failure / denial + escalation hint) when the
 * process was confined. Empty-delta rendering (`(no new output)`) is the
 * generic job controller's job.
 * @param {object} read - one incremental read from the process handle.
 * @param {object} [sandbox] - settled sandbox facts, when this was a confined process.
 * @param {readonly string[]} [escalationModes] - escalation targets advertised by this composition.
 * @returns {string} the delta text with any loss or sandbox notice appended.
 */
function renderFishProcessRead(read, sandbox, escalationModes = []) {
  const notices = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering.
 * @param {object} proc - the settled process handle.
 * @returns {{ status: 'completed' | 'killed', detail: string }} the outcome for the `ctx.jobs` registration.
 */
function processOutcome(proc) {
  if (proc.status === 'killed') {
    return {
      status: 'killed',
      detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit',
    }
  }
  return {
    status: 'completed',
    detail: `exit code: ${proc.exitCode ?? 0}`,
  }
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalFishResult(result) {
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
 * bare `oneOf` with each branch carrying its own object shape. */
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

/** Resolve an explicit workdir: the sandbox policy's workspace root wins as
 * the base, then the session cwd; a relative path resolves against it. */
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
  const resolveSandboxPolicy = (exec) => {
    if (sandboxPolicy === undefined) return undefined
    return sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  }

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to approveEscalation —
   * the same composition guard and ingredients as the official bash tool.
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
      ? await approveFishEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
      : undefined
    const policy = approvedMode === undefined ? standingPolicy : {
      ...standingPolicy,
      mode: approvedMode,
    }
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
      return {
        kind: 'background',
        jobId: jobs.start({
          kind: 'fish',
          label: args.command,
          ...exec.agent !== undefined ? { owner: exec.agent } : {},
          run: () => {
            const proc = ctx.shell.start(ctx.shell.resolve(request))
            return {
              cancel: () => void proc.kill(),
              done: proc.done.then(() => processOutcome(proc)),
              readOutput: () => renderFishProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
            }
          },
        }),
      }
    }
    const result = await ctx.shell.run(ctx.shell.resolve({
      ...request,
      signal: exec?.signal,
    }))
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
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background' ? `started background job ${value.jobId}` : renderResult(value, escalationModes),
      }],
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
