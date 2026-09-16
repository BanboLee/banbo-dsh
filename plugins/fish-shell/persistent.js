/**
 * Model-facing persistent `fish` tool over the owner-scoped PTY seam, for
 * agent presets whose standing bash is the PERSISTENT form (`minimal`).
 *
 * This module is a fish translation of the official
 * `@deepseek-ai/dsh-tool-bash-persistent` pattern: a per-owner cached PTY
 * session, serialized command execution, marker-wrapped commands, scrollback
 * reads, deadline/timeout reset, and the shell-reset notice. Differences
 * from the official bash version are all fish dialect:
 *
 *   - `quoteForFish` uses fish single-quote escaping (`\\` and `\'` are the
 *     only escapes inside fish single quotes) — fish 4.0.0 has NO bash-style
 *     `$'...'` ANSI-C quoting, so the official `$'...'` wrapper cannot be
 *     reused (verified against real fish 4.0.0).
 *   - `wrapCommand` feeds the command to `eval` as ONE quoted string
 *     argument: fish 4's `eval` takes a command string (it no longer has an
 *     option terminator, so `eval --` fails).
 *   - The status is captured with `set __dsh_status $status` (fish's
 *     `$status`, not bash's `$?`).
 *
 * PTY self-management: the official persistent bash tool talks to the
 * `terminals` registry (`ctx.terminals.spawn/startSend/read/list/kill`),
 * which only exists inside the `minimal` preset's entry-local realm — it is
 * invisible at the host/agent plane, so an agent-scope tool cannot resolve
 * it. This module therefore manages its own sessions WITHOUT the registry,
 * mirroring the official semantics exactly:
 *
 *   - One `FishTerminalBackend` instance (`./terminal-fish.js`) is created
 *     per registration and shared by all owners, exactly like one registry
 *     backend is shared by all owners.
 *   - Spawn is `backend.spawn({ owner, sessionId: <uuid>, cwd,
 *     signal })`; the returned session replaces the registry snapshot id
 *     everywhere (`session.startSend(...).done` instead of
 *     `ctx.terminals.startSend(owner, id, ...)`, `session.read(...)`,
 *     `session.status()`).
 *   - The registry's `kill(owner, id, reason)` is exactly
 *     `session.close(reason)` (verified against
 *     `@deepseek-ai/dsh-terminal`'s registry), so reset/close map to
 *     `session.close`.
 *   - The backend needs `sandboxPolicy` / `subprocess` resolvable from the
 *     policy plugin's ctx (true in dsh-base/TUI host planes and in the
 *     composition test profiles) plus the sandbox provider via `ctx.get
 *     ('sandbox')` for confined modes.
 *   - The sandbox-mode fence copy in `terminal-fish.js` is installed with an
 *     injectable owner-activity check (this module's own owner→session
 *     tracking) because there is no registry to ask; the open-during-change
 *     refusal semantics are unchanged.
 *
 * The module deliberately exports NO Cordis `apply`: it is a library invoked
 * by `policy.js` (`registerPersistentFish(ctx, agentCtx)`) when the policy
 * detects the persistent bash form at the agent boundary, registering the
 * persistent `fish` tool at the agent scope so it shadows the host-global
 * one-shot `fish` tool.
 *
 * @module @banbolee/dsh-fish-shell/persistent
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FishTerminalBackend, ensureSandboxModeFence, resolveConfig as resolveTerminalConfig } from './terminal-fish.js'

const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'
const LOST_PREFIX_MESSAGE = '<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n'
const SHELL_RESET_MESSAGE = 'The persistent fish shell was reset; the next fish call starts from the workspace with a fresh current directory and environment.'
const TIMEOUT_STATUS_MARKER = '[Command timed out]'
export const TIMEOUT_CODE = 'PERSISTENT_FISH_TIMEOUT'
/** Largest delay Node schedules without clamping it to one millisecond
 * (mirrors `@deepseek-ai/dsh-timeout`'s `MAX_TIMER_DELAY_MS`). */
export const MAX_TIMER_DELAY_MS = 2147483647
const MODULE_TAG = '@banbolee/dsh-fish-shell'
const SCROLLBACK_PAGE_LINES = 1e3
const POLL_INTERVAL_MS = 25
const DEFAULT_DESCRIPTION = 'Run commands in a persistent fish shell. State, including the current directory, exported variables, and defined functions, persists across calls for this agent. Use fish syntax: set x 5; echo $x; $status for the last exit code; function name; ...; end for functions.'

/**
 * Abort reason carrying this module's timeout code and elapsed deadline.
 * Mirrors `@deepseek-ai/dsh-timeout`'s `TimeoutReason` (the module is NOT a
 * peer dependency here: the minimal deadline implementation below is
 * self-contained).
 */
export class TimeoutReason extends Error {
  code
  timeoutMs
  name = 'TimeoutReason'
  constructor(code, timeoutMs) {
    super(`${code} after ${timeoutMs}ms`)
    this.code = code
    this.timeoutMs = timeoutMs
  }
}

/**
 * Fuse upstream cancellation with an identifiable timeout, without pulling
 * in `@deepseek-ai/dsh-timeout`. `timeoutMs <= 0` arms no timer.
 * @param upstream - caller cancellation, if any.
 * @param timeoutMs - deadline in milliseconds; `<= 0` means "no timeout".
 * @param code - timeout code stamped onto the {@link TimeoutReason}.
 * @returns the fused signal plus a disposer that clears the armed timer.
 */
export function deadline(upstream, timeoutMs, code) {
  if (timeoutMs <= 0) {
    return { signal: upstream ?? new AbortController().signal, dispose() {} }
  }
  // Node clamps delays above 2^31-1 to ~1ms with a TimeoutOverflowWarning;
  // reject such deadlines instead of aborting immediately.
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`deadline timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const timer = new AbortController()
  const id = setTimeout(() => {
    timer.abort(new TimeoutReason(code, timeoutMs))
  }, timeoutMs)
  return {
    signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
    dispose() {
      clearTimeout(id)
    },
  }
}

/**
 * Recover a timeout reason from a reason-bearing carrier.
 * @param x - an AbortSignal or any `{ reason }` carrier.
 * @param code - only a {@link TimeoutReason} with this exact code matches.
 * @returns the matching reason, else `undefined`.
 */
export function timeoutOf(x, code) {
  const reason = x?.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}

export function maybeTruncate(content, maxOutputChars, incomplete = false) {
  if (content.length <= maxOutputChars && !incomplete) return content
  return content.length <= maxOutputChars ? content + TRUNCATED_MESSAGE : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE
}

export function markers() {
  const nonce = randomUUID()
  return {
    start: `__DSH_PERSISTENT_FISH_START_${nonce}__`,
    end: `__DSH_PERSISTENT_FISH_END_${nonce}:`,
  }
}

/**
 * Quote a value as one fish single-quoted token. fish single-quoted strings
 * only escape `\\` and `\'`, so backslashes are doubled first, then quotes —
 * the decode is exact for arbitrary input (verified against fish 4.0.0).
 * @param value - the raw string to embed.
 * @returns a fish single-quoted literal.
 */
export function quoteForFish(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/**
 * Wrap a command so its output and exit status are delimited by unique
 * markers. fish 4's `eval` evaluates one command string (no `--`), and
 * `$status` must be captured before anything else runs.
 * @param command - the raw fish command text.
 * @param marker - the unique start/end marker pair.
 * @returns the wrapped command line submitted to the persistent shell.
 */
export function wrapCommand(command, marker) {
  return `printf '%s\\n' ${quoteForFish(marker.start)}; eval ${quoteForFish(command)}; set __dsh_status $status; printf '%s%s\\n' ${quoteForFish(marker.end)} "$__dsh_status"`
}

export function trimTrailingNewline(text) {
  return text.replace(/(?:\r?\n)+$/, '')
}

/**
 * Extract the marker-delimited command output from a scrollback snapshot.
 * @param snapshot - the retained scrollback.
 * @param marker - the unique start/end marker pair.
 * @returns the captured text, exit code, and whether the start was lost.
 */
export function commandOutput(snapshot, marker) {
  const text = snapshot.text
  const end = text.lastIndexOf(marker.end)
  const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1]
  if (status === undefined) return undefined
  const startMarker = text.lastIndexOf(marker.start, end)
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length
  return {
    text: trimTrailingNewline(text.slice(start, end).replace(/^\r?\n/, '')),
    incomplete: startMarker < 0,
    exitCode: Number(status),
  }
}

/**
 * Render the not-yet-complete output after a start marker, falling back to
 * the incremental send delta when the scrollback lost the start.
 */
export function partialOutput(snapshot, marker, fallback, fallbackTruncated = false) {
  const startMarker = snapshot.text.lastIndexOf(marker.start)
  if (startMarker >= 0) {
    return {
      text: trimTrailingNewline(snapshot.text.slice(startMarker + marker.start.length).replace(/^\r?\n/, '')),
      incomplete: false,
    }
  }
  const fallbackStart = fallback.lastIndexOf(marker.start)
  const afterStart = fallbackStart < 0 ? fallback : fallback.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, '')
  const fallbackEnd = afterStart.lastIndexOf(marker.end)
  return {
    text: trimTrailingNewline(fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)),
    incomplete: fallbackTruncated || fallbackStart < 0,
  }
}

export async function pause() {
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
}

export function nextScrollbackOffset(page, offset) {
  if (page.text.length === 0 || page.lineEnd <= offset) return undefined
  return page.lineEnd
}

export function retainedScrollback(session, latest = session.read({
  offset: 0,
  count: SCROLLBACK_PAGE_LINES,
})) {
  const pages = latest.text.length === 0 ? [] : [latest.text]
  let offset = latest.lineEnd
  let truncated = latest.truncated
  for (;;) {
    if (offset >= latest.totalLines) break
    const page = session.read({
      offset,
      count: SCROLLBACK_PAGE_LINES,
    })
    truncated ||= page.truncated
    if (page.text.length > 0) pages.unshift(page.text)
    const next = nextScrollbackOffset(page, offset)
    if (next === undefined || next >= page.totalLines) break
    offset = next
  }
  return {
    text: pages.join('\n'),
    truncated,
  }
}

export function renderCaptured(output, maxOutputChars) {
  const rendered = maybeTruncate(output.text, maxOutputChars, output.incomplete)
  return appendStatusMarker(output.incomplete && output.text.length > 0 ? LOST_PREFIX_MESSAGE + rendered : rendered, output.exitCode !== undefined ? `[Command finished with exit code ${output.exitCode}]` : undefined)
}

export function appendStatusMarker(content, marker) {
  if (marker === undefined) return content
  return content.length === 0 ? marker : `${content}\n${marker}`
}

export function renderShellExitStatus(content, exitCode, signal) {
  return appendStatusMarker(content, signal !== null ? `[shell killed by signal: ${signal}]` : exitCode !== null ? `[shell exited: code ${exitCode}]` : '[shell exited]')
}

/**
 * Render the exited-session result, reset the owner's shell, and carry the
 * notice that the next call starts fresh.
 */
async function respondToSessionExit(session, shells, owner, status, marker, fallback, fallbackTruncated, config) {
  const snapshot = retainedScrollback(session)
  await shells.reset(owner, 'persistent fish shell exited')
  return [renderShellExitStatus(renderCaptured(partialOutput(snapshot, marker, fallback, fallbackTruncated), config.maxOutputChars), status.exitCode, status.signal), SHELL_RESET_MESSAGE].filter((part) => part.length > 0).join('\n')
}

/**
 * Per-owner persistent fish PTY cache with lazy creation and reset, driving
 * one shared `FishTerminalBackend` directly (self-managed: no `terminals`
 * registry, which is invisible at the host/agent plane). The registry's
 * kill is `session.close(reason)`, so close/reset map straight to the
 * session; the sandbox-mode fence gets an injectable owner-activity check
 * backed by this module's own owner→session tracking.
 *
 * Owner lifecycle mirrors the official `@deepseek-ai/dsh-terminal` registry:
 * the owner-scoped cleanup effect is installed BEFORE the first spawn, each
 * creation carries a reservation (AbortController + settlement) merged into
 * the spawn/startup signal, and owner disposal aborts and awaits pending
 * creations before closing live sessions — so a spawn racing an owner
 * disposal cannot outlive its owner or register on a disposed context.
 *
 * A session being closed is tracked in a `closing` set until close actually
 * settles: it still counts as activity (the sandbox-mode fence keeps
 * refusing mode changes while the old PTY is being torn down), a failed
 * close keeps the session retryable instead of losing the handle, and a
 * re-entrant close awaits the in-flight one.
 *
 * @param ctx - the policy plugin's context (services resolved via `ctx.get`).
 * @param config - the resolved persistent configuration.
 * @param backend - the PTY backend (duck-typed: only `spawn(spec)` is read);
 *   defaults to a real `FishTerminalBackend` constructed against `ctx`
 *   (injectable so tests can fake spawn/close).
 */
export function persistentShells(ctx, config, backend = new FishTerminalBackend(ctx, resolveTerminalConfig({
  backendType: config.backendType,
  ...(config.shellPath !== undefined ? { shellPath: config.shellPath } : {}),
  ...(config.shellArgs !== undefined ? { shellArgs: config.shellArgs } : {}),
}), (spec) => ctx.get('subprocess').spawnTerminal(spec))) {
  const pending = new WeakMap()
  const live = new Map()
  const creating = new Set()
  /** Owner → in-flight close promise. A session stays here until its close
   * settles, so it still counts as activity while the PTY is being torn down
   * and a failed close leaves the session retryable (the `live` entry is
   * removed only on success). */
  const closing = new Map()
  /** Owner → Set of unpublished spawn reservations (official registry shape). */
  const pendingSpawns = new Map()
  const ownerCleanupInstalled = new WeakSet()
  const disposedOwners = new WeakSet()
  const lifecycle = new AbortController()
  const hasActivity = (owner) =>
    pending.get(owner) !== undefined
    || (pendingSpawns.get(owner)?.size ?? 0) > 0
    || live.has(owner)
    || closing.has(owner)

  /** Register the owner-scoped cleanup effect BEFORE the first spawn: on
   * owner disposal it aborts and awaits pending creations, then closes the
   * live session. Throws when the owner context is already disposed (no
   * registration happens on a disposed context). */
  const ensureOwnerCleanup = (owner) => {
    if (ownerCleanupInstalled.has(owner)) return
    if (disposedOwners.has(owner)) {
      throw new Error(`persistent fish owner ${owner.id ?? '(unnamed)'} is no longer live`)
    }
    try {
      owner.ctx.effect(() => async () => {
        disposedOwners.add(owner)
        ownerCleanupInstalled.delete(owner)
        await abortPendingSpawns(owner, 'persistent fish owner disposed')
        await reset(owner, 'persistent fish owner disposed')
      }, 'persistent fish owner cache cleanup')
    } catch (error) {
      // The owner fiber is already disposed (INACTIVE_EFFECT): fail the
      // creation instead of leaving an untracked spawn behind.
      disposedOwners.add(owner)
      throw new Error(`persistent fish owner ${owner.id ?? '(unnamed)'} is no longer live`)
    }
    ownerCleanupInstalled.add(owner)
  }

  /** One unpublished spawn reservation: an AbortController plus a settlement
   * the owner-cleanup path awaits, tracked owner→Set so `hasActivity` sees
   * creations before they are published. */
  const reserveSpawn = (owner) => {
    ensureOwnerCleanup(owner)
    const controller = new AbortController()
    const settlement = Promise.withResolvers()
    const pendingSpawn = { owner, controller, settled: settlement.promise }
    let owned = pendingSpawns.get(owner)
    if (owned === undefined) {
      owned = new Set()
      pendingSpawns.set(owner, owned)
    }
    owned.add(pendingSpawn)
    return {
      signal: controller.signal,
      release() {
        owned.delete(pendingSpawn)
        if (owned.size === 0) pendingSpawns.delete(owner)
        settlement.resolve()
      },
    }
  }

  /** Abort every pending creation of one owner and await its settlement
   * (idempotent with each creation's own `release`). */
  const abortPendingSpawns = async (owner, reason) => {
    const owned = pendingSpawns.get(owner)
    if (owned === undefined) return
    const pendingSpawnsSnapshot = [...owned]
    for (const pendingSpawn of pendingSpawnsSnapshot) pendingSpawn.controller.abort(reason)
    await Promise.allSettled(pendingSpawnsSnapshot.map((pendingSpawn) => pendingSpawn.settled))
    for (const pendingSpawn of pendingSpawnsSnapshot) pendingSpawn.release()
  }

  /** Close one session, keeping it in `closing` (still counted as activity)
   * until the close settles. On success the `live` entry is removed; on
   * failure the session stays retryable and the failure is recorded, then
   * rethrown so callers can retry. A second close of the same session awaits
   * the in-flight one instead of stacking another close. */
  const closeSession = async (owner, session, reason, onClosed) => {
    if (closing.has(owner)) return closing.get(owner)
    const promise = (async () => {
      try {
        await session.close(reason)
        onClosed?.()
      } catch (error) {
        console.warn(`${MODULE_TAG}: could not close persistent fish session for owner ${owner?.id ?? '(unnamed)'}:`, String(error))
        throw error
      } finally {
        closing.delete(owner)
      }
    })()
    closing.set(owner, promise)
    return promise
  }

  const dispose = ctx.effect(() => async () => {
    lifecycle.abort(new Error('persistent fish disposed during shell creation'))
    await Promise.allSettled([...creating])
    const owners = [...live.keys()]
    await Promise.allSettled(owners.map((owner) => reset(owner, 'persistent fish disposed')))
  }, 'persistent fish shell cleanup')
  const reset = async (owner, reason) => {
    pending.delete(owner)
    const session = live.get(owner)
    if (session === undefined) return
    await closeSession(owner, session, reason, () => live.delete(owner))
  }
  const get = (owner, signal) => {
    const existing = pending.get(owner)
    if (existing !== undefined) return existing
    // Owner-scoped lifecycle BEFORE the first spawn: a reservation aborts
    // this creation if the owner is disposed while it is in flight, and the
    // owner-cleanup effect waits for it to settle (official registry
    // semantics). A disposed owner fails fast instead of spawning.
    let reservation
    try {
      reservation = reserveSpawn(owner)
    } catch (error) {
      return Promise.reject(error)
    }
    const combinedSignal = AbortSignal.any([signal, lifecycle.signal, reservation.signal])
    const tracked = (async () => {
      try {
        const cwd = owner.session.header.cwd
        // Self-managed activity check for the sandbox-mode fence (no
        // terminals registry to ask); installed before the first spawn so
        // the backend's own fence call reuses this entry.
        ensureSandboxModeFence(ctx, owner, () => hasActivity(owner))
        const spawned = await backend.spawn({
          owner,
          sessionId: randomUUID(),
          ...(cwd === undefined ? {} : { cwd }),
          signal: combinedSignal,
        })
        live.set(owner, spawned)
        const result = await spawned.startSend({
          text: 'stty -echo',
          submit: true,
          signal: combinedSignal,
        }).done
        if (result.sessionStatus.kind === 'exited' || result.waitReason === 'timeout') throw new Error('persistent fish shell did not accept initialization')
        return spawned
      } catch (error) {
        await reset(owner, 'persistent fish initialization failed')
        throw error
      } finally {
        reservation.release()
      }
    })().finally(() => {
      creating.delete(tracked)
    })
    creating.add(tracked)
    pending.set(owner, tracked)
    return tracked
  }
  return { get, reset, dispose }
}

/**
 * Execute one wrapped command against the owner's persistent fish session,
 * reading the marker-delimited result from the scrollback.
 */
async function executeCommand(ctx, shells, owner, command, config, upstream) {
  const commandDeadline = deadline(upstream, config.timeoutMs, TIMEOUT_CODE)
  try {
    const session = await shells.get(owner, commandDeadline.signal)
    const marker = markers()
    const wrapped = wrapCommand(command, marker)
    let first = true
    let fallback = ''
    let fallbackTruncated = false
    for (;;) {
      const status = session.status()
      if (status.kind === 'exited') return await respondToSessionExit(session, shells, owner, status, marker, fallback, fallbackTruncated, config)
      let operation
      let result
      try {
        operation = session.startSend({
          text: first ? wrapped : '',
          submit: first,
          signal: commandDeadline.signal,
        })
        first = false
        result = await operation.done
      } catch (error) {
        await shells.reset(owner, 'persistent fish send failed')
        throw error
      }
      const incremental = operation.readOutput()
      fallback = incremental.delta.length > 0 ? fallback + incremental.delta : result.viewport
      fallbackTruncated ||= incremental.truncated || result.truncated
      const latest = session.read({
        offset: 0,
        count: SCROLLBACK_PAGE_LINES,
      })
      const timedOut = timeoutOf(commandDeadline.signal, TIMEOUT_CODE)
      if (timedOut !== undefined) {
        const partial = renderCaptured(partialOutput(retainedScrollback(session, latest), marker, fallback, fallbackTruncated), config.maxOutputChars)
        await shells.reset(owner, 'persistent fish command timed out')
        return [
          `Your command timed out after ${Math.round(timedOut.timeoutMs / 1e3)} seconds. Below is partial output:`,
          appendStatusMarker(partial, TIMEOUT_STATUS_MARKER),
          SHELL_RESET_MESSAGE,
        ].join('\n')
      }
      if (commandDeadline.signal.aborted) {
        await shells.reset(owner, 'persistent fish command aborted')
        commandDeadline.signal.throwIfAborted()
      }
      if (latest.text.includes(marker.end)) {
        const complete = commandOutput(retainedScrollback(session, latest), marker)
        if (complete !== undefined) return renderCaptured(complete, config.maxOutputChars)
      }
      if (result.sessionStatus.kind === 'exited') return await respondToSessionExit(session, shells, owner, result.sessionStatus, marker, fallback, fallbackTruncated, config)
      if (result.waitReason === 'stdin_read') return renderCaptured(partialOutput(retainedScrollback(session, latest), marker, fallback, fallbackTruncated), config.maxOutputChars)
      await pause()
    }
  } finally {
    commandDeadline.dispose()
  }
}

/**
 * Resolve the persistent tool configuration with defaults applied.
 * @param config - optional overrides (backend type, deadline, output cap,
 *   fish executable).
 * @returns the fully resolved configuration (validated).
 */
export function resolvePersistentConfig(config = {}) {
  const resolved = {
    backendType: config.backendType ?? 'fish',
    timeoutMs: config.timeoutMs ?? 3e5,
    maxOutputChars: config.maxOutputChars ?? 16e3,
    description: config.description ?? DEFAULT_DESCRIPTION,
    shellPath: config.shellPath,
    shellArgs: config.shellArgs,
  }
  validatePersistentConfig(resolved)
  return resolved
}

/**
 * Validate the resolved persistent configuration. `timeoutMs` is additionally
 * bounded by {@link MAX_TIMER_DELAY_MS}: a larger value would make Node clamp
 * the timer to ~1ms (TimeoutOverflowWarning) and abort almost immediately.
 * @param resolved - the fully resolved configuration.
 */
export function validatePersistentConfig(resolved) {
  if (resolved.backendType.trim().length === 0) throw new Error('persistent fish: backendType must be non-empty')
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`persistent fish: timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) throw new Error('persistent fish: maxOutputChars must be a positive safe integer')
  if (resolved.description.trim().length === 0) throw new Error('persistent fish: description must be non-empty')
}

/**
 * Register the model-facing persistent `fish` tool at the AGENT scope,
 * shadowing the host-global one-shot `fish` tool. Intended to be called by
 * `policy.js` from the agent boundary when the agent's standing bash tool is
 * the persistent form (`minimal` preset).
 * @param ctx - the host context carrying `sandboxPolicy` and `subprocess`
 *   (resolvable from the policy plugin ctx in dsh-base/TUI host planes and
 *   in the composition test profiles); `terminals` is deliberately NOT
 *   needed — sessions are self-managed through a `FishTerminalBackend`.
 * @param agentCtx - the agent's scoped context; the tool is registered here
 *   so the agent sees it (shadowing the host-global fish).
 * @param config - optional overrides (backend type, deadline, output cap,
 *   fish executable).
 * @returns the disposer; it unregisters the tool and returns a Promise that
 *   settles when the session cleanup has quiesced (policy.js awaits it
 *   out-of-band via `Promise.resolve(...).catch`).
 */
export function registerPersistentFish(ctx, agentCtx, config = {}) {
  const resolved = resolvePersistentConfig(config)

  const shells = persistentShells(ctx, resolved)
  const queues = new WeakMap()
  const serialized = async (owner, operation) => {
    const run = (queues.get(owner) ?? Promise.resolve()).then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(owner, tail)
    try {
      return await run
    } finally {
      if (queues.get(owner) === tail) queues.delete(owner)
    }
  }
  const unregisterTool = agentCtx.tools.register(defineTool({
    name: 'fish',
    description: resolved.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The fish command to run. State persists across calls: the current directory, exported variables, and defined functions. Relative paths are preferred.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const owner = exec.agent
      if (owner === undefined) throw new Error('fish requires an owning agent session')
      return serialized(owner, async () => {
        exec.signal.throwIfAborted()
        return executeCommand(ctx, shells, owner, args.command, resolved, exec.signal)
      })
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command,
    }),
  }))
  let disposed = false
  const dispose = () => {
    if (disposed) return undefined
    disposed = true
    unregisterTool()
    // Awaitable cleanup: the caller may wait for the PTY teardown to
    // quiesce, and failures are recorded instead of becoming unhandled.
    return Promise.resolve(shells.dispose()).catch((error) => {
      console.warn('persistent fish cleanup failed:', String(error))
    })
  }
  agentCtx.effect(() => dispose, 'persistent fish tool cleanup')
  return dispose
}
