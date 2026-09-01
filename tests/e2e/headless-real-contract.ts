/// <reference types="node" />

import type {
  BootContext,
  RealProfileProof,
  ShellRunResultLike,
} from '../composition/profile-loader'
import type { RealBootOptions } from './headless-real-runtime'

export type ShellRequest = {
  readonly command: string
  readonly workdir?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly sandboxPolicy?: {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly workspaceRoot: string
  }
}

export type EnvironmentSnapshot = Readonly<Record<string, string | undefined>>

export type ToolExecutionResult = {
  readonly isError: boolean
  readonly value?: unknown
  readonly content: readonly {
    readonly type: string
    readonly text?: string
  }[]
  readonly error?: { readonly message: string }
}

export type RealBoot = {
  readonly ctx: BootContext
  readonly proof: RealProfileProof
  readonly ownedProcessPids: () => number[]
  readonly shellProviders: () => string[]
  readonly localPluginOrder: () => string[]
  readonly toolNames: () => string[]
  readonly runShell: (request: ShellRequest | string) => Promise<ShellRunResultLike>
  readonly executeTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ToolExecutionResult>
  readonly callTool: (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly cleanup: () => Promise<void>
}

export type RealHeadlessHarness = {
  readonly dshHome: string
  readonly home: string
  readonly profile: string
  readonly gitProject: string
  readonly defaultIndexedProject: string
  readonly defaultIndexedSymbol: string
  readonly explicitIndexedProject: string
  readonly explicitIndexedSymbol: string
  readonly ownedProcessCount: () => number
  readonly boot: (options?: RealBootOptions) => Promise<RealBoot>
  readonly cleanup: () => Promise<void>
}

const SHELL_PROVIDERS = new Set([
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-bash-local',
  'dsh-fish-shell',
])
const LOCAL_PLUGIN_LOADER_NAMES = new Map<string, string>([
  ['dsh-fish-shell', 'dsh-fish-shell'],
  ['dsh-rtk', 'dsh-rtk'],
  ['@deepseek-ai/dsh-mcp-client', 'dsh-codegraph-mcp'],
])

export function activeShellProviders(ctx: BootContext): string[] {
  const loader = ctx.get('loader')
  if (loader === undefined) return []
  return [...loader.entries()]
    .filter((entry) => !entry.disabled && SHELL_PROVIDERS.has(entry.options.name))
    .map((entry) => entry.options.name)
    .sort()
}

export function activeLocalPluginOrder(ctx: BootContext): string[] {
  const loader = ctx.get('loader')
  if (loader === undefined) return []
  return [...loader.entries()]
    .filter((entry) => !entry.disabled && LOCAL_PLUGIN_LOADER_NAMES.has(entry.options.name))
    .flatMap((entry) => {
      const name = LOCAL_PLUGIN_LOADER_NAMES.get(entry.options.name)
      return name === undefined ? [] : [name]
    })
}

const OWNED_ENV_NAMES = [
  'DSH_HOME',
  'HOME',
  'PATH',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'CODEGRAPH_NO_DAEMON',
  'DO_NOT_TRACK',
  'CODEGRAPH_NO_UPDATE_CHECK',
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'GIT_ASKPASS',
  'GIT_ASKPASS_REQUIRE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_INDEX_FILE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
] as const
const SSH_BOOTSTRAP_ENV = new Set(['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'])

function isGitBootstrapName(name: string): boolean {
  return name.startsWith('GIT_') || name.startsWith('GCM_') || SSH_BOOTSTRAP_ENV.has(name)
}

export function captureEnvironment(): {
  readonly credentialNames: readonly string[]
  readonly snapshot: EnvironmentSnapshot
} {
  const credentialNames = Object.keys(process.env).filter(isGitBootstrapName)
  const names = [...new Set([...OWNED_ENV_NAMES, ...credentialNames])]
  const snapshot = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  )
  return { credentialNames: names.filter(isGitBootstrapName), snapshot }
}

export function scrubGitCredentials(credentialNames: readonly string[]): void {
  for (const name of credentialNames) delete process.env[name]
}

export function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

export function readTextToolResult(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('content' in value)) {
    throw new Error('real E2E tool result has no content')
  }
  const content = Reflect.get(value, 'content')
  if (!Array.isArray(content)) throw new Error('real E2E tool result content is not an array')
  return content.map((block) => {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'text') return ''
    const text = Reflect.get(block, 'text')
    return typeof text === 'string' ? text : ''
  }).join('\n')
}
