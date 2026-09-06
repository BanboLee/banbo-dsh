import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertIsolatedQaRoot,
  buildQaEnvironment,
  cleanupQaRuntimeHome,
  createQaLayout,
  readQaEnvironment,
  writeQaEnvironment,
} from '../../scripts/qa/lib/environment.mjs'

const roots: string[] = []
const runtimeHomes: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-env-'))
  roots.push(root)
  return root
}

describe('QA child environment', () => {
  afterEach(() => {
    delete process.env.C7_API_KEY
    for (const runtimeHome of runtimeHomes.splice(0)) cleanupQaRuntimeHome({ runtimeHome })
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('rejects repository and user-profile roots when isolation is checked', () => {
    // Given: paths that could mutate source or the operator profile.
    const repoRoot = resolve(import.meta.dirname, '..', '..')
    const userHome = '/home/qa-user'

    // When: the roots are checked for release-gate isolation.
    const repositoryCheck = () => assertIsolatedQaRoot(repoRoot, repoRoot, userHome)
    const profileCheck = () => assertIsolatedQaRoot(join(userHome, '.config', 'dsh'), repoRoot, userHome)

    // Then: neither unsafe root is accepted.
    expect(repositoryCheck).toThrow(/isolated/i)
    expect(profileCheck).toThrow(/isolated/i)
  })

  it('builds an allowlist without ambient credentials when a QA layout is supplied', () => {
    // Given: an isolated root and an ambient credential that must not cross the boundary.
    const qaRoot = temporaryRoot()
    process.env.C7_API_KEY = 'production-secret'

    // When: the child environment is constructed from explicit QA inputs.
    const environment = buildQaEnvironment({
      qaRoot,
      nodeBin: '/opt/node26/bin',
      codegraph: '/home/qa-user/.codegraph/versions/v1.6.0/bin/codegraph',
      rtk: '/opt/qa/rtk',
      typescriptLanguageServer: '/opt/qa/typescript-language-server',
      gopls: '/opt/qa/gopls',
      realDsh: '/opt/node26/bin/dsh',
      go: '/opt/go/bin/go',
      loopbackPort: 43123,
    })

    // Then: only approved keys exist and the production credential is absent.
    expect(Object.keys(environment).sort()).toEqual([
      'CODEGRAPH_NO_UPDATE_CHECK',
      'DO_NOT_TRACK',
      'DSH_HOME',
      'DSH_TELEMETRY_MODE',
      'DSH_TUI_SESSION_ROOT',
      'DSH_TUI_WORKSPACE_TARGET',
      'HOME',
      'PATH',
      'QA_CODEGRAPH',
      'QA_GO',
      'QA_GOPLS',
      'QA_LOOPBACK_API_KEY',
      'QA_LOOPBACK_PORT',
      'QA_REAL_DSH',
      'QA_RTK',
      'QA_TS_LSP',
    ])
    expect(environment).not.toHaveProperty('C7_API_KEY')
    expect(environment.DSH_HOME).toBe(join(qaRoot, 'dsh-home'))
  })

  it('creates only QA-owned directories when an isolated root is prepared', () => {
    // Given: a fresh OS-temporary QA root.
    const qaRoot = temporaryRoot()

    // When: the isolated profile layout is created.
    const layout = createQaLayout(qaRoot)
    runtimeHomes.push(layout.runtimeHome)

    // Then: every mutable path remains under that root.
    expect(layout.root).toBe(qaRoot)
    expect(layout.home).toBe(join(qaRoot, 'home'))
    expect(layout.runtimeHome).toBe(join(tmpdir(), `dsh-tui-qa-${layout.runtimeName}`))
    expect(layout.dshHome).toBe(join(qaRoot, 'dsh-home'))
    expect(layout.sessionRoot).toBe(join(qaRoot, 'sessions'))
    expect(layout.workspace).toBe(join(qaRoot, 'workspace'))
    expect(layout.bin).toBe(join(qaRoot, 'bin'))
    expect(layout.packs).toBe(join(qaRoot, 'packs'))
    expect(layout.evidence).toBe(join(qaRoot, 'evidence'))
    expect(lstatSync(layout.runtimeHome).isSymbolicLink()).toBe(true)
    expect(realpathSync(layout.runtimeHome)).toBe(realpathSync(layout.home))
    expect(layout.runtimeHome.length).toBeLessThan(60)
  })

  it('round-trips a validated env.json when only allowlisted values are persisted', () => {
    // Given: an explicit QA environment.
    const qaRoot = temporaryRoot()
    const environment = buildQaEnvironment({
      qaRoot,
      nodeBin: '/opt/node26/bin',
      codegraph: '/home/qa-user/.codegraph/versions/v1.6.0/bin/codegraph',
      rtk: '/opt/qa/rtk',
      typescriptLanguageServer: '/opt/qa/typescript-language-server',
      gopls: '/opt/qa/gopls',
      realDsh: '/opt/node26/bin/dsh',
      go: '/opt/go/bin/go',
      loopbackPort: 43124,
    })

    // When: the environment is written and read through the file boundary.
    const envFile = writeQaEnvironment(qaRoot, environment)
    const loaded = readQaEnvironment(envFile)

    // Then: the parsed child environment equals the allowlist and contains no serialized secret source.
    expect(loaded).toEqual(environment)
    expect(readFileSync(envFile, 'utf8')).not.toContain('production-secret')
  })

  it('rejects unknown keys when env.json is parsed', () => {
    // Given: an allowlisted environment polluted with an external API credential.
    const qaRoot = temporaryRoot()
    const environment = {
      ...buildQaEnvironment({
        qaRoot,
        nodeBin: '/opt/node26/bin',
        codegraph: '/home/qa-user/.codegraph/versions/v1.6.0/bin/codegraph',
        rtk: '/opt/qa/rtk',
        typescriptLanguageServer: '/opt/qa/typescript-language-server',
        gopls: '/opt/qa/gopls',
        realDsh: '/opt/node26/bin/dsh',
        go: '/opt/go/bin/go',
        loopbackPort: 43125,
      }),
      OPENAI_API_KEY: 'forbidden',
    }
    const envFile = join(qaRoot, 'env.json')
    writeFileSync(envFile, JSON.stringify(environment))

    // When: the child environment file is parsed.
    const load = () => readQaEnvironment(envFile)

    // Then: the unexpected key blocks execution.
    expect(load).toThrow(/OPENAI_API_KEY/)
  })
})
