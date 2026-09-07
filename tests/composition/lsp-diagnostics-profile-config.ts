import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FAKE_LSP_SERVER = join(repoRoot, 'tests', 'fixtures', 'fake-lsp-server.mjs')

const profileName = 'lsp-diagnostics-profile'

export type FakeLspMode =
  | 'push-versioned'
  | 'push-versionless'
  | 'clean'
  | 'content-aware'
  | 'two-batches'
  | 'continuous'
  | 'delayed-old'
  | 'cross-uri-same-version'
  | 'cross-uri-future-version'
  | 'cross-uri-malformed-diagnostics'
  | 'strict-diagnostic'
  | 'diagnostic-standard-optionals'
  | 'diagnostic-unknown-extension'
  | 'diagnostic-invalid-consumed-field'
  | 'diagnostic-controls'
  | 'timeout'
  | 'hang-initialize'
  | 'crash'
  | 'malformed'
  | 'server-requests'
  | 'close-stdin-after-diagnostics'
  | 'hang-shutdown'
  | 'graceful-order'

export type LspProvider = 'typescript' | 'go' | 'clangd' | 'rust' | 'python'

export interface LspServerOverride {
  readonly command: string
  readonly args: readonly string[]
}

export interface LspDiagnosticsBootOptions {
  readonly typescriptMode?: FakeLspMode
  readonly goMode?: FakeLspMode
  readonly clangdMode?: FakeLspMode
  readonly rustMode?: FakeLspMode
  readonly pythonMode?: FakeLspMode
  readonly enabled?: boolean
  readonly timeoutMs?: number
  readonly settleMs?: number
  readonly maxDocumentBytes?: number
  readonly maxDiagnostics?: number
  readonly maxResultChars?: number
  readonly shutdownTimeoutMs?: number
  readonly killGraceMs?: number
  readonly extraRootEntries?: readonly string[]
  readonly additionalBundles?: readonly string[]
  readonly extraPatchEntries?: readonly string[]
  readonly toolsMode?: 'native' | 'code' | 'ptc'
  readonly missingTypescript?: boolean
  readonly missingGo?: boolean
  readonly serverOverrides?: Partial<Record<LspProvider, LspServerOverride>>
}

export function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string {
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`${name} not found on PATH`)
}

function stageBundle(profile: string, bundle: string): string {
  const source = join(repoRoot, bundle)
  const target = join(profile, 'local-packages', basename(bundle))
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.includes(`${repoRoot}/${bundle}/node_modules`)
      && !path.includes(`${repoRoot}/${bundle}/tests`)
      && !path.endsWith('/tsconfig.json'),
  })
  return `./local-packages/${basename(bundle)}`
}

export function installBundles(input: {
  readonly dshBin: string
  readonly dshHome: string
  readonly profile: string
  readonly bundles: readonly string[]
}): void {
  const specs = input.bundles.map((bundle) => stageBundle(input.profile, bundle))
  const result = spawnSync(
    input.dshBin,
    ['plugin', '--profile', profileName, 'add', '-w', ...specs, '--offline', '--ignore-scripts'],
    { cwd: input.profile, env: { ...process.env, DSH_HOME: input.dshHome }, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`dsh plugin add failed (${result.status ?? 'signal'}):\n${result.stdout}${result.stderr}`)
  }
}

function baseRootEntries(toolsMode: 'native' | 'code' | 'ptc', workspace: string): string[] {
  const mode = toolsMode === 'code' ? 'ptc' : toolsMode
  return [
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '  config:',
    `    mode: ${mode}`,
    '- id: fs',
    "  name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(workspace)}`,
    '- id: subprocess',
    "  name: '@deepseek-ai/dsh-subprocess-local'",
    '- id: tool-fs',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '- id: editor',
    "  name: '@deepseek-ai/dsh-tool-str-replace-editor'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
  ]
}

function serverArgs(mode: FakeLspMode, logPath: string, missing: boolean): string[] {
  return missing ? [] : [FAKE_LSP_SERVER, mode, logPath]
}

function fakeServerLines(input: {
  readonly provider: string
  readonly mode: FakeLspMode
  readonly logPath: string
  readonly command: string
  readonly missing?: boolean
}): string[] {
  const missing = input.missing === true
  const args = serverArgs(input.mode, input.logPath, missing)
  return [
    `      ${input.provider}:`,
    `        command: ${JSON.stringify(missing ? input.command : process.execPath)}`,
    ...(args.length === 0
      ? ['        args: []']
      : ['        args:', ...args.map((arg) => `          - ${JSON.stringify(arg)}`)]),
    '        env: {}',
  ]
}

function serverLines(input: {
  readonly provider: LspProvider
  readonly mode: FakeLspMode
  readonly logPath: string
  readonly fallbackCommand: string
  readonly missing?: boolean
  readonly override?: LspServerOverride
}): string[] {
  if (input.override === undefined) {
    return fakeServerLines({
      provider: input.provider,
      mode: input.mode,
      logPath: input.logPath,
      command: input.fallbackCommand,
      missing: input.missing,
    })
  }
  return [
    `      ${input.provider}:`,
    `        command: ${JSON.stringify(input.override.command)}`,
    ...(input.override.args.length === 0
      ? ['        args: []']
      : ['        args:', ...input.override.args.map((arg) => `          - ${JSON.stringify(arg)}`)]),
    '        env: {}',
  ]
}

export function writeLspProfileFiles(input: {
  readonly profile: string
  readonly workspace: string
  readonly options: LspDiagnosticsBootOptions
  readonly logs: {
    readonly typescript: string
    readonly go: string
    readonly clangd: string
    readonly rust: string
    readonly python: string
  }
}): string {
  const typescriptMissing = input.options.missingTypescript === true
  const goMissing = input.options.missingGo === true
  const lines = [
    '- id: lsp-diagnostics',
    '  config:',
    `    enabled: ${input.options.enabled ?? true}`,
    `    timeoutMs: ${input.options.timeoutMs ?? 2000}`,
    `    settleMs: ${input.options.settleMs ?? 100}`,
    `    shutdownTimeoutMs: ${input.options.shutdownTimeoutMs ?? 1_000}`,
    `    killGraceMs: ${input.options.killGraceMs ?? 500}`,
    `    maxDocumentBytes: ${input.options.maxDocumentBytes ?? 2_097_152}`,
    `    maxDiagnostics: ${input.options.maxDiagnostics ?? 50}`,
    `    maxResultChars: ${input.options.maxResultChars ?? 8_000}`,
    '    servers:',
    ...serverLines({
      provider: 'typescript',
      mode: input.options.typescriptMode ?? 'push-versioned',
      logPath: input.logs.typescript,
      fallbackCommand: join(input.profile, 'missing-language-server'),
      missing: typescriptMissing,
      override: input.options.serverOverrides?.typescript,
    }),
    ...serverLines({
      provider: 'go',
      mode: input.options.goMode ?? 'clean',
      logPath: input.logs.go,
      fallbackCommand: join(input.profile, 'missing-go-language-server'),
      missing: goMissing,
      override: input.options.serverOverrides?.go,
    }),
    ...(input.options.clangdMode === undefined && input.options.serverOverrides?.clangd === undefined ? [] : serverLines({
      provider: 'clangd',
      mode: input.options.clangdMode ?? 'clean',
      logPath: input.logs.clangd,
      fallbackCommand: 'clangd',
      override: input.options.serverOverrides?.clangd,
    })),
    ...(input.options.rustMode === undefined && input.options.serverOverrides?.rust === undefined ? [] : serverLines({
      provider: 'rust',
      mode: input.options.rustMode ?? 'clean',
      logPath: input.logs.rust,
      fallbackCommand: 'rust-analyzer',
      override: input.options.serverOverrides?.rust,
    })),
    ...(input.options.pythonMode === undefined && input.options.serverOverrides?.python === undefined ? [] : serverLines({
      provider: 'python',
      mode: input.options.pythonMode ?? 'clean',
      logPath: input.logs.python,
      fallbackCommand: 'pyright-langserver',
      override: input.options.serverOverrides?.python,
    })),
    ...(input.options.extraPatchEntries ?? []),
  ]
  writeFileSync(join(input.profile, 'cordis.patch.yml'), `${lines.join('\n')}\n`)

  const entries = [...baseRootEntries(input.options.toolsMode ?? 'native', input.workspace)]
  if (input.options.extraRootEntries !== undefined) entries.push(...input.options.extraRootEntries)
  const root = join(input.profile, 'cordis.yml')
  writeFileSync(root, `${entries.join('\n')}\n`)
  return root
}
