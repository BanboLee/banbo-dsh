/**
 * TEMPORARY diagnostic — not a contract test, delete once the Linux-only
 * composition failure is understood.
 *
 * The composition job on the ubuntu runner fails in lsp-diagnostics.spec.ts in
 * the teardown path and nowhere else; the same file passes on macOS with the
 * same engine. Job logs need admin rights, so the only channel back is an
 * ANNOTATION — which is why this file exists: it deliberately fails with the
 * evidence in the message, so `check-runs/:id/annotations` carries it.
 *
 * It answers, in one run on the runner:
 *   - was the loader entry found at all;
 *   - how long did `entry.update({ disabled: true })` take (the spec asserts it
 *     should exceed 25 ms, and CI saw it finish under that);
 *   - what did the plugin's protocol log contain before and after;
 *   - did the fake server process still exist afterwards;
 *   - what does the loader entry look like on either side of the update.
 */

import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bootLspDiagnosticsProfile } from './lsp-diagnostics-profile'

const BUNDLE = '@banbolee/dsh-lsp-diagnostics'

const safeRead = (path: string): string => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '<missing>'
  } catch (error) {
    return `<unreadable: ${String((error as Error)?.message ?? error)}>`
  }
}

describe('DIAGNOSTIC — LSP teardown on this runner', () => {
  it('reports what actually happens when the bundle is unloaded', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'clean' })
    const report: Record<string, unknown> = {
      platform: process.platform,
      node: process.version,
      engine: process.env.DSH_DIAG_ENGINE ?? 'unknown',
    }
    try {
      const loader = (booted.ctx as any).get('loader')
      const entries = [...loader.entries()]
      const entry = entries.find((candidate: any) => candidate.options.name === BUNDLE)
      report.entryCount = entries.length
      report.entryNames = entries.map((candidate: any) => candidate.options.name)
      report.entryFound = entry !== undefined
      if (entry === undefined) {
        expect.fail(`DIAG ${JSON.stringify(report)}`)
      }
      report.before = {
        disabled: entry.disabled,
        rawDisabled: entry.options.disabled,
        hasFiber: entry.fiber !== undefined,
        uid: entry.fiber?.uid ?? null,
        state: entry.fiber?.state ?? null,
      }

      // Drive a real diagnosis so the plugin spawns its server, exactly as the
      // failing specs do: through the tools registry with a session cwd, which
      // is what makes the plugin's post-execute hook run at all.
      const tools = booted.ctx.get('tools') as unknown as {
        execute: (input: {
          callId: string
          name: string
          arguments: unknown
          agent?: unknown
          signal: AbortSignal
        }) => Promise<any>
      }
      report.hasToolsExecute = typeof tools.execute === 'function'
      try {
        const result = await tools.execute({
          callId: 'diag-write',
          name: 'write',
          arguments: { file_path: 'src/diag.ts', content: 'const diag: number = 1;\n' },
          agent: { session: { header: { cwd: booted.workspace } } },
          signal: new AbortController().signal,
        })
        report.writeResult = JSON.stringify(result).slice(0, 400)
      } catch (error) {
        report.writeError = String((error as Error)?.message ?? error)
      }
      report.logAfterWrite = safeRead(booted.typescriptLog)

      const started = Date.now()
      await entry.update({ disabled: true })
      report.updateMs = Date.now() - started
      report.after = {
        disabled: entry.disabled,
        rawDisabled: entry.options.disabled,
        hasFiber: entry.fiber !== undefined,
        uid: entry.fiber?.uid ?? null,
        state: entry.fiber?.state ?? null,
      }
      report.logAfterUnload = safeRead(booted.typescriptLog)
    } finally {
      const cleanupStarted = Date.now()
      try {
        await booted.cleanup()
        report.cleanupMs = Date.now() - cleanupStarted
        report.cleanupError = null
      } catch (error) {
        report.cleanupMs = Date.now() - cleanupStarted
        report.cleanupError = String((error as Error)?.message ?? error)
      }
      report.logAfterCleanup = safeRead(booted.typescriptLog)
    }
    expect.fail(`DIAG ${JSON.stringify(report, null, 1)}`)
  }, 120_000)
})
