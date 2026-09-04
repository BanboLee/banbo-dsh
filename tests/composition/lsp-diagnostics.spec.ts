import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootLspDiagnosticsProfile,
  loadAnchorModule,
  type FakeLspMode,
  type LspDiagnosticsBooted,
} from './lsp-diagnostics-profile'

/**
 * Real composition for `dsh-lsp-diagnostics` (test matrix 11-13 and the
 * composition-visible F5 claims):
 *
 *  11. real Loader/app/process install + namespace plugin load; actual official
 *      write/edit/str_replace_editor over .ts/.tsx/.go; unsupported / no-cwd /
 *      outside-workspace silence; `enabled=false` zero registration/process.
 *  12. actual PTC: real `run_code` nested write, outer result
 *      `additionalContexts`, no fake `parent`.
 *  13. durable delivery: real Agent loop + deterministic mock LLM two-step
 *      requests; session `user/message` and the second model request both carry
 *      the plugin notice.
 *
 * Plus composition-visible F5 claims: strict route, workspace silence, real
 * three-parameter post-execute waterfall (notice lands on the real tool
 * result), Diagnostic optionals/extensions compatibility and consumed-field
 * fatal, bounded read classification, fail-open boundaries, aggregate grammar,
 * and `enabled=false` zero runtime.
 */

const bootedProfiles: LspDiagnosticsBooted[] = []

afterEach(async () => {
  while (bootedProfiles.length > 0) {
    const booted = bootedProfiles.pop()
    if (booted !== undefined) await booted.cleanup()
  }
})

/** Execute one official tool through the real tools runtime with a session cwd. */
async function executeTool(
  booted: LspDiagnosticsBooted,
  name: string,
  args: Record<string, unknown>,
  cwd?: string,
): Promise<any> {
  const tools = booted.ctx.get('tools') as unknown as {
    execute(input: { callId: string; name: string; arguments: unknown; agent?: unknown; signal: AbortSignal }): Promise<any>
  }
  const result = await tools.execute({
    callId: `composition-${name}`,
    name,
    arguments: args,
    ...cwd === undefined ? {} : { agent: { session: { header: { cwd } } } },
    signal: new AbortController().signal,
  })
  if (result === undefined) throw new Error('missing tools runtime')
  return result
}

/**
 * Drive one multi-file mutation transaction through the booted plugin's real
 * fs/observed listeners and real three-argument post-execute waterfall. This is
 * intentionally not used for F5's official-tool or PTC claims; it isolates the
 * composition-level shared ordering/global-cap contract for one exec.
 */
async function executeMultiFileComposition(booted: LspDiagnosticsBooted): Promise<any> {
  const ctx = booted.ctx as any
  const signal = new AbortController().signal
  const exec = {
    name: 'write',
    arguments: {},
    agent: { session: { header: { cwd: booted.workspace } } },
    signal,
  }
  const files = [
    ['src/z.ts', 'const z: number = "oops";\n'],
    ['src/a.tsx', 'export const a: number = 1;\n'],
    ['src/m.go', 'package main\nfunc main() {}\n'],
  ] as const
  for (const [filePath, content] of files) {
    const target = await ctx.fs.resolve(filePath, { cwd: booted.workspace, signal })
    const outcome = await ctx.fs.writeText(target, content, undefined, signal)
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  }
  return ctx.waterfall('tools/post-execute', exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
}

/** Remove the live loader entry and await that plugin's async cleanup. */
async function unloadDiagnostics(booted: LspDiagnosticsBooted): Promise<void> {
  const loader = (booted.ctx as any).get('loader')
  const entry = [...loader.entries()].find((candidate: any) => candidate.options.name === 'dsh-lsp-diagnostics')
  if (entry === undefined) throw new Error('live dsh-lsp-diagnostics loader entry not found')
  await entry.update({ disabled: true })
}

/** Extract the plugin notice text from a tool result, or undefined. */
function pluginNoticeText(result: any): string | undefined {
  const contexts: any[] = result?.additionalContexts ?? []
  const notice = contexts.find((context: any) => context?.source?.kind === 'plugin' && context?.source?.plugin === 'dsh-lsp-diagnostics')
  if (notice === undefined) return undefined
  const text = notice?.content?.find((block: any) => block?.type === 'text')?.text
  return typeof text === 'string' ? text : undefined
}

function expectedSingleFileNotice(workspace: string, relativePath: string, lines: readonly string[]): string {
  const renderPath = join(workspace, relativePath)
  return [
    '[LSP diagnostics after write]',
    `File: ${renderPath}`,
    ...lines,
  ].join('\n')
}

/**
 * The `push-versioned` fixture mode falls through to the fake server's default
 * branch, which publishes the full two-diagnostic batch for the opened URI
 * (the warning sorts before the error by the shared per-file key).
 */
const TS_DIAGNOSTIC_LINES = [
  '- warning 1:1-1:4 source="typescript" code="TS6133" \'unused\' is declared but its value is never read.',
  '- error 13:5-13:10 source="typescript" code="TS2322" Type \'string\' is not assignable to type \'number\'.',
].join('\n')

const TS_ERROR_SUBSTRING = '- error 13:5-13:10 source="typescript" code="TS2322"'

describe('dsh-lsp-diagnostics real composition', () => {
  it('installs the bundle through the real loader and delivers a byte-exact diagnostics notice for an actual write', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'push-versioned' })
    bootedProfiles.push(booted)

    // Real dsh-app-boot Loader installed the bundle; the namespace plugin row is live.
    expect(booted.proof.loader).toBe('dsh-app-boot')
    expect(booted.proof.installedBundles).toContain('dsh-lsp-diagnostics')
    const loader = booted.ctx.get('loader') as unknown as { entries(): Iterable<{ disabled: boolean; options: { name: string } }> }
    const entries = [...loader.entries()]
    expect(entries.some((entry) => entry.options.name === 'dsh-lsp-diagnostics' && !entry.disabled)).toBe(true)
    // The official tools are registered in the real app.
    const tools = booted.ctx.get('tools') as unknown as { schemas(): Array<{ name: string }> }
    const names = tools.schemas().map((schema) => schema.name).sort()
    expect(names).toEqual(expect.arrayContaining(['write', 'edit', 'str_replace_editor']))

    const result = await executeTool(booted, 'write', {
      file_path: 'src/a.ts',
      content: 'const x: number = "oops";\n',
    }, booted.workspace)

    expect(result.isError).toBe(false)
    const notice = pluginNoticeText(result)
    expect(notice).toBe(expectedSingleFileNotice(booted.workspace, 'src/a.ts', [TS_DIAGNOSTIC_LINES, '', 'Fix these diagnostics before considering the change complete.']))
    // The real tools actually wrote the file inside the session workspace.
    expect(readFileSync(join(booted.workspace, 'src', 'a.ts'), 'utf8')).toBe('const x: number = "oops";\n')
  })

  it('reports diagnostics then clean after an actual edit fixes the same TypeScript file', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'content-aware' })
    bootedProfiles.push(booted)

    const error = await executeTool(booted, 'write', {
      file_path: 'src/a.ts',
      content: 'const x: number = "oops";\n',
    }, booted.workspace)
    expect(pluginNoticeText(error)).toContain(TS_ERROR_SUBSTRING)

    const fixed = await executeTool(booted, 'edit', {
      file_path: 'src/a.ts',
      old_string: 'const x: number = "oops";',
      new_string: 'const x: number = 2;',
    }, booted.workspace)

    expect(fixed.isError).toBe(false)
    expect(pluginNoticeText(fixed)).toBe(expectedSingleFileNotice(booted.workspace, 'src/a.ts', ['Status: clean']))
    expect(readFileSync(join(booted.workspace, 'src', 'a.ts'), 'utf8')).toBe('const x: number = 2;\n')
  })

  it('triggers on str_replace_editor create/str_replace/insert (tsx) but not on view', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'push-versioned' })
    bootedProfiles.push(booted)

    const create = await executeTool(booted, 'str_replace_editor', {
      command: 'create',
      path: join(booted.workspace, 'src', 'b.tsx'),
      file_text: 'export const b: number = "oops";\n',
    }, booted.workspace)
    expect(create.isError).toBe(false)
    expect(pluginNoticeText(create)).toBe(expectedSingleFileNotice(booted.workspace, 'src/b.tsx', [TS_DIAGNOSTIC_LINES, '', 'Fix these diagnostics before considering the change complete.']))

    const replace = await executeTool(booted, 'str_replace_editor', {
      command: 'str_replace',
      path: join(booted.workspace, 'src', 'b.tsx'),
      old_str: '"oops"',
      new_str: '7',
    }, booted.workspace)
    expect(replace.isError).toBe(false)
    expect(pluginNoticeText(replace)).toBe(expectedSingleFileNotice(booted.workspace, 'src/b.tsx', [TS_DIAGNOSTIC_LINES, '', 'Fix these diagnostics before considering the change complete.']))

    const insert = await executeTool(booted, 'str_replace_editor', {
      command: 'insert',
      path: join(booted.workspace, 'src', 'b.tsx'),
      insert_line: 0,
      new_str: '// header\n',
    }, booted.workspace)
    expect(insert.isError).toBe(false)
    expect(pluginNoticeText(insert)).toBe(expectedSingleFileNotice(booted.workspace, 'src/b.tsx', [TS_DIAGNOSTIC_LINES, '', 'Fix these diagnostics before considering the change complete.']))

    // `view` is a read command: no mutation candidate, so no plugin notice.
    const view = await executeTool(booted, 'str_replace_editor', {
      command: 'view',
      path: join(booted.workspace, 'src', 'b.tsx'),
    }, booted.workspace)
    expect(view.isError).toBe(false)
    expect(pluginNoticeText(view)).toBeUndefined()
  })

  it('diagnoses a Go error and reports clean after fixing the same file in the same session', async () => {
    const booted = await bootLspDiagnosticsProfile({ goMode: 'content-aware', typescriptMode: 'content-aware' })
    bootedProfiles.push(booted)
    const errorWrite = await executeTool(booted, 'write', {
      file_path: 'src/main.go',
      content: 'package main\nfunc main() { var x string = 1 }\n',
    }, booted.workspace)
    expect(errorWrite.isError).toBe(false)
    expect(pluginNoticeText(errorWrite)).toContain(TS_ERROR_SUBSTRING)

    const fix = await executeTool(booted, 'edit', {
      file_path: 'src/main.go',
      old_string: 'var x string = 1',
      new_string: 'var x int = 1',
    }, booted.workspace)
    expect(fix.isError).toBe(false)
    expect(pluginNoticeText(fix)).toBe(expectedSingleFileNotice(booted.workspace, 'src/main.go', ['Status: clean']))
    expect(readFileSync(join(booted.workspace, 'src', 'main.go'), 'utf8')).toContain('var x int = 1')
  })

  it('silently ignores unsupported extensions, missing session cwd, and outside-workspace targets', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'push-versioned' })
    bootedProfiles.push(booted)

    // Unsupported extension: no notice, tool still succeeds.
    const js = await executeTool(booted, 'write', { file_path: 'src/x.js', content: 'const x = 1;\n' }, booted.workspace)
    expect(js.isError).toBe(false)
    expect(pluginNoticeText(js)).toBeUndefined()

    // No session cwd: coordinator has no workspace root, so it stays silent.
    const noCwd = await executeTool(booted, 'write', { file_path: 'src/no-cwd.ts', content: 'const x: number = 1;\n' })
    expect(noCwd.isError).toBe(false)
    expect(pluginNoticeText(noCwd)).toBeUndefined()

    // Outside the session workspace: contains() is false, so it stays silent.
    const outside = await executeTool(booted, 'write', {
      file_path: join(booted.profile, 'outside', 'o.ts'),
      content: 'const o: number = 1;\n',
    }, booted.workspace)
    expect(outside.isError).toBe(false)
    expect(pluginNoticeText(outside)).toBeUndefined()
  })

  it('enabled=false registers no listeners and spawns no process', async () => {
    const booted = await bootLspDiagnosticsProfile({ enabled: false, typescriptMode: 'push-versioned' })
    bootedProfiles.push(booted)

    const result = await executeTool(booted, 'write', { file_path: 'src/a.ts', content: 'const x: number = "oops";\n' }, booted.workspace)
    expect(result.isError).toBe(false)
    expect(pluginNoticeText(result)).toBeUndefined()
    // No language-server process was ever spawned: the fake server never wrote its protocol log.
    expect(existsSync(booted.typescriptLog)).toBe(false)
    expect(existsSync(booted.goLog)).toBe(false)
  })

  it('ignores standard optional and unknown Diagnostic extensions while consumed-field invalidity is fatal', async () => {
    const optionals = await bootLspDiagnosticsProfile({ typescriptMode: 'diagnostic-standard-optionals' })
    bootedProfiles.push(optionals)
    const optionalsResult = await executeTool(optionals, 'write', { file_path: 'src/o.ts', content: 'const o: number = 1;\n' }, optionals.workspace)
    expect(optionalsResult.isError).toBe(false)
    expect(pluginNoticeText(optionalsResult)).toBe(expectedSingleFileNotice(optionals.workspace, 'src/o.ts', [
      '- info 13:5-13:10 source="optionals" code="O1" with optionals',
      '',
      'Fix these diagnostics before considering the change complete.',
    ]))
    await optionals.cleanup()

    const unknown = await bootLspDiagnosticsProfile({ typescriptMode: 'diagnostic-unknown-extension' })
    bootedProfiles.push(unknown)
    const unknownResult = await executeTool(unknown, 'write', { file_path: 'src/u.ts', content: 'const u: number = 1;\n' }, unknown.workspace)
    expect(unknownResult.isError).toBe(false)
    expect(pluginNoticeText(unknownResult)).toBe(expectedSingleFileNotice(unknown.workspace, 'src/u.ts', [
      '- hint 13:5-13:10 source="unknown" code="U1" with unknown extension',
      '',
      'Fix these diagnostics before considering the change complete.',
    ]))
    await unknown.cleanup()

    const invalid = await bootLspDiagnosticsProfile({ typescriptMode: 'diagnostic-invalid-consumed-field' })
    bootedProfiles.push(invalid)
    const invalidResult = await executeTool(invalid, 'write', { file_path: 'src/bad.ts', content: 'const bad: number = 1;\n' }, invalid.workspace)
    expect(invalidResult.isError).toBe(false)
    expect(pluginNoticeText(invalidResult)).toBe(expectedSingleFileNotice(invalid.workspace, 'src/bad.ts', [
      'Status: diagnostics unavailable (malformed response)',
    ]))
  })

  it('uses one shared order and global count cap for a real mixed multi-file aggregate', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'content-aware',
      missingGo: true,
      maxDiagnostics: 1,
      maxResultChars: 8_000,
    })
    bootedProfiles.push(booted)
    const result = await executeMultiFileComposition(booted)
    const text = pluginNoticeText(result)
    expect(text).toBe([
      '[LSP diagnostics after write]',
      `File: ${join(booted.workspace, 'src', 'a.tsx')}`,
      'Status: clean',
      '',
      `File: ${join(booted.workspace, 'src', 'm.go')}`,
      'Status: diagnostics unavailable (server not found)',
      '',
      `File: ${join(booted.workspace, 'src', 'z.ts')}`,
      '- warning 1:1-1:4 source="typescript" code="TS6133" \'unused\' is declared but its value is never read.',
      '',
      'Fix these diagnostics before considering the change complete.',
    ].join('\n'))
    expect(text).not.toContain('TS2322')
    const protocol = readFileSync(booted.typescriptLog, 'utf8')
    expect(protocol.indexOf('didOpen')).toBeLessThan(protocol.lastIndexOf('didOpen'))
    expect(protocol).toContain('a.tsx')
    expect(protocol).toContain('z.ts')
  })

  it('applies the Unicode character cap after building the real canonical aggregate', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'content-aware',
      missingGo: true,
      maxDiagnostics: 1,
      maxResultChars: 120,
    })
    bootedProfiles.push(booted)
    const result = await executeMultiFileComposition(booted)
    const text = pluginNoticeText(result)
    expect(text).toBeDefined()
    expect(Array.from(text!)).toHaveLength(120)
    expect(text).toMatch(/…\(truncated\)$/)
    expect(text).toContain('[LSP diagnostics after write]')
  })

  it('maps an oversized known-size document to a bounded unavailable reason without reading', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'push-versioned', maxDocumentBytes: 64 })
    bootedProfiles.push(booted)

    const result = await executeTool(booted, 'write', {
      file_path: 'src/big.ts',
      content: 'const big: string = "'.padEnd(200, 'x') + '";\n',
    }, booted.workspace)
    expect(result.isError).toBe(false)
    expect(pluginNoticeText(result)).toBe(expectedSingleFileNotice(booted.workspace, 'src/big.ts', [
      'Status: diagnostics unavailable (document too large)',
    ]))
  })

  it('returns at the hard deadline but unload waits a late real final stat before teardown', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'content-aware',
      timeoutMs: 300,
      settleMs: 50,
      shutdownTimeoutMs: 100,
      killGraceMs: 50,
    })
    bootedProfiles.push(booted)
    const fs = (booted.ctx as any).fs
    const originalStat = fs.stat.bind(fs)
    let targetStats = 0
    let releaseFinal!: () => void
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (target: any, signal?: AbortSignal) => {
      if (String(target.displayPath).endsWith('late.ts')) {
        targetStats += 1
        if (targetStats === 2) {
          return new Promise((resolve) => {
            releaseFinal = () => { void originalStat(target).then(resolve, resolve) }
          })
        }
      }
      return originalStat(target, signal)
    })
    const result = await executeTool(booted, 'write', {
      file_path: 'src/late.ts',
      content: 'const late: number = "oops";\n',
    }, booted.workspace)
    expect(result.isError).toBe(false)
    expect(pluginNoticeText(result)).toContain('Status: diagnostics unavailable (timeout)')
    expect(targetStats).toBe(2)

    let cleaned = false
    const cleanup = unloadDiagnostics(booted).then(() => { cleaned = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(cleaned).toBe(false)
    releaseFinal()
    await cleanup
    const callsAfterCleanup = statSpy.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(statSpy).toHaveBeenCalledTimes(callsAfterCleanup)
  })

  it('keeps the tool result successful and fail-open when the server times out, is missing, or is malformed', async () => {
    const timeoutBoot = await bootLspDiagnosticsProfile({ typescriptMode: 'timeout', timeoutMs: 400, settleMs: 50 })
    bootedProfiles.push(timeoutBoot)
    const timeoutResult = await executeTool(timeoutBoot, 'write', { file_path: 'src/t.ts', content: 'const t: number = 1;\n' }, timeoutBoot.workspace)
    expect(timeoutResult.isError).toBe(false)
    expect(pluginNoticeText(timeoutResult)).toBe(expectedSingleFileNotice(timeoutBoot.workspace, 'src/t.ts', [
      'Status: diagnostics unavailable (timeout)',
    ]))
    await timeoutBoot.cleanup()

    const missingBoot = await bootLspDiagnosticsProfile({ missingTypescript: true, timeoutMs: 400, settleMs: 50 })
    bootedProfiles.push(missingBoot)
    const missingResult = await executeTool(missingBoot, 'write', { file_path: 'src/m.ts', content: 'const m: number = 1;\n' }, missingBoot.workspace)
    expect(missingResult.isError).toBe(false)
    expect(pluginNoticeText(missingResult)).toBe(expectedSingleFileNotice(missingBoot.workspace, 'src/m.ts', [
      'Status: diagnostics unavailable (server not found)',
    ]))
    await missingBoot.cleanup()

    const malformedBoot = await bootLspDiagnosticsProfile({ typescriptMode: 'malformed', timeoutMs: 400, settleMs: 50 })
    bootedProfiles.push(malformedBoot)
    const malformedResult = await executeTool(malformedBoot, 'write', { file_path: 'src/bad.ts', content: 'const bad: number = 1;\n' }, malformedBoot.workspace)
    expect(malformedResult.isError).toBe(false)
    expect(pluginNoticeText(malformedResult)).toBe(expectedSingleFileNotice(malformedBoot.workspace, 'src/bad.ts', [
      'Status: diagnostics unavailable (malformed response)',
    ]))
  })

  it('performs graceful shutdown and exit before the real server closes naturally', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'graceful-order',
      shutdownTimeoutMs: 500,
      killGraceMs: 100,
    })
    bootedProfiles.push(booted)
    const result = await executeTool(booted, 'write', {
      file_path: 'src/graceful.ts',
      content: 'const graceful: number = 1;\n',
    }, booted.workspace)
    expect(result.isError).toBe(false)
    await unloadDiagnostics(booted)
    const events = readFileSync(booted.typescriptLog, 'utf8').trim().split('\n')
    const shutdown = events.indexOf('shutdown')
    const exit = events.indexOf('exit')
    const natural = events.indexOf('natural-close')
    expect(shutdown).toBeGreaterThanOrEqual(0)
    expect(exit).toBeGreaterThan(shutdown)
    expect(natural).toBeGreaterThan(exit)
  })

  it('bounds a hung shutdown and leaves no live fake-server process after cleanup', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'hang-shutdown',
      shutdownTimeoutMs: 100,
      killGraceMs: 50,
    })
    bootedProfiles.push(booted)
    const result = await executeTool(booted, 'write', {
      file_path: 'src/hung.ts',
      content: 'const hung: number = 1;\n',
    }, booted.workspace)
    expect(result.isError).toBe(false)
    const started = Date.now()
    await unloadDiagnostics(booted)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(readFileSync(booted.typescriptLog, 'utf8')).toContain('shutdown')
  })

  it('forwards a nested real run_code write notice onto the outer result', async () => {
    const booted = await bootLspDiagnosticsProfile({
      toolsMode: 'ptc',
      typescriptMode: 'push-versioned',
      extraRootEntries: [
        '- id: code-runtime',
        "  name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
      ],
    })
    bootedProfiles.push(booted)

    const tools = booted.ctx.get('tools') as unknown as {
      execute(input: { callId: string; name: string; arguments: unknown; agent?: unknown; signal: AbortSignal }): Promise<any>
    }
    const result = await tools.execute({
      callId: 'composition-run-code',
      name: 'run_code',
      arguments: {
        code: 'await tools.write({ file_path: "src/from-code.ts", content: "const f: number = \\"oops\\";\\n" }); return "done";',
        description: 'Run the test program',
      },
      // The code-mode transport threads the agent down to nested tool calls,
      // which append dispatch events to the session; mirror the official
      // ptc.spec fakeAgent seam (header cwd + append) rather than faking parent.
      agent: {
        session: {
          header: { cwd: booted.workspace },
          append: () => {},
        },
      },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    // The nested write's plugin notice is deferred onto the outer run_code result.
    expect(pluginNoticeText(result)).toBe(expectedSingleFileNotice(booted.workspace, 'src/from-code.ts', [
      TS_DIAGNOSTIC_LINES,
      '',
      'Fix these diagnostics before considering the change complete.',
    ]))
    expect(readFileSync(join(booted.workspace, 'src', 'from-code.ts'), 'utf8')).toBe('const f: number = "oops";\n')
  })

  it.each([
    {
      language: 'TypeScript',
      filePath: 'src/a.ts',
      badContent: 'const x: number = "oops";\n',
      oldString: 'const x: number = "oops";',
      newString: 'const x: number = 1;',
      fixedContent: 'const x: number = 1;\n',
      bootOptions: { typescriptMode: 'content-aware' as const },
    },
    {
      language: 'Go',
      filePath: 'src/main.go',
      badContent: 'package main\nfunc main() { var x string = 1 }\n',
      oldString: 'var x string = 1',
      newString: 'var x int = 1',
      fixedContent: 'package main\nfunc main() { var x int = 1 }\n',
      bootOptions: { typescriptMode: 'content-aware' as const, goMode: 'content-aware' as const },
    },
  ])('persists $language error then clean into the next real Agent request', async ({
    filePath,
    badContent,
    oldString,
    newString,
    fixedContent,
    bootOptions,
  }) => {
    const llmModule = await loadAnchorModule('dsh-llm') as {
      LlmAdapter: new () => unknown
      createUserMessage: (input: unknown) => unknown
      CallId: (id: string) => unknown
    }
    const sessionModule = await loadAnchorModule('dsh-session') as { SessionId: (id: string) => unknown }
    const { LlmAdapter, createUserMessage, CallId } = llmModule
    const { SessionId } = sessionModule

    class MockAdapter extends LlmAdapter {
      requests: any[] = []
      constructor(private readonly script: any[]) { super() }
      resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model })
      }
      async *stream(options: any): AsyncIterable<any> {
        this.requests.push(options)
        const entry = this.script.shift()
        if (!entry) throw new Error('MockAdapter: script exhausted')
        for (const chunk of entry) yield chunk
      }
    }

    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        {
          type: 'block-end', index: 0,
          block: { type: 'tool-call', id: CallId('c1'), name: 'write', arguments: JSON.stringify({ file_path: filePath, content: badContent }) },
        },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        {
          type: 'block-end', index: 0,
          block: {
            type: 'tool-call',
            id: CallId('c2'),
            name: 'edit',
            arguments: JSON.stringify({
              file_path: filePath,
              old_string: oldString,
              new_string: newString,
            }),
          },
        },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ])

    const booted = await bootLspDiagnosticsProfile({
      ...bootOptions,
      extraRootEntries: [
        '- id: llm',
        "  name: '@deepseek-ai/dsh-llm'",
        '- id: sessions',
        "  name: '@deepseek-ai/dsh-session'",
        '- id: session-projections',
        "  name: '@deepseek-ai/dsh-session-projection'",
        '- id: agents',
        "  name: '@deepseek-ai/dsh-agent'",
        '- id: agent-loop',
        "  name: '@deepseek-ai/dsh-agent-loop'",
        '  config:',
        '    agents: []',
      ],
    })
    bootedProfiles.push(booted)

    const ctx = booted.ctx as unknown as {
      llm: { registerAdapter(providers: string[], adapter: unknown): unknown }
      agentLoop: { create(id: unknown, options: Record<string, unknown>, meta: { cwd: string }): any }
      on(event: string, listener: (payload: any) => void): () => void
    }
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }, { cwd: booted.workspace })

    const idle = new Promise<void>((resolve) => {
      const off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') {
          off()
          resolve()
        }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write the file' }], source: { kind: 'user' } }))
    await idle

    // The plugin notice reached the session log as a user/message with the plugin source.
    const events: any[] = agent.session.events as any[]
    const pluginMessages = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'plugin')
    expect(pluginMessages.length).toBeGreaterThan(0)
    const noticeText = pluginMessages
      .flatMap((event) => event.data?.content ?? [])
      .map((block: any) => block?.text ?? '')
      .join('')
    expect(noticeText).toContain('[LSP diagnostics after write]')
    expect(noticeText).toContain(TS_ERROR_SUBSTRING)
    expect(noticeText).toContain('Status: clean')

    // Three model requests ran: request two carries the error notice and
    // performs the real edit; request three carries the resulting clean notice.
    expect(adapter.requests.length).toBe(3)
    const secondRequestMessages = JSON.stringify(adapter.requests[1]?.messages ?? [])
    expect(secondRequestMessages).toContain('[LSP diagnostics after write]')
    expect(secondRequestMessages).toContain('TS2322')
    expect(secondRequestMessages).toContain(TS_ERROR_SUBSTRING.replaceAll('"', '\\"'))
    const thirdRequestMessages = JSON.stringify(adapter.requests[2]?.messages ?? [])
    expect(thirdRequestMessages).toContain('[LSP diagnostics after write]')
    expect(thirdRequestMessages).toContain('Status: clean')
    // The second real tool call fixed the same file in place.
    expect(readFileSync(join(booted.workspace, filePath), 'utf8')).toBe(fixedContent)
  })
})
