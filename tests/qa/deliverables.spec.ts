import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')

const requiredArtifacts = [
  'scripts/qa/validate-dsh-tui-graph.mjs',
  'scripts/qa/run-dsh-tui-pty.mjs',
  'scripts/qa/run-dsh-tui-real.mjs',
  'scripts/qa/run-lsp-real-servers.mjs',
  'scripts/qa/run-dsh-tui-upgrade.mjs',
  'scripts/qa/matrices/dsh-0.2.1-rc.5_tui-0.18.0.json',
  'scripts/qa/fixtures/loopback-openai-sse.mjs',
  'scripts/qa/fixtures/dsh-tui-qa-settings.yaml',
  'scripts/qa/fixtures/dsh-tui-qa.patch.yml',
] as const

describe('dsh-tui QA deliverables', () => {
  it('checks in every G4-G6 artifact when the release gate is enabled', () => {
    // Given: the approved real-run plan's required artifact list.
    // When: each repository-relative artifact is resolved.
    const missing = requiredArtifacts.filter((path) => !existsSync(resolve(repoRoot, path)))

    // Then: the gate has no missing implementation artifact.
    expect(missing).toEqual([])
  })
})
