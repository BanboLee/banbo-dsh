import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LspDiagnosticsBooted } from './lsp-diagnostics-profile'
import type {
  LspProvider,
  LspServerOverride,
} from './lsp-diagnostics-profile-config'

export type RealProvider = LspProvider

export type ProviderCase = {
  readonly path: string
  readonly bad: string
  readonly oldText: string
  readonly newText: string
  readonly setup?: readonly { readonly path: string; readonly content: string }[]
  readonly args: readonly string[]
}

export type RealLaneResult = {
  readonly provider: RealProvider
  readonly executable: string
  readonly status: 'passed' | 'blocked' | 'failed'
  readonly diagnosticObserved: boolean
  readonly cleanObserved: boolean
  readonly reason?: string
}

export type RealLaneEvidence = {
  readonly enabled: true
  readonly requestedProviders: readonly RealProvider[]
  readonly results: readonly RealLaneResult[]
}

export const PROVIDER_CASES: Readonly<Record<RealProvider, ProviderCase>> = {
  typescript: {
    path: 'src/real.ts',
    bad: 'const answer: number = "bad";\n',
    oldText: '"bad"',
    newText: '42',
    args: ['--stdio'],
  },
  go: {
    path: 'main.go',
    bad: 'package main\nvar answer int = "bad"\nfunc main() {}\n',
    oldText: '"bad"',
    newText: '42',
    setup: [{ path: 'go.mod', content: 'module real-lsp-test\n\ngo 1.22\n' }],
    args: [],
  },
  clangd: {
    path: 'src/real.c',
    bad: 'int answer(void) { return "bad"; }\n',
    oldText: '"bad"',
    newText: '42',
    args: [],
  },
  rust: {
    path: 'src/lib.rs',
    bad: 'pub fn answer() -> i32 { "bad" }\n',
    oldText: '"bad"',
    newText: '42',
    setup: [{
      path: 'Cargo.toml',
      content: '[package]\nname = "real-lsp-test"\nversion = "0.1.0"\nedition = "2021"\n',
    }],
    args: [],
  },
  python: {
    path: 'src/real.py',
    bad: 'answer: int = "bad"\n',
    oldText: '"bad"',
    newText: '42',
    args: ['--stdio'],
  },
}

export const COMMAND_ENV: Readonly<Record<RealProvider, string>> = {
  typescript: 'REAL_LSP_TYPESCRIPT_COMMAND',
  go: 'REAL_LSP_GO_COMMAND',
  clangd: 'REAL_LSP_CLANGD_COMMAND',
  rust: 'REAL_LSP_RUST_COMMAND',
  python: 'REAL_LSP_PYTHON_COMMAND',
}

const REAL_PROVIDERS = new Set<string>(Object.keys(PROVIDER_CASES))

export function parseRequestedProviders(value: string | undefined): RealProvider[] {
  if (value === undefined || value.length === 0) {
    throw new Error('REAL_LSP_PROVIDERS must be a non-empty comma-separated provider list')
  }
  const providers = value.split(',').map((provider) => provider.trim())
  const unique = new Set<RealProvider>()
  for (const provider of providers) {
    if (!REAL_PROVIDERS.has(provider)) throw new Error(`unknown requested real LSP provider: ${provider}`)
    unique.add(provider as RealProvider)
  }
  return [...unique]
}

export function configuredServer(provider: RealProvider): LspServerOverride {
  const envName = COMMAND_ENV[provider]
  const command = process.env[envName]
  if (command === undefined || command.length === 0) {
    throw new Error(`${envName} must explicitly name the requested provider executable`)
  }
  accessSync(command, constants.X_OK)
  return { command, args: PROVIDER_CASES[provider].args }
}

export async function executeTool(
  booted: LspDiagnosticsBooted,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const tools = booted.ctx.get('tools') as unknown as {
    execute(input: {
      readonly callId: string
      readonly name: string
      readonly arguments: unknown
      readonly agent: unknown
      readonly signal: AbortSignal
    }): Promise<unknown>
  }
  return tools.execute({
    callId: `real-lsp-${name}`,
    name,
    arguments: args,
    agent: { session: { header: { cwd: booted.workspace } } },
    signal: new AbortController().signal,
  })
}

export function noticeText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('additionalContexts' in result)) return undefined
  const contexts = result.additionalContexts
  if (!Array.isArray(contexts)) return undefined
  for (const context of contexts) {
    if (typeof context !== 'object' || context === null || !('content' in context)) continue
    const content = context.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && block.type === 'text'
        && 'text' in block
        && typeof block.text === 'string'
      ) return block.text
    }
  }
  return undefined
}

export function writeEvidence(path: string, evidence: RealLaneEvidence): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
