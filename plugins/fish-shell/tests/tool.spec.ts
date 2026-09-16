/**
 * Deterministic unit tests for the `@banbolee/dsh-fish-shell` model-facing fish tool:
 * the bash→fish guidance in TOOL_DESCRIPTION (A), the [fish syntax] hint
 * injected into failed results (B), the escalation-aware result rendering and
 * UI presentation (C), and the full tool lifecycle on a REAL Cordis context
 * with REAL SystemPrompt/ToolRuntime services and fake executor/jobs/approval
 * providers (D) — no harness boot, no live fish shell.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as tool from '../tool.js'
import {
  FISH_SYNTAX_HINTS,
  TOOL_DESCRIPTION,
  fishDescription,
  fishSyntaxHint,
  presentFishCall,
  presentFishResult,
  renderResult,
} from '../tool.js'

function stream(text: string, truncated = false) {
  return { text, truncated }
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30000,
    stdout: stream(''),
    stderr: stream(''),
    ...overrides,
  }
}

describe('@banbolee/dsh-fish-shell tool description (A)', () => {
  it('opens by telling the model this is FISH, not bash', () => {
    expect(TOOL_DESCRIPTION).toContain('FISH shell, NOT bash')
  })

  it('teaches the four highest-frequency bash→fish fixes with concrete forms', () => {
    // Variable assignment (14x in the 12h sample)
    expect(TOOL_DESCRIPTION).toContain('`set VAR x`')
    expect(TOOL_DESCRIPTION).toContain('`set -gx VAR x`')
    // for...do...done → for...end (3x)
    expect(TOOL_DESCRIPTION).toContain('`for i in ...; ...; end`')
    // if...then...fi → if test...end (5x)
    expect(TOOL_DESCRIPTION).toContain('`if test c; ...; end`')
    // heredoc has no fish equivalent (10x)
    expect(TOOL_DESCRIPTION).toContain('fish has no heredoc')
  })

  it('points failed calls at the per-result [fish syntax] hint', () => {
    expect(TOOL_DESCRIPTION).toContain('[fish syntax] hint')
  })

  it('advertises background execution and job control', () => {
    expect(TOOL_DESCRIPTION).toContain('run_in_background')
    expect(TOOL_DESCRIPTION).toContain('job_output')
    expect(TOOL_DESCRIPTION).toContain('job_kill')
  })

  it('advertises the same-turn sandbox escalation with justification when sandboxing is available', () => {
    expect(TOOL_DESCRIPTION).toContain('sandbox_permissions')
    expect(TOOL_DESCRIPTION).toContain('justification')
    expect(TOOL_DESCRIPTION).toContain('approval prompt')
    expect(fishDescription(['workspace-write'])).toContain('sandbox_permissions')
  })

  it('does not mention unavailable escalation arguments in a non-sandbox composition', () => {
    expect(fishDescription([])).not.toContain('sandbox_permissions')
    expect(fishDescription([])).not.toContain('approval prompt')
    expect(fishDescription([])).toContain('FISH shell, NOT bash')
  })

  it('points at the managed DSH_* harness environment facts', () => {
    expect(TOOL_DESCRIPTION).toContain('$DSH_*')
  })

  it('never teaches a bash-result marker contract', () => {
    expect(TOOL_DESCRIPTION).not.toContain('bash result')
  })
})

describe('fishSyntaxHint (B)', () => {
  it('maps the exact fish diagnostic to the concrete fish form', () => {
    expect(fishSyntaxHint('fish: Unsupported use of \'=\'. In fish, please use \'set SDK x\'.'))
      .toContain('`set VAR x`')
    expect(fishSyntaxHint('fish: Expected a string, but found a redirection')).toContain('heredoc')
    expect(fishSyntaxHint('fish: Missing end to balance this for loop')).toContain('for x in')
    expect(fishSyntaxHint('fish: Missing end to balance this if statement')).toContain('if test')
    expect(fishSyntaxHint('fish: No matches for wildcard \'*.json\'. See `help wildcards-globbing`.'))
      .toContain('unmatched glob')
  })

  it('returns empty for a clean run or a non-fish failure', () => {
    expect(fishSyntaxHint('')).toBe('')
    expect(fishSyntaxHint('git: command not found')).toBe('')
    expect(fishSyntaxHint('Some app crashed')).toBe('')
  })

  it('keeps every hint short and actionable', () => {
    for (const { hint } of FISH_SYNTAX_HINTS) {
      expect(hint.length).toBeLessThan(200)
      expect(hint).toContain('fish')
    }
  })
})

describe('renderResult hint injection (B)', () => {
  it('appends a [fish syntax] hint when the run failed with a fish diagnostic', () => {
    const out = renderResult(result({
      exitCode: 127,
      stderr: stream("fish: Unsupported use of '='. In fish, please use 'set CMD x'.\n"),
    }))
    expect(out).toContain('[fish syntax]')
    expect(out).toContain('`set VAR x`')
    expect(out).toContain('[exit code: 127]')
  })

  it('leaves a successful run without any hint', () => {
    const out = renderResult(result({
      stdout: stream('hello\n'),
    }))
    expect(out).toContain('hello')
    expect(out).not.toContain('[fish syntax]')
    expect(out).not.toContain('[exit code:')
  })

  it('leaves a non-syntax failure (real error text) without a bogus hint', () => {
    const out = renderResult(result({
      exitCode: 1,
      stderr: stream('tsc: error TS2322: type mismatch\n'),
    }))
    expect(out).toContain('[exit code: 1]')
    expect(out).not.toContain('[fish syntax]')
  })

  it('preserves the normal marker contract for sandbox/timeout/signal', () => {
    const denied = renderResult(result({
      exitCode: 0,
      sandbox: { mode: 'read-only', denied: true },
    }))
    expect(denied).toContain('[sandbox: file access denied under read-only mode]')

    const timed = renderResult(result({ timedOut: true, timeoutMs: 5000 }))
    expect(timed).toContain('[timed out after 5000ms]')
  })

  it('appends the same-turn escalation hint after a denial when escalation modes are advertised', () => {
    const out = renderResult(result({
      exitCode: 0,
      sandbox: { mode: 'read-only', denied: true },
    }), ['workspace-write', 'danger-full-access'])
    expect(out).toContain('[sandbox: file access denied under read-only mode]')
    expect(out).toContain('[sandbox: escalation available — retry this exact command once with sandbox_permissions')
  })

  it('keeps the default escalationModes [] behavior identical to the legacy call shape', () => {
    const denied = renderResult(result({
      exitCode: 0,
      sandbox: { mode: 'read-only', denied: true },
    }))
    expect(denied).not.toContain('escalation available')
  })
})

describe('presentFishCall / presentFishResult (C)', () => {
  it('presents a foreground call as a terminal card with cwd', () => {
    expect(presentFishCall({ command: 'git status', description: 'Show working tree status', workdir: '/ws' }))
      .toEqual({ card: 'terminal', title: 'git status', description: 'Show working tree status', cwd: '/ws' })
    expect(presentFishCall({ command: 'ls', description: 'List files' })).toEqual({
      card: 'terminal',
      title: 'ls',
      description: 'List files',
    })
  })

  it('presents a background call as a generic execute card', () => {
    expect(presentFishCall({ command: 'sleep 30', description: 'Sleep 30s', run_in_background: true })).toEqual({
      card: 'generic',
      title: 'sleep 30',
      kind: 'execute',
      rawInput: 'sleep 30',
      content: [{ type: 'text', text: 'Sleep 30s' }],
    })
  })

  it('splits a completed foreground result into terminal output plus exit status', () => {
    const view = presentFishResult(
      { command: 'make', description: 'Build' },
      { content: [{ type: 'text', text: 'building...\n[exit code: 1]' }], isError: false },
    )
    expect(view).toEqual({ card: 'terminal', output: 'building...', exitCode: 1 })
  })

  it('keeps background acknowledgements and error results as generic fenced console text', () => {
    const background = presentFishResult(
      { command: 'sleep 30', description: 'Sleep', run_in_background: true },
      { content: [{ type: 'text', text: 'started background job fish-1' }], isError: false },
    )
    expect(background).toEqual({
      card: 'generic',
      content: [{ type: 'text', text: '```console\nstarted background job fish-1\n```' }],
    })
    const failed = presentFishResult(
      { command: 'nope', description: 'Run nope' },
      { content: [{ type: 'text', text: 'invalid command' }], isError: true },
    )
    expect(failed).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\ninvalid command\n```' }] })
  })

  it('is a total function over malformed replay args: returns undefined instead of throwing', () => {
    // Malformed args (old/malformed replays) fall back to the UI's generic
    // presentation rather than crashing or minting invalid titles.
    expect(presentFishCall(null)).toBeUndefined()
    expect(presentFishCall(undefined)).toBeUndefined()
    expect(presentFishCall('git status')).toBeUndefined()
    expect(presentFishCall([])).toBeUndefined()
    expect(presentFishCall({})).toBeUndefined()
    expect(presentFishCall({ command: 42, description: 'x' })).toBeUndefined()
    expect(presentFishCall({ command: 'ls', description: 42 })).toBeUndefined()
    expect(presentFishCall({ command: 'ls' })).toBeUndefined()

    expect(presentFishResult(null, { content: [{ type: 'text', text: 'x' }] })).toBeUndefined()
    expect(presentFishResult({ command: 42, description: 'x' }, { content: [{ type: 'text', text: 'x' }] })).toBeUndefined()
    expect(presentFishResult({ command: 'ls', description: 'x' }, null)).toBeUndefined()
    expect(presentFishResult({ command: 'ls', description: 'x' }, { content: 'oops' })).toBeUndefined()

    // Valid inputs keep returning the original cards.
    expect(presentFishCall({ command: 'ls', description: 'List files' })).toEqual({
      card: 'terminal',
      title: 'ls',
      description: 'List files',
    })
    expect(presentFishResult(
      { command: 'make', description: 'Build' },
      { content: [{ type: 'text', text: 'building...\n[exit code: 1]' }], isError: false },
    )).toEqual({ card: 'terminal', output: 'building...', exitCode: 1 })
  })
})

// --- Real-Cordis integration surface (D): mount REAL SystemPrompt +
// ToolRuntime on a REAL Context, provide fake shell/shellEnv/jobs/approval/
// sandboxPolicy, load this bundle's tool plugin, then drive
// ctx.tools.execute({ name: 'fish', ... }) exactly like the harness does.

interface FakeShell {
  sandboxMode: string | undefined
  resolve: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
}

function fakeShell(sandboxMode: string | undefined): FakeShell {
  const run = vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30000,
    stdout: { text: 'hello from fish\n', truncated: false },
    stderr: { text: '', truncated: false },
    ...(sandboxMode !== undefined
      ? { sandbox: { mode: sandboxMode, denied: false, enforcement: 'full' as const, runnerFailed: false } }
      : {}),
  }))
  return {
    sandboxMode,
    resolve: vi.fn((request: unknown) => request),
    run,
    start: vi.fn(),
  }
}

interface Mounted {
  ctx: Context
  shell: FakeShell
  shellEnv: { collect: ReturnType<typeof vi.fn> }
  jobs: { start: ReturnType<typeof vi.fn> }
  approval: { request: ReturnType<typeof vi.fn> }
  sandboxPolicy: { resolve: ReturnType<typeof vi.fn> }
}

async function mountTool(options: {
  sandboxMode?: string // undefined = headless (no sandboxing executor)
  withJobs?: boolean
  withApproval?: boolean
} = {}): Promise<Mounted> {
  const { withJobs = true, withApproval = true } = options
  // `in`-probe instead of a destructuring default so an explicit
  // `{ sandboxMode: undefined }` still means headless.
  const sandboxMode = 'sandboxMode' in options ? options.sandboxMode : 'workspace-write'
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const shell = fakeShell(sandboxMode)
  const shellEnv = { collect: vi.fn(() => ({})) }
  const jobs = { start: vi.fn(() => 'fish-1') }
  const approval = { request: vi.fn(async () => 'allowed-once') }
  const sandboxPolicy = { resolve: vi.fn(() => ({ mode: sandboxMode ?? 'workspace-write', workspaceRoot: '/ws' })) }
  ctx.provide('shell', shell as never)
  ctx.provide('shellEnv', shellEnv as never)
  ctx.provide('sandboxPolicy', sandboxPolicy as never)
  if (withJobs) ctx.provide('jobs', jobs as never)
  if (withApproval) ctx.provide('approval', approval as never)
  await ctx.plugin(tool)
  return { ctx, shell, shellEnv, jobs, approval, sandboxPolicy }
}

let callSeq = 0

function executeCall(ctx: Context, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    callId: `fish-spec-${++callSeq}`,
    name: 'fish',
    arguments: args,
    signal: new AbortController().signal,
    ...extra,
  } as never)
}

describe('fish tool integration on real Cordis services (D)', () => {
  it('a. returns the canonical foreground result with full sandbox facts', async () => {
    const { ctx, shell } = await mountTool()

    const outcome = await executeCall(ctx, { command: 'echo hi', description: 'Echo hi', workdir: '/ws' })

    expect(outcome.isError).toBe(false)
    expect(outcome.value).toMatchObject({
      kind: 'foreground',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: { text: 'hello from fish\n', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full', runnerFailed: false },
    })
    const spec = shell.run.mock.calls[0]?.[0]
    expect(shell.run).toHaveBeenCalledTimes(1)
    expect(spec?.command).toBe('echo hi')
    expect(spec?.workdir).toBe('/ws')
    expect(spec?.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: '/ws' })
    expect(spec?.dshEnv).toEqual({})
  })

  it('b. starts a background job through ctx.jobs and wires cancel/done/readOutput', async () => {
    const { ctx, shell, jobs } = await mountTool()
    const agent = { id: 'a1', session: { id: 's1' } }

    const outcome = await executeCall(
      ctx,
      { command: 'sleep 30', description: 'Sleep 30s', run_in_background: true },
      { agent },
    )

    expect(outcome.isError).toBe(false)
    expect(outcome.value).toEqual({ kind: 'background', jobId: 'fish-1' })
    expect(jobs.start).toHaveBeenCalledTimes(1)
    const spec = jobs.start.mock.calls[0]?.[0]
    expect(spec?.kind).toBe('fish')
    expect(spec?.label).toBe('sleep 30')
    expect(spec?.owner).toBe(agent)
    expect(typeof spec?.run).toBe('function')
    // The starter is lazy: nothing spawns until the job controller calls run().
    expect(shell.start).not.toHaveBeenCalled()

    const proc = {
      kill: vi.fn(() => true),
      done: Promise.resolve(),
      readOutput: vi.fn(() => ({ delta: 'out\n', lossy: false })),
      sandbox: undefined,
    }
    shell.start.mockReturnValue(proc)
    const hooks = spec.run()
    expect(shell.start).toHaveBeenCalledTimes(1)
    expect(shell.start.mock.calls[0]?.[0]?.command).toBe('sleep 30')
    expect(typeof hooks.cancel).toBe('function')
    expect(typeof hooks.done.then).toBe('function')
    expect(hooks.readOutput()).toBe('out\n')
    hooks.cancel()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('c. fails loud with the jobs error when ctx.jobs is missing', async () => {
    const { ctx } = await mountTool({ withJobs: false })

    const outcome = await executeCall(ctx, { command: 'sleep 30', description: 'Sleep', run_in_background: true })

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content))
      .toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
    expect(outcome.value).toBeUndefined()
  })

  it('d. routes sandbox_permissions through the approval service and runs under the approved mode', async () => {
    const { ctx, shell, approval } = await mountTool()
    const agent = { id: 'a1', session: { id: 's1' } }

    const outcome = await executeCall(ctx, {
      command: 'touch /etc/motd',
      description: 'Write system banner',
      sandbox_permissions: 'danger-full-access',
      justification: 'need to write a system config',
    }, { agent })

    expect(outcome.isError).toBe(false)
    expect(approval.request).toHaveBeenCalledTimes(1)
    const ask = approval.request.mock.calls[0]?.[0]
    expect(ask?.toolName).toBe('fish')
    expect(ask?.agent).toBe(agent)
    expect(ask?.reason).toContain('danger-full-access')
    expect(ask?.reason).toContain('need to write a system config')
    const spec = shell.run.mock.calls[0]?.[0]
    expect(spec?.sandboxPolicy.mode).toBe('danger-full-access')
  })

  it('e. headless composition (no sandboxMode) exposes no escalation parameters or escalation prose', async () => {
    const { ctx } = await mountTool({ sandboxMode: undefined })

    const schemas = ctx.tools.schemas() as unknown as Array<{ name: string; description: string; parameters: { properties: Record<string, unknown> } }>
    const fish = schemas.find((schema) => schema.name === 'fish')
    expect(fish).toBeDefined()
    expect(fish?.description).not.toContain('sandbox_permissions')
    expect(fish?.description).not.toContain('approval prompt')
    expect(fish?.parameters.properties.run_in_background).toBeDefined()
    expect(fish?.parameters.properties.sandbox_permissions).toBeUndefined()
    expect(fish?.parameters.properties.justification).toBeUndefined()
  })

  it('registers the tool:fish prompt section with fish-result guidance', async () => {
    const { ctx } = await mountTool()

    const assembly = (await ctx.systemPrompt.assemble({})) as unknown as {
      sections: Array<{ name: string; text: string }>
    }
    const section = assembly.sections.find((entry) => entry.name === 'tool:fish')
    expect(section).toBeDefined()
    expect(section?.text).toContain('fish result')
    expect(section?.text).not.toContain('bash result')
  })
})
