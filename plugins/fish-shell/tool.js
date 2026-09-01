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
 * The tool description teaches fish syntax because models default to bash
 * idioms; without it, every `export`/`$(...)`/`if then fi` would fail under
 * fish.
 *
 * @module dsh-fish-shell/tool
 */

import { isAbsolute, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'fish-tool'
export const inject = ['tools', 'shell', 'shellEnv']

/**
 * Bundled fish agent preset: a copy of the shipped `standard` preset with
 * the shell section removed (the `fish` tool is mounted host-globally by
 * this plugin, so the preset needs no shell row).
 */
const BUNDLED_PRESET_URL = new URL('./presets/fish/agent.cordis.yml', import.meta.url)

/**
 * Install the bundled fish agent preset under the agent-presets user root,
 * create-only: an existing target (even a user-edited one) is left alone,
 * and a failed write is a warning, never a load failure.
 */
function installPreset() {
  const home = resolveDshHome()
  const targetDir = `${home}/.agent-presets/fish`
  const target = `${targetDir}/agent.cordis.yml`
  let exists = true
  try {
    readFileSync(target)
  } catch {
    exists = false
  }
  if (exists) return
  try {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(target, readFileSync(BUNDLED_PRESET_URL, 'utf8'))
  } catch (error) {
    console.warn('dsh-fish-shell: could not install the fish agent preset:', String(error))
  }
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
- Commands may run under a file sandbox; a blocked file operation is reported as \`[sandbox: file access denied under <mode> mode]\`.
- Non-zero exits are reported as \`[exit code: N]\`. Long output is truncated to its tail.
Bash idioms fish REJECTS with exit 127 — translate before running:
  \`VAR=x\` / \`export VAR=x\`      → \`set VAR x\` / \`set -gx VAR x\`
  \`for i in ...; do ...; done\`    → \`for i in ...; ...; end\`
  \`if [ c ]; then ...; fi\`        → \`if test c; ...; end\`
  \`cmd <<'EOF' ... EOF\` (heredoc) → \`printf '...' | cmd\` (fish has no heredoc)
If fish rejects your command, retry with the fish form from the table — failed results carry a [fish syntax] hint naming the exact fix.`

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
 * identically.
 * @param {object} result - the settled foreground result from the executor.
 * @returns {string} the model-facing text.
 */
function renderResult(result) {
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
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
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

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
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
          spillPath: { type: 'string' },
        },
      },
      stderr: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'truncated'],
        properties: {
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          spillPath: { type: 'string' },
        },
      },
      sandbox: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'denied'],
        properties: {
          mode: { type: 'string' },
          denied: { type: 'boolean' },
        },
      },
    },
  },
  render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
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
 * Cordis plugin entry: install the bundled fish agent preset (an idempotent
 * user-root fallback for surfaces whose roster row this bundle does not
 * patch), then register the `fish` tool once the tool registry and the
 * `fish` executor are up.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 */
export function apply(ctx) {
  installPreset()

  // Mirror dsh-tool-bash's policy path: when the mounted executor confines,
  // resolve each call's standing policy against the calling session so
  // /permission switches and the session workspace are honored, and fail loud
  // at load when the policy owner is missing.
  const defaultMode = ctx.shell.sandboxMode
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-fish: the mounted fish executor confines but ctx.sandboxPolicy is missing')
  }
  const resolveSandboxPolicy = (exec) => {
    if (sandboxPolicy === undefined) return undefined
    return sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  }

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
    const standingPolicy = resolveSandboxPolicy(exec)
    const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
    const request = {
      command: args.command,
      ...workdir !== undefined ? { workdir } : {},
      ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      dshEnv: ctx.shellEnv.collect(exec),
      ...standingPolicy !== undefined ? { sandboxPolicy: standingPolicy } : {},
    }
    const result = await ctx.shell.run(ctx.shell.resolve({
      ...request,
      signal: exec?.signal,
    }))
    if (result.aborted) {
      const error = new Error('tool call aborted')
      error.name = 'AbortError'
      throw error
    }
    const stream = (s) => ({
      text: s.text,
      truncated: s.truncated,
      ...s.spillPath !== undefined ? { spillPath: s.spillPath } : {},
    })
    return {
      kind: 'foreground',
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs: result.timeoutMs,
      stdout: stream(result.stdout),
      stderr: stream(result.stderr),
      ...result.sandbox !== undefined
        ? { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied } }
        : {},
    }
  }

  ctx.tools.register({
    name: 'fish',
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    execute,
  })
}

// Deterministic test surface: the tool description and the result renderer are
// pure, so unit tests can assert the bash→fish guidance and the syntax-hint
// injection without booting a harness or running a live shell.
export { FISH_SYNTAX_HINTS, TOOL_DESCRIPTION, fishSyntaxHint, renderResult }
