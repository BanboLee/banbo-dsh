import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { goBuildStatus } from '../helpers/go-tool'

const fixedGo = 'package main\nvar x string = "1"\nfunc main() {}\n'
const brokenGo = 'package main\nvar x string = 1\nfunc main() {}\n'

function installedGo(): string {
  const resolved = spawnSync('which', ['go'], { encoding: 'utf8' })
  if (resolved.status !== 0) throw new Error(`test requires Go: ${resolved.stderr}`)
  return resolved.stdout.trim()
}

describe('isolated Go build probe', () => {
  it('uses explicit QA_GO when sanitized PATH does not contain Go', () => {
    // Given: the real Go binary and a child PATH with no Go installation.
    const environment = {
      ...process.env,
      PATH: '/usr/bin:/bin',
      QA_GO: installedGo(),
    }

    // When: valid and invalid fixtures are compiled in isolated caches.
    const fixed = goBuildStatus(fixedGo, environment)
    const broken = goBuildStatus(brokenGo, environment)

    // Then: the real compiler proves the clean transition.
    expect(fixed).toBe(0)
    expect(broken).not.toBe(0)
  }, 30_000)

  it('reports an actionable spawn failure when no Go executable is available', () => {
    // Given: neither QA_GO nor PATH can resolve a Go executable. Use a PATH
    // that cannot contain go on any machine (GitHub ubuntu-latest images
    // ship /usr/bin/go, so a plain /usr/bin:/bin PATH resolves one there).
    const environment: Record<string, string | undefined> = { ...process.env, PATH: '/no-go-toolchain' }
    delete environment.QA_GO

    // When: the probe attempts to compile.
    const compile = () => goBuildStatus(fixedGo, environment)

    // Then: ENOENT is surfaced instead of becoming an opaque -1 status.
    expect(compile).toThrow(/spawnSync go ENOENT/)
  })
})
