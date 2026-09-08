import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { goBuildStatus } from '../helpers/go-tool'
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
 * Drive one real official `write` tool call through the booted plugin's real
 * fs/observed emission and real three-argument post-execute waterfall, then
 * return the tool result with any plugin notice attached.
 */
async function writeFileThroughRealTool(
  booted: LspDiagnosticsBooted,
  relativePath: string,
  content: string,
): Promise<any> {
  return executeTool(booted, 'write', { file_path: relativePath, content }, booted.workspace)
}

/** Remove the live loader entry and await that plugin's async cleanup. */
async function unloadDiagnostics(booted: LspDiagnosticsBooted): Promise<void> {
  const loader = (booted.ctx as any).get('loader')
  const entry = [...loader.entries()].find((candidate: any) => candidate.options.name === 'dsh-lsp-diagnostics')
  if (entry === undefined) throw new Error('live dsh-lsp-diagnostics loader entry not found')
  await entry.update({ disabled: true })
}

/** Return the real Loader-backed catalog exposed to model tool calls. */
function toolNames(booted: LspDiagnosticsBooted): string[] {
  const tools = booted.ctx.get('tools') as unknown as { schemas(): Array<{ name: string }> }
  return tools.schemas().map((schema) => schema.name).sort()
}

/** Join the model-rendered text blocks of one real tool result. */
function renderedToolText(result: any): string {
  const content: any[] = result?.content ?? []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
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
    expect(toolNames(booted)).toEqual(expect.arrayContaining(['write', 'edit', 'str_replace_editor', 'lsp_diagnostics']))

    const result = await executeTool(booted, 'write', {
      file_path: 'src/a.ts',
      content: 'const x: number = "oops";\n',
    }, booted.workspace)

    expect(result.isError).toBe(false)
    const notice = pluginNoticeText(result)
    expect(notice).toBe(expectedSingleFileNotice(booted.workspace, 'src/a.ts', [TS_DIAGNOSTIC_LINES, '', 'Fix these diagnostics before considering the change complete.']))
    // The real tools actually wrote the file inside the session workspace.
    expect(readFileSync(join(booted.workspace, 'src', 'a.ts'), 'utf8')).toBe('const x: number = "oops";\n')
    // The protocol didOpen used the canonical fs-derived file URL of the real
    // target — never a displayPath-guessed URI — through the whole real path.
    const protocol = readFileSync(booted.typescriptLog, 'utf8')
    const canonicalUrl = pathToFileURL(join(booted.workspace, 'src', 'a.ts')).href
    expect(protocol).toContain(`didOpen ${canonicalUrl} v1`)
    expect(protocol).toContain(`publish ${canonicalUrl} v1`)
  })

  it('directly diagnoses a pre-existing file without mutating it, then reports no_diagnostics after an out-of-band repair', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'content-aware' })
    bootedProfiles.push(booted)
    const relativePath = 'src/direct.ts'
    const absolutePath = join(booted.workspace, relativePath)
    const bad = 'const direct: number = "oops";\n'
    const repaired = 'const direct: number = 42;\n'
    mkdirSync(join(booted.workspace, 'src'), { recursive: true })
    writeFileSync(absolutePath, bad)

    const diagnostics = await executeTool(booted, 'lsp_diagnostics', { file_path: relativePath }, booted.workspace)

    expect(diagnostics.isError).toBe(false)
    expect(diagnostics.value).toMatchObject({
      kind: 'diagnostics',
      file_path: absolutePath,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'TS2322' })]),
    })
    expect(renderedToolText(diagnostics)).toContain('[LSP diagnostics]')
    expect(renderedToolText(diagnostics)).toContain(absolutePath)
    expect(renderedToolText(diagnostics)).toContain('TS2322')
    expect(readFileSync(absolutePath, 'utf8')).toBe(bad)

    writeFileSync(absolutePath, repaired)
    const clean = await executeTool(booted, 'lsp_diagnostics', { file_path: relativePath }, booted.workspace)

    expect(clean.isError).toBe(false)
    expect(clean.value).toEqual({ kind: 'no_diagnostics', file_path: absolutePath })
    expect(renderedToolText(clean)).toContain('No diagnostics reported for this file snapshot.')
    expect(readFileSync(absolutePath, 'utf8')).toBe(repaired)
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
    // A genuinely broken Go program: assigning an int constant to a string
    // variable at package scope fails real Go compilation.
    const badGo = 'package main\nvar x string = 1\nfunc main() {}\n'
    const fixedGo = 'package main\nvar x string = "1"\nfunc main() {}\n'
    expect(goBuildStatus(badGo)).not.toBe(0)
    expect(goBuildStatus(fixedGo)).toBe(0)
    const errorWrite = await executeTool(booted, 'write', {
      file_path: 'src/main.go',
      content: badGo,
    }, booted.workspace)
    expect(errorWrite.isError).toBe(false)
    expect(pluginNoticeText(errorWrite)).toContain(TS_ERROR_SUBSTRING)

    const fix = await executeTool(booted, 'edit', {
      file_path: 'src/main.go',
      old_string: 'var x string = 1',
      new_string: 'var x string = "1"',
    }, booted.workspace)
    expect(fix.isError).toBe(false)
    // The clean result reflects a genuinely repaired Go program: the fixed
    // source compiles with the real Go toolchain, not just a sentinel gone.
    expect(pluginNoticeText(fix)).toBe(expectedSingleFileNotice(booted.workspace, 'src/main.go', ['Status: clean']))
    expect(readFileSync(join(booted.workspace, 'src', 'main.go'), 'utf8')).toContain('var x string = "1"')
  }, 30_000)

  it('routes every added extension through the real Loader to its canonical provider and language id', async () => {
    const booted = await bootLspDiagnosticsProfile({
      clangdMode: 'clean',
      rustMode: 'clean',
      pythonMode: 'clean',
    })
    bootedProfiles.push(booted)
    const routes = [
      ['src/a.c', 'c', booted.clangdLog],
      ['src/a.cc', 'cpp', booted.clangdLog],
      ['src/a.cpp', 'cpp', booted.clangdLog],
      ['src/a.cxx', 'cpp', booted.clangdLog],
      ['src/a.h', 'cpp', booted.clangdLog],
      ['src/a.hh', 'cpp', booted.clangdLog],
      ['src/a.hpp', 'cpp', booted.clangdLog],
      ['src/a.hxx', 'cpp', booted.clangdLog],
      ['src/a.rs', 'rust', booted.rustLog],
      ['src/a.py', 'python', booted.pythonLog],
      ['src/a.pyi', 'python', booted.pythonLog],
    ] as const

    for (const [relativePath, languageId, logPath] of routes) {
      const result = await writeFileThroughRealTool(booted, relativePath, 'fixture content\n')
      expect(pluginNoticeText(result), relativePath).toBe(
        expectedSingleFileNotice(booted.workspace, relativePath, ['Status: clean']),
      )
      const protocol = readFileSync(logPath, 'utf8')
      expect(protocol, relativePath).toContain(`didOpen ${pathToFileURL(join(booted.workspace, relativePath)).href} v`)
      expect(protocol, relativePath).toContain(`languageId ${languageId}`)
    }
  }, 30_000)

  it('routes direct calls for every configured extension to the canonical language id', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'clean',
      goMode: 'clean',
      clangdMode: 'clean',
      rustMode: 'clean',
      pythonMode: 'clean',
    })
    bootedProfiles.push(booted)
    const routes = [
      ['src/direct.ts', 'typescript', booted.typescriptLog],
      ['src/direct.tsx', 'typescriptreact', booted.typescriptLog],
      ['src/direct.go', 'go', booted.goLog],
      ['src/direct.c', 'c', booted.clangdLog],
      ['src/direct.cc', 'cpp', booted.clangdLog],
      ['src/direct.cpp', 'cpp', booted.clangdLog],
      ['src/direct.cxx', 'cpp', booted.clangdLog],
      ['src/direct.h', 'cpp', booted.clangdLog],
      ['src/direct.hh', 'cpp', booted.clangdLog],
      ['src/direct.hpp', 'cpp', booted.clangdLog],
      ['src/direct.hxx', 'cpp', booted.clangdLog],
      ['src/direct.rs', 'rust', booted.rustLog],
      ['src/direct.py', 'python', booted.pythonLog],
      ['src/direct.pyi', 'python', booted.pythonLog],
    ] as const
    mkdirSync(join(booted.workspace, 'src'), { recursive: true })

    for (const [relativePath, languageId, logPath] of routes) {
      const absolutePath = join(booted.workspace, relativePath)
      const bytes = `fixture for ${relativePath}\n`
      writeFileSync(absolutePath, bytes)

      const result = await executeTool(booted, 'lsp_diagnostics', { file_path: relativePath }, booted.workspace)

      expect(result.isError, relativePath).toBe(false)
      expect(result.value, relativePath).toEqual({ kind: 'no_diagnostics', file_path: absolutePath })
      expect(readFileSync(absolutePath, 'utf8'), relativePath).toBe(bytes)
      const protocol = readFileSync(logPath, 'utf8')
      expect(protocol, relativePath).toContain(`didOpen ${pathToFileURL(absolutePath).href} v1\nlanguageId ${languageId}`)
    }
  }, 30_000)

  it('diagnoses a readable external file while preserving the session workspace as the LSP root', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'clean' })
    bootedProfiles.push(booted)
    mkdirSync(join(booted.workspace, 'src'), { recursive: true })
    writeFileSync(join(booted.workspace, 'src', 'unsupported.js'), 'const value = 1;\n')
    const outsidePath = join(booted.profile, 'outside.ts')
    const outsideContents = 'const outside: number = 1;\n'
    writeFileSync(outsidePath, outsideContents)

    const noCwd = await executeTool(booted, 'lsp_diagnostics', { file_path: 'src/unsupported.js' })
    expect(noCwd.isError).toBe(true)
    expect(noCwd.error?.message).toBe('lsp_diagnostics requires a session workspace cwd')
    expect(renderedToolText(noCwd)).toContain('Error: lsp_diagnostics requires a session workspace cwd')

    for (const filePath of [outsidePath, relative(booted.workspace, outsidePath)]) {
      const outside = await executeTool(booted, 'lsp_diagnostics', { file_path: filePath }, booted.workspace)
      expect(outside.isError, filePath).toBe(false)
      expect(outside.value, filePath).toEqual({ kind: 'no_diagnostics', file_path: outsidePath })
      expect(renderedToolText(outside), filePath).toContain(`File: ${outsidePath}`)
      expect(readFileSync(outsidePath, 'utf8'), filePath).toBe(outsideContents)
    }
    const protocol = readFileSync(booted.typescriptLog, 'utf8').trim().split('\n')
    const outsideUri = pathToFileURL(outsidePath).href
    expect(protocol.filter((entry) => entry === `didOpen ${outsideUri} v1`)).toHaveLength(2)

    const unsupported = await executeTool(booted, 'lsp_diagnostics', { file_path: 'src/unsupported.js' }, booted.workspace)
    expect(unsupported.isError).toBe(true)
    expect(unsupported.error?.message).toBe('lsp_diagnostics: no configured diagnostics provider for extension .js')
  })

  it('shares one runtime across automatic/direct diagnoses while rotating before the same-uri reopen', async () => {
    const booted = await bootLspDiagnosticsProfile({ typescriptMode: 'content-aware' })
    bootedProfiles.push(booted)
    const relativePath = 'src/interleaved.ts'
    const absolutePath = join(booted.workspace, relativePath)

    const automatic = await writeFileThroughRealTool(booted, relativePath, 'const interleaved: number = "oops";\n')
    expect(pluginNoticeText(automatic)).toContain(TS_ERROR_SUBSTRING)
    const direct = await executeTool(booted, 'lsp_diagnostics', { file_path: relativePath }, booted.workspace)
    expect(direct.value).toMatchObject({ kind: 'diagnostics', file_path: absolutePath })

    const uri = pathToFileURL(absolutePath).href
    const events = readFileSync(booted.typescriptLog, 'utf8').trim().split('\n')
    expect(events.filter((event) => event === 'initialize')).toHaveLength(2)
    expect(events.filter((event) => event.startsWith('didOpen '))).toEqual([
      `didOpen ${uri} v1`,
      `didOpen ${uri} v1`,
    ])
    const opens = events.flatMap((event, index) => event === `didOpen ${uri} v1` ? [index] : [])
    const closes = events.flatMap((event, index) => event === `didClose ${uri}` ? [index] : [])
    expect(closes[0]).toBeGreaterThan(opens[0]!)
    expect(opens[1]).toBeGreaterThan(closes[0]!)
    expect(closes[1]).toBeGreaterThan(opens[1]!)
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

    expect(toolNames(booted)).not.toContain('lsp_diagnostics')
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

  it('renders the shared aggregate grammar and global count cap through real write tool calls', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'content-aware',
      missingGo: true,
      maxDiagnostics: 1,
      maxResultChars: 8_000,
    })
    bootedProfiles.push(booted)
    // Every write is a real official tool call: real fs/observed emission and
    // the real three-parameter post-execute waterfall (no hand-sent events).
    const cleanResult = await writeFileThroughRealTool(booted, 'src/a.tsx', 'export const a: number = 1;\n')
    expect(cleanResult.isError).toBe(false)
    expect(pluginNoticeText(cleanResult)).toBe(expectedSingleFileNotice(booted.workspace, 'src/a.tsx', ['Status: clean']))

    const goResult = await writeFileThroughRealTool(booted, 'src/m.go', 'package main\nfunc main() {}\n')
    expect(goResult.isError).toBe(false)
    expect(pluginNoticeText(goResult)).toBe(expectedSingleFileNotice(booted.workspace, 'src/m.go', [
      'Status: diagnostics unavailable (server not found)',
    ]))

    // The real global count cap keeps the single earliest diagnostic line of
    // the two-batch file (warning sorts before error) and drops TS2322.
    const errorResult = await writeFileThroughRealTool(booted, 'src/z.ts', 'const z: number = "oops";\n')
    expect(errorResult.isError).toBe(false)
    expect(pluginNoticeText(errorResult)).toBe(expectedSingleFileNotice(booted.workspace, 'src/z.ts', [
      '- warning 1:1-1:4 source="typescript" code="TS6133" \'unused\' is declared but its value is never read.',
      '',
      'Fix these diagnostics before considering the change complete.',
    ]))
    expect(pluginNoticeText(errorResult)).not.toContain('TS2322')
    const protocol = readFileSync(booted.typescriptLog, 'utf8')
    expect(protocol.indexOf('didOpen')).toBeLessThan(protocol.lastIndexOf('didOpen'))
    expect(protocol).toContain('a.tsx')
    expect(protocol).toContain('z.ts')
  })

  it('applies the Unicode character cap after building the real canonical aggregate', async () => {
    const booted = await bootLspDiagnosticsProfile({
      typescriptMode: 'content-aware',
      maxDiagnostics: 1,
      maxResultChars: 120,
    })
    bootedProfiles.push(booted)
    const result = await writeFileThroughRealTool(booted, 'src/z.ts', 'const z: number = "oops";\n')
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

  it('forwards a nested real run_code write notice and keeps callable canonical values bounded in PTC mode', async () => {
    const booted = await bootLspDiagnosticsProfile({
      toolsMode: 'ptc',
      typescriptMode: 'push-versioned',
      maxDiagnostics: 1,
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
        code: 'await tools.write({ file_path: "src/from-code.ts", content: "const f: number = \\"oops\\";\\n" }); return await tools.lsp_diagnostics({ file_path: "src/from-code.ts" });',
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
      TS_DIAGNOSTIC_LINES.split('\n')[0]!,
      '',
      'Fix these diagnostics before considering the change complete.',
    ]))
    expect(result.value.result).toMatchObject({
      kind: 'diagnostics',
      file_path: join(booted.workspace, 'src', 'from-code.ts'),
      diagnostics: [{ code: 'TS6133' }],
      omitted_diagnostics: 1,
    })
    expect(result.value.result.diagnostics).toHaveLength(1)
    expect(readFileSync(join(booted.workspace, 'src', 'from-code.ts'), 'utf8')).toBe('const f: number = "oops";\n')
  })

  it('persists a nested real run_code write notice into the next real Agent request', async () => {
    const llmModule = await loadAnchorModule('dsh-llm') as {
      LlmAdapter: new () => unknown
      createUserMessage: (input: unknown) => unknown
      ToolCallId: (id: string) => unknown
    }
    const sessionModule = await loadAnchorModule('dsh-session') as { SessionId: (id: string) => unknown }
    const { LlmAdapter, createUserMessage, ToolCallId } = llmModule
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
          block: {
            type: 'tool-call',
            id: ToolCallId('c1'),
            name: 'run_code',
            arguments: JSON.stringify({
              code: 'await tools.write({ file_path: "src/from-agent-code.ts", content: "const f: number = \\"oops\\";\\n" }); return "done";',
              description: 'Write a file from code',
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
      toolsMode: 'ptc',
      typescriptMode: 'push-versioned',
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
        '- id: code-runtime',
        "  name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
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
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write the file via code' }], source: { kind: 'user' } }))
    await idle

    // The nested run_code write's plugin notice reached the session log as a
    // user/message with the plugin source.
    const events: any[] = agent.session.snapshotEvents()
    const pluginMessages = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'plugin')
    expect(pluginMessages.length).toBeGreaterThan(0)
    const noticeText = pluginMessages
      .flatMap((event) => event.data?.content ?? [])
      .map((block: any) => block?.text ?? '')
      .join('')
    expect(noticeText).toContain('[LSP diagnostics after write]')
    expect(noticeText).toContain(TS_ERROR_SUBSTRING)

    // Two model requests ran: the second request carries the run_code-derived
    // plugin notice (durable into the next model inference).
    expect(adapter.requests.length).toBe(2)
    const secondRequestMessages = JSON.stringify(adapter.requests[1]?.messages ?? [])
    expect(secondRequestMessages).toContain('[LSP diagnostics after write]')
    expect(secondRequestMessages).toContain('TS2322')
    expect(readFileSync(join(booted.workspace, 'src', 'from-agent-code.ts'), 'utf8')).toBe('const f: number = "oops";\n')
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
      badContent: 'package main\nvar x string = 1\nfunc main() {}\n',
      oldString: 'var x string = 1',
      newString: 'var x string = "1"',
      fixedContent: 'package main\nvar x string = "1"\nfunc main() {}\n',
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
      ToolCallId: (id: string) => unknown
    }
    const sessionModule = await loadAnchorModule('dsh-session') as { SessionId: (id: string) => unknown }
    const { LlmAdapter, createUserMessage, ToolCallId } = llmModule
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
          block: { type: 'tool-call', id: ToolCallId('c1'), name: 'write', arguments: JSON.stringify({ file_path: filePath, content: badContent }) },
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
            id: ToolCallId('c2'),
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
    const events: any[] = agent.session.snapshotEvents()
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
