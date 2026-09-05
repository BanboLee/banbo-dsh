import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_VERSION = '0.1.2-rc.1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectDshVersions(value: unknown, result = new Map<string, Set<string>>()): ReadonlyMap<string, Set<string>> {
  if (Array.isArray(value)) {
    for (const item of value) collectDshVersions(item, result)
    return result
  }
  if (!isRecord(value)) return result

  for (const section of ['dependencies', 'devDependencies'] as const) {
    const dependencies = value[section]
    if (!isRecord(dependencies)) continue
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-') && isRecord(dependency) && typeof dependency.version === 'string') {
        const versions = result.get(name) ?? new Set<string>()
        versions.add(dependency.version)
        result.set(name, versions)
      }
      collectDshVersions(dependency, result)
    }
  }
  return result
}

describe('fish-shell installed dependency graph', () => {
  it('resolves sandbox and LLM packages from the coherent 0.1.2-rc.1 family', () => {
    // Given the real installed dependency chain rooted at dsh-fish-shell
    const listed = spawnSync('pnpm', ['list', '--filter', 'dsh-fish-shell', '--depth=8', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(listed.status, listed.stderr).toBe(0)

    // When every @deepseek-ai/dsh package version on that chain is collected
    const graph: unknown = JSON.parse(listed.stdout)
    const versions = collectDshVersions(graph)

    // Then the formerly incompatible sandbox/LLM pair and the full family are rc.1
    expect(versions.get('@deepseek-ai/dsh-sandbox')).toEqual(new Set([DSH_VERSION]))
    expect(versions.get('@deepseek-ai/dsh-llm')).toEqual(new Set([DSH_VERSION]))
    for (const [name, resolved] of versions) {
      expect([...resolved], `${name} must stay in the ${DSH_VERSION} family`).toEqual([DSH_VERSION])
    }
  })
})
