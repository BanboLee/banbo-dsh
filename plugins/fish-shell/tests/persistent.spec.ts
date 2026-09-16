/**
 * Deterministic unit tests for the pure functions behind
 * `@banbolee/dsh-fish-shell/persistent` (`persistent.js`): fish quoting and
 * command wrapping, marker-based output extraction, status/truncation
 * rendering, and the self-implemented command deadline. No real shell or PTY
 * is executed here — the wrapper text these functions produce is validated
 * against real fish 4.0.0 by `persistent-real.spec.ts` (env-gated).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ensureSandboxModeFence } from '../terminal-fish.js'
import {
  MAX_TIMER_DELAY_MS,
  TIMEOUT_CODE,
  TimeoutReason,
  commandOutput,
  deadline,
  markers,
  maybeTruncate,
  partialOutput,
  persistentShells,
  quoteForFish,
  registerPersistentFish,
  renderCaptured,
  renderShellExitStatus,
  resolvePersistentConfig,
  timeoutOf,
  wrapCommand,
} from '../persistent.js'

/** Undo fish's single-quote decoding (the only escapes are `\\` and `\'`). */
function decodeFishQuote(encoded: string): string {
  expect(encoded.startsWith("'")).toBe(true)
  expect(encoded.endsWith("'")).toBe(true)
  const body = encoded.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    if (next === '\\' || next === "'") {
      out += next
      i += 1
    } else {
      out += ch
    }
  }
  return out
}

describe('quoteForFish', () => {
  it('wraps plain text in single quotes', () => {
    expect(quoteForFish('plain')).toBe("'plain'")
  })

  it('escapes single quotes and backslashes (the only fish single-quote escapes)', () => {
    expect(quoteForFish("it's")).toBe("'it\\'s'")
    expect(quoteForFish('a\\b')).toBe("'a\\\\b'")
  })

  it('round-trips arbitrary text through fish single-quote decoding', () => {
    const cases = [
      'plain',
      "it's a $test",
      'back\\slash and "double" quotes',
      'newline\ninside',
      'trailing backslash \\',
      "quote at end'",
      "\\' escaped quote pair",
      '$status $HOME $PWD unexpanded',
      "printf '%s\\n' a b",
      'semi;colon and (parens) and `tick`',
    ]
    for (const value of cases) {
      expect(decodeFishQuote(quoteForFish(value))).toBe(value)
    }
  })
})

describe('markers and wrapCommand', () => {
  it('produces unique start/end marker names around a nonce', () => {
    const first = markers()
    const second = markers()
    expect(first.start).toMatch(/^__DSH_PERSISTENT_FISH_START_[0-9a-f-]+__$/)
    expect(first.end).toMatch(/^__DSH_PERSISTENT_FISH_END_[0-9a-f-]+:$/)
    expect(first.start).not.toBe(second.start)
    expect(first.end).not.toBe(second.end)
  })

  it('wraps a command with quoted markers, eval, status capture, and the end printf', () => {
    const marker = { start: 'S1__', end: 'E1__:' }
    const wrapped = wrapCommand('set x 5; echo got-$x', marker)
    expect(wrapped).toBe(
      "printf '%s\\n' 'S1__'; eval 'set x 5; echo got-$x'; set __dsh_status $status; printf '%s%s\\n' 'E1__:' \"$__dsh_status\"",
    )
    // The end marker is printed BEFORE the status so commandOutput can split them.
    expect(wrapped).toContain(`printf '%s%s\\n' '${marker.end}' "$__dsh_status"`)
  })

  it('wraps commands containing single quotes and newlines losslessly', () => {
    const marker = { start: 'S2__', end: 'E2__:' }
    const command = "printf '%s\\n' \"it's\"\necho done"
    const wrapped = wrapCommand(command, marker)
    // The command is embedded as ONE quoted argument to eval (fish 4 eval
    // takes a single command string; it has no option terminator).
    expect(wrapped).toContain(`eval ${quoteForFish(command)}`)
    expect(wrapped).toContain(`; set __dsh_status $status; `)
  })
})

describe('commandOutput', () => {
  it('extracts the body and status between the markers', () => {
    const snapshot = { text: 'junk\nS1__\nhello\nworld\nE1__:0\n', truncated: false }
    expect(commandOutput(snapshot, { start: 'S1__', end: 'E1__:' })).toEqual({
      text: 'hello\nworld',
      incomplete: false,
      exitCode: 0,
    })
  })

  it('parses a nonzero status and CRLF output', () => {
    const snapshot = { text: 'S1__\r\nboom\r\nE1__:3\r\n', truncated: false }
    expect(commandOutput(snapshot, { start: 'S1__', end: 'E1__:' })).toEqual({
      text: 'boom',
      incomplete: false,
      exitCode: 3,
    })
  })

  it('reports incomplete when the start marker is missing but the end is present', () => {
    const snapshot = { text: 'E1__:0\n', truncated: false }
    const result = commandOutput(snapshot, { start: 'S1__', end: 'E1__:' })
    expect(result).not.toBeUndefined()
    expect(result?.incomplete).toBe(true)
    expect(result?.exitCode).toBe(0)
  })

  it('returns undefined when the end marker is absent', () => {
    const snapshot = { text: 'S1__\npartial\n', truncated: false }
    expect(commandOutput(snapshot, { start: 'S1__', end: 'E1__:' })).toBeUndefined()
  })

  it('picks the LAST start marker before the end (echoed input precedes real output)', () => {
    const snapshot = { text: 'echoed S1__ input\nS1__\nreal output\nE1__:0\n', truncated: false }
    expect(commandOutput(snapshot, { start: 'S1__', end: 'E1__:' })).toEqual({
      text: 'real output',
      incomplete: false,
      exitCode: 0,
    })
  })
})

describe('partialOutput', () => {
  it('returns everything after the last start marker', () => {
    const snapshot = { text: 'S1__\npartial\n', truncated: false }
    expect(partialOutput(snapshot, { start: 'S1__', end: 'E1__:' }, '')).toEqual({
      text: 'partial',
      incomplete: false,
    })
  })

  it('falls back to the incremental delta when the scrollback lost the start marker', () => {
    const snapshot = { text: 'tail only\n', truncated: false }
    const fallback = 'S1__\nfull early output\n'
    expect(partialOutput(snapshot, { start: 'S1__', end: 'E1__:' }, fallback)).toEqual({
      text: 'full early output',
      incomplete: false,
    })
  })

  it('marks the fallback incomplete when it is truncated and carries no start marker', () => {
    const snapshot = { text: '', truncated: false }
    expect(partialOutput(snapshot, { start: 'S1__', end: 'E1__:' }, 'no marker here', true)).toEqual({
      text: 'no marker here',
      incomplete: true,
    })
  })
})

describe('rendering', () => {
  it('appends the exit-status marker only when one is known', () => {
    expect(renderCaptured({ text: 'out', incomplete: false, exitCode: 2 }, 100)).toBe(
      'out\n[Command finished with exit code 2]',
    )
    expect(renderCaptured({ text: 'out', incomplete: false }, 100)).toBe('out')
    expect(renderCaptured({ text: '', incomplete: false, exitCode: 0 }, 100)).toBe(
      '[Command finished with exit code 0]',
    )
  })

  it('clips over-limit output with the truncated notice and keeps the exit marker', () => {
    const text = 'x'.repeat(50)
    const rendered = renderCaptured({ text, incomplete: false, exitCode: 1 }, 10)
    expect(rendered).toBe(`${'x'.repeat(10)}<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with \`grep -n\` in order to find the line numbers of what you are looking for.</NOTE>\n[Command finished with exit code 1]`)
  })

  it('prefixes the lost-output notice when the beginning was dropped and text remains', () => {
    const rendered = renderCaptured({ text: 'tail', incomplete: true, exitCode: 0 }, 100)
    expect(rendered.startsWith('<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n')).toBe(true)
  })

  it('renders exited-session statuses for signal, code, and unknown outcomes', () => {
    expect(renderShellExitStatus('out', 1, 'SIGTERM')).toBe('out\n[shell killed by signal: SIGTERM]')
    expect(renderShellExitStatus('out', 1, null)).toBe('out\n[shell exited: code 1]')
    expect(renderShellExitStatus('out', null, null)).toBe('out\n[shell exited]')
  })

  it('maybeTruncate passes through under-limit content untouched', () => {
    expect(maybeTruncate('short', 100, false)).toBe('short')
  })
})

describe('deadline and timeoutOf', () => {
  it('aborts with a recognizable TimeoutReason after the deadline elapses', async () => {
    const d = deadline(undefined, 25, TIMEOUT_CODE)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(d.signal.aborted).toBe(true)
    const reason = timeoutOf(d.signal, TIMEOUT_CODE)
    expect(reason).toBeInstanceOf(TimeoutReason)
    expect(reason?.code).toBe(TIMEOUT_CODE)
    expect(reason?.timeoutMs).toBe(25)
    d.dispose()
  })

  it('does not abort when disposed before the deadline', async () => {
    const d = deadline(undefined, 25, TIMEOUT_CODE)
    d.dispose()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(d.signal.aborted).toBe(false)
  })

  it('fuses upstream cancellation without stamping a timeout reason', async () => {
    const upstream = new AbortController()
    const d = deadline(upstream.signal, 1000, TIMEOUT_CODE)
    upstream.abort(new Error('upstream cancelled'))
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal, TIMEOUT_CODE)).toBeUndefined()
    d.dispose()
  })

  it('distinguishes a foreign timeout code from this deadline', async () => {
    const d = deadline(undefined, 25, TIMEOUT_CODE)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(timeoutOf(d.signal, 'OTHER_CODE')).toBeUndefined()
    expect(timeoutOf(d.signal, TIMEOUT_CODE)).toBeInstanceOf(TimeoutReason)
    d.dispose()
  })

  it('rejects a timeoutMs beyond the Node timer ceiling instead of clamping to ~1ms', () => {
    // Node clamps delays above 2^31-1 to ~1ms with a TimeoutOverflowWarning.
    expect(() => deadline(undefined, MAX_TIMER_DELAY_MS + 1, TIMEOUT_CODE)).toThrow(/no greater than/)
    expect(() => deadline(undefined, Infinity, TIMEOUT_CODE)).toThrow(/no greater than/)
    // The ceiling itself is legal (and immediately disarmed).
    const boundary = deadline(undefined, MAX_TIMER_DELAY_MS, TIMEOUT_CODE)
    expect(boundary.signal.aborted).toBe(false)
    boundary.dispose()
  })
})

describe('persistent fish config validation', () => {
  it('rejects an oversized timeoutMs in registerPersistentFish (Node would clamp it to ~1ms)', () => {
    // Validation runs before any context use, so bogus contexts suffice here.
    expect(() => registerPersistentFish(undefined as never, undefined as never, { timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must be a positive safe integer no greater than/)
  })

  it('accepts the timer-ceiling boundary timeoutMs', () => {
    expect(resolvePersistentConfig({ timeoutMs: MAX_TIMER_DELAY_MS }).timeoutMs).toBe(MAX_TIMER_DELAY_MS)
    expect(resolvePersistentConfig({}).timeoutMs).toBe(3e5)
  })
})

// --- persistentShells owner lifecycle (C): REAL Cordis contexts (no tools,
// no terminals registry — the self-managed requirement), a FAKE backend with
// controllable spawn/close, and the real sandbox-mode fence.

interface ShellOwner {
  id: string
  ctx: Context
  session: { header: { cwd: string } }
}

const SHELLS_CONFIG = {
  backendType: 'fish',
  timeoutMs: 3e5,
  maxOutputChars: 16e3,
  description: 'test',
  shellPath: 'fish',
  shellArgs: ['-i'],
}

async function composeShellHarness(): Promise<{
  root: Context
  owner: ShellOwner
  disposeOwner: () => Promise<void>
}> {
  const root = new Context()
  const host = await root.plugin({ name: 'persistent-shells-spec-host', inject: ['tools', 'systemPrompt'], apply() {} })
  root.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/ws' }),
  })
  root.provide('sessionProjections', { stateOf: () => undefined })
  const owner: ShellOwner = {
    id: 'persistent-shells-owner',
    ctx: undefined as unknown as Context,
    session: { header: { cwd: '/ws' } },
  }
  const scope = createScope(host.ctx, owner)
  owner.ctx = scope.ctx
  return { root, owner, disposeOwner: scope.dispose }
}

/** Fake session satisfying the surface `persistentShells.get`/`reset` use. */
function fakeSession(close: () => Promise<void>) {
  return {
    pid: 4242,
    status: () => ({ kind: 'running' as const }),
    read: () => ({ text: '', lineEnd: 0, totalLines: 0, truncated: false }),
    startSend: () => ({
      done: Promise.resolve({
        sessionStatus: { kind: 'running' as const },
        waitReason: undefined,
        viewport: '',
        truncated: false,
      }),
      readOutput: () => ({ delta: '', truncated: false }),
    }),
    close,
  }
}

/** Fire the harness's sandbox/mode dispatch the way the session loop does. */
function changeSandboxMode(owner: ShellOwner): void {
  ;(owner.ctx.emit as (event: string, ...args: unknown[]) => void)(
    'internal/dispatch',
    'native',
    'session/event',
    [owner.session, { type: 'sandbox/mode', data: { mode: 'read-only' } }],
  )
}

describe('persistentShells owner lifecycle', () => {
  it('keeps a session retryable after a failed close and counts it as activity until it truly closes', async () => {
    const { root, owner, disposeOwner } = await composeShellHarness()
    let closeAttempts = 0
    const session = fakeSession(async () => {
      closeAttempts += 1
      if (closeAttempts === 1) throw new Error('close failed')
    })
    const shells = persistentShells(root, SHELLS_CONFIG, { spawn: async () => session })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await shells.get(owner, new AbortController().signal)
      // An open session is visible to the sandbox-mode fence.
      expect(() => changeSandboxMode(owner)).toThrow(/cannot change sandbox mode/)

      // A failing close: the session is NOT dropped from tracking (the fence
      // stays closed), the failure is warned, and the handle is retryable.
      await expect(shells.reset(owner, 'test close')).rejects.toThrow('close failed')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(() => changeSandboxMode(owner)).toThrow(/cannot change sandbox mode/)

      // Retry succeeds against the same session handle.
      await shells.reset(owner, 'retry close')
      expect(closeAttempts).toBe(2)
      // Truly closed now: the fence opens.
      expect(() => changeSandboxMode(owner)).not.toThrow()
    } finally {
      warn.mockRestore()
      await disposeOwner()
      await root.fiber.dispose()
    }
  })

  it('aborts a creation whose owner is disposed mid-spawn and fails fast afterwards', async () => {
    const { root, owner, disposeOwner } = await composeShellHarness()
    const backend = {
      spawn: (spec: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        spec.signal.addEventListener('abort', () => reject(spec.signal.reason ?? new Error('spawn aborted')), { once: true })
      }),
    }
    const shells = persistentShells(root, SHELLS_CONFIG, backend)

    // Owner disposal while the spawn is still in flight: the owner-scoped
    // cleanup (installed BEFORE the first spawn) aborts the creation and
    // awaits its settlement.
    const creating = shells.get(owner, new AbortController().signal)
    await disposeOwner()
    await expect(creating).rejects.toThrow()

    // Nothing registered on the disposed owner context: the next get fails
    // fast with the owner-gone error instead of an INACTIVE_EFFECT throw.
    await expect(shells.get(owner, new AbortController().signal)).rejects.toThrow(/no longer live/)
    await root.fiber.dispose()
  })

  it('aggregates multiple managers\' activity checkers in the sandbox-mode fence', async () => {
    const { root, owner, disposeOwner } = await composeShellHarness()
    // First manager still has an open session (active checker).
    ensureSandboxModeFence(root, owner, () => true)
    // A second manager (rapid persistent→one-shot→persistent churn) installs
    // an idle checker; a single-slot overwrite would forget the first.
    ensureSandboxModeFence(root, owner, () => false)
    // The backend's own probe-style call (no checker) must not clobber either.
    ensureSandboxModeFence(root, owner)

    // ANY active manager keeps the fence closed.
    expect(() => changeSandboxMode(owner)).toThrow(/cannot change sandbox mode/)
    await disposeOwner()
    await root.fiber.dispose()
  })

  it('opens the sandbox-mode fence when every aggregated checker is idle', async () => {
    const { root, owner, disposeOwner } = await composeShellHarness()
    ensureSandboxModeFence(root, owner, () => false)
    ensureSandboxModeFence(root, owner, () => false)
    expect(() => changeSandboxMode(owner)).not.toThrow()
    await disposeOwner()
    await root.fiber.dispose()
  })
})
