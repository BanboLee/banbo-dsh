import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'DSH_HOME',
  'DSH_TUI_SESSION_ROOT',
  'DSH_TUI_WORKSPACE_TARGET',
  'DSH_TELEMETRY_MODE',
  'DO_NOT_TRACK',
  'CODEGRAPH_NO_UPDATE_CHECK',
  'QA_LOOPBACK_API_KEY',
  'QA_LOOPBACK_PORT',
  'QA_RTK',
  'QA_CODEGRAPH',
  'QA_TS_LSP',
  'QA_GOPLS',
  'QA_REAL_DSH',
  'QA_GO',
]

class QaEnvironmentError extends Error {
  name = 'QaEnvironmentError'

  constructor(message) {
    super(message)
  }
}

function isWithin(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`)
}

export function assertIsolatedQaRoot(qaRoot, repoRoot, userHome = homedir()) {
  const resolved = resolve(qaRoot)
  if (
    resolved === resolve(repoRoot) ||
    isWithin(resolved, repoRoot) ||
    resolved === resolve(userHome) ||
    isWithin(resolved, userHome) ||
    !(resolved === resolve(tmpdir()) || isWithin(resolved, tmpdir()))
  ) {
    throw new QaEnvironmentError(`QA root must be an isolated OS temporary directory: ${resolved}`)
  }
  return resolved
}

export function createQaLayout(qaRoot) {
  const root = resolve(qaRoot)
  const runtimeName = createHash('sha256').update(root).digest('hex').slice(0, 12)
  const layout = {
    root,
    home: join(root, 'home'),
    runtimeHome: join(tmpdir(), `dsh-tui-qa-${runtimeName}`),
    runtimeName,
    dshHome: join(root, 'dsh-home'),
    sessionRoot: join(root, 'sessions'),
    workspace: join(root, 'workspace'),
    bin: join(root, 'bin'),
    packs: join(root, 'packs'),
    evidence: join(root, 'evidence'),
  }
  for (const [name, path] of Object.entries(layout)) {
    if (name !== 'runtimeName' && name !== 'runtimeHome') mkdirSync(path, { recursive: true })
  }
  symlinkSync(layout.home, layout.runtimeHome, 'dir')
  return layout
}

export function cleanupQaRuntimeHome(layout) {
  rmSync(layout.runtimeHome, { force: true })
}

export function buildQaEnvironment(options) {
  const qaRoot = resolve(options.qaRoot)
  return {
    HOME: options.runtimeHome ?? join(qaRoot, 'home'),
    PATH: [
      join(qaRoot, 'bin'),
      options.nodeBin,
      '/home/lixingxin/.local/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'),
    DSH_HOME: join(qaRoot, 'dsh-home'),
    DSH_TUI_SESSION_ROOT: join(qaRoot, 'sessions'),
    DSH_TUI_WORKSPACE_TARGET: join(qaRoot, 'workspace'),
    DSH_TELEMETRY_MODE: 'DISABLED',
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    QA_LOOPBACK_API_KEY: 'qa-only-token',
    QA_LOOPBACK_PORT: String(options.loopbackPort),
    QA_RTK: options.rtk,
    QA_CODEGRAPH: options.codegraph,
    QA_TS_LSP: options.typescriptLanguageServer,
    QA_GOPLS: options.gopls,
    QA_REAL_DSH: options.realDsh,
    QA_GO: options.go,
  }
}

export function writeQaEnvironment(qaRoot, environment) {
  const envFile = join(resolve(qaRoot), 'env.json')
  mkdirSync(dirname(envFile), { recursive: true })
  writeFileSync(envFile, `${JSON.stringify(environment, null, 2)}\n`, { mode: 0o600 })
  return envFile
}

export function readQaEnvironment(envFile) {
  const parsed = JSON.parse(readFileSync(envFile, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new QaEnvironmentError('env.json must contain an object')
  }
  const keys = Object.keys(parsed)
  const unexpected = keys.filter((key) => !ENVIRONMENT_KEYS.includes(key))
  const missing = ENVIRONMENT_KEYS.filter((key) => !keys.includes(key))
  if (unexpected.length > 0) {
    throw new QaEnvironmentError(`env.json contains unexpected keys: ${unexpected.join(', ')}`)
  }
  if (missing.length > 0) {
    throw new QaEnvironmentError(`env.json is missing keys: ${missing.join(', ')}`)
  }
  for (const key of ENVIRONMENT_KEYS) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new QaEnvironmentError(`env.json key must be a non-empty string: ${key}`)
    }
  }
  return Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, parsed[key]]))
}
