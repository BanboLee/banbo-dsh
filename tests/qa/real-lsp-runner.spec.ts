import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const runner = join(repoRoot, 'scripts', 'qa', 'run-lsp-real-servers.mjs')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('explicit real LSP runner', () => {
  it('exits nonzero and writes blocked evidence when a requested executable is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-real-lsp-runner-'))
    tempDirs.push(dir)
    const evidencePath = join(dir, 'evidence.json')

    const result = spawnSync(process.execPath, [
      runner,
      '--providers', 'clangd',
      '--clangd-command', join(dir, 'missing-clangd'),
      '--evidence', evidencePath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
      enabled: true,
      requestedProviders: ['clangd'],
      results: [{
        provider: 'clangd',
        status: 'blocked',
        diagnosticObserved: false,
        cleanObserved: false,
        directDiagnosticObserved: false,
        directNoDiagnosticsObserved: false,
      }],
    })
  }, 30_000)
})
