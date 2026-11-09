import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { BUNDLES } from '../../scripts/qa/lib/profile.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')

const requiredArtifacts = [
  'scripts/qa/validate-dsh-tui-graph.mjs',
  'scripts/qa/run-dsh-tui-pty.mjs',
  'scripts/qa/run-dsh-tui-real.mjs',
  'scripts/qa/run-lsp-real-servers.mjs',
  'scripts/qa/run-dsh-tui-upgrade.mjs',
  'scripts/qa/matrices/dsh-0.2.2-rc.1_tui-0.19.0.json',
  'scripts/qa/fixtures/loopback-openai-sse.mjs',
  'scripts/qa/fixtures/dsh-tui-qa-settings.yaml',
  'scripts/qa/fixtures/dsh-tui-qa.patch.yml',
] as const

describe('dsh-tui QA deliverables', () => {
  it('pins the active matrix to the four maintained manifests', () => {
    const matrix = JSON.parse(readFileSync(resolve(repoRoot, requiredArtifacts[5]), 'utf8'))
    expect(matrix.dsh).toBe('0.2.2-rc.1')
    expect(matrix.dshTui).toBe('0.19.0')
    expect(matrix.bundles).toEqual(Object.fromEntries(BUNDLES.map(([directory, name]) => {
      const manifest = JSON.parse(readFileSync(resolve(repoRoot, directory, 'package.json'), 'utf8'))
      return [name, manifest.version]
    })))
  })

  it('uses the official loopback provider without deprecated plugin rows', () => {
    const settings = parse(readFileSync(resolve(repoRoot, 'scripts/qa/fixtures/dsh-tui-qa-settings.yaml'), 'utf8'))
    expect(settings['agent-default-model'].provider).toBe('qa-loopback')
    const patch = parse(readFileSync(resolve(repoRoot, 'scripts/qa/fixtures/dsh-tui-qa.patch.yml'), 'utf8'))
    const rowIds = patch.map((row: { id: string }) => row.id)
    expect(rowIds).not.toContain('mcp-codegraph')
    expect(rowIds).not.toContain('llm-pi-ai-with-session')
  })

  it('checks in every G4-G6 artifact when the release gate is enabled', () => {
    // Given: the approved real-run plan's required artifact list.
    // When: each repository-relative artifact is resolved.
    const missing = requiredArtifacts.filter((path) => !existsSync(resolve(repoRoot, path)))

    // Then: the gate has no missing implementation artifact.
    expect(missing).toEqual([])
  })
})
