import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')

const requiredArtifacts = [
  'docs/dsh-tui-qa-version-matrix.json',
  'scripts/qa/validate-dsh-tui-graph.mjs',
  'scripts/qa/run-dsh-tui-pty.mjs',
  'scripts/qa/run-dsh-tui-real.mjs',
  'scripts/qa/run-dsh-tui-upgrade.mjs',
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

  it('declares the exact approved version matrix when the QA matrix is loaded', () => {
    // Given: the checked-in matrix file.
    // When: its machine-consumed JSON is parsed.
    const matrix = JSON.parse(
      readFileSync(resolve(repoRoot, 'docs/dsh-tui-qa-version-matrix.json'), 'utf8'),
    )

    // Then: every target runtime and bundle version is pinned.
    expect(matrix).toEqual({
      nodeMajor: 26,
      dsh: '0.1.2-rc.1',
      dshTui: '0.10.0-beta.5',
      cordis: '4.0.2',
      piAi: '0.84.4',
      bundles: {
        'dsh-fish-shell': '0.4.0',
        'dsh-rtk': '0.1.0',
        'dsh-codegraph-mcp': '0.1.0',
        'dsh-llm-pi-ai-with-session': '0.1.0',
        'dsh-lsp-diagnostics': '0.1.0',
      },
    })
  })

  it('pins matrix piAi to the exact version the lockfile resolves for the session plugin', () => {
    // Given: the checked-in matrix file and the workspace lockfile.
    const matrix: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, 'docs/dsh-tui-qa-version-matrix.json'), 'utf8'),
    )
    if (typeof matrix !== 'object' || matrix === null) throw new TypeError('matrix is not an object')
    const piAi = (matrix as Record<string, unknown>).piAi
    const lock = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8')

    // When: the resolved pi-ai version for the session plugin importer is extracted.
    const resolved = lockfileResolvedVersion(lock, 'plugins/dsh-llm-pi-ai-with-session', '@earendil-works/pi-ai')

    // Then: the matrix pins the exact version the lockfile resolves, never a
    // range base that the resolver has moved past.
    expect(piAi, 'matrix piAi must be the exact lockfile-resolved version').toBe(resolved)
  })
})

function lockfileResolvedVersion(lock: string, importer: string, dependency: string): string | undefined {
  // Given: a pnpm-lock.yaml importer block such as `  plugins/dsh-llm-pi-ai-with-session:`.
  // When: the dependency key and its `version:` line are located inside that block.
  const lines = lock.split('\n')
  const start = lines.findIndex((line) => line === `  ${importer}:`)
  if (start === -1) return undefined
  let inDependencySection = false
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    if (/^  \S/.test(line) || /^\S/.test(line)) break
    if (/^    (dependencies|devDependencies|optionalDependencies):$/.test(line)) {
      inDependencySection = true
      continue
    }
    if (!inDependencySection) continue
    if (/^      '.*':$/.test(line) && line !== `      '${dependency}':`) continue
    if (line === `      '${dependency}':`) {
      // Then: the following `version:` line carries the exact resolved version.
      const versionLine = [lines[index + 1], lines[index + 2]].find((line) => /^        version: /.test(line ?? ''))
      const versionMatch = /^        version: ([^(@ ]+)/.exec(versionLine ?? '')
      return versionMatch?.[1]
    }
  }
  return undefined
}
