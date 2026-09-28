import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configDefaults } from 'vitest/config'
import config from '../vitest.config'
import compositionConfig from '../vitest.composition.config'

const rootManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { scripts?: Record<string, string> }

describe('vitest discovery guard (Task-8 F5-fix)', () => {
  it('excludes the ignored .omo evidence tree from full-suite test discovery', () => {
    const exclude = config.test?.exclude ?? []
    expect(exclude).toContain('**/.omo/**')
  })

  it('preserves every framework-native default exclude when extending', () => {
    const exclude = config.test?.exclude ?? []
    for (const pattern of configDefaults.exclude) {
      expect(exclude).toContain(pattern)
    }
  })

  it('keeps the composition suite out of `pnpm test`, with its own lane to run it', () => {
    // It boots real isolated DSH profiles and real subprocesses, so it competes
    // with the unit suite and buries its own signal. Moving it is only safe
    // while a lane still runs it — hence both halves of this assertion.
    expect(config.test?.exclude ?? []).toContain('tests/composition/**')
    expect(rootManifest.scripts?.['test:composition']).toContain('tests/composition')
  })

  it('gives the composition lane a config that actually lifts the exclusion', () => {
    // vitest applies `exclude` to explicitly named paths too, so running the
    // suite under the default config matches nothing and exits 1 — the lane
    // needs its own config, and that config must not inherit the pattern.
    expect(rootManifest.scripts?.['test:composition']).toContain('--config vitest.composition.config.ts')
    expect(existsSync(fileURLToPath(new URL('../vitest.composition.config.ts', import.meta.url)))).toBe(true)
    expect(compositionConfig.test?.exclude ?? []).not.toContain('tests/composition/**')
    expect(compositionConfig.test?.fileParallelism).toBe(false)
  })
})

const REAL_E2E_SPECS = [
  'headless-real.spec.ts',
  'headless-real-rtk.spec.ts',
  'headless-real-codegraph.spec.ts',
  'headless-real-fish.spec.ts',
  'headless-real-permutations.spec.ts',
] as const

/**
 * The real headless lane boots real DSH profiles against the real rtk and
 * codegraph CLIs, which cannot live in the deterministic pipeline. These
 * assertions are what keeps it from being deleted silently: it stays
 * discoverable but inert in `pnpm test`, keeps a lane that turns the gate on,
 * keeps the two pinned third-party paths, and keeps both the manual CI job and
 * the AGENTS.md instructions that make it runnable.
 */
describe('real headless e2e lane guard', () => {
  it('keeps the real lane discoverable but inert inside `pnpm test`', () => {
    expect(config.test?.exclude ?? []).not.toContain('tests/e2e/**')
    for (const spec of REAL_E2E_SPECS) {
      const source = readFileSync(fileURLToPath(new URL(`./e2e/${spec}`, import.meta.url)), 'utf8')
      expect(source, `${spec} must gate on RUN_REAL_HEADLESS_E2E`).toContain(
        "process.env.RUN_REAL_HEADLESS_E2E === '1'",
      )
      expect(source, `${spec} must skip without the gate`).toContain('describe.skip')
    }
  })

  it('keeps a lane script that sets the gate and names the suite', () => {
    expect(rootManifest.scripts?.['test:e2e:headless']).toContain('RUN_REAL_HEADLESS_E2E=1')
    expect(rootManifest.scripts?.['test:e2e:headless']).toContain('tests/e2e')
  })

  it('pins the two third-party sibling binaries the lane refuses to run without', () => {
    // The lane resolves these beside the repository and asserts their realpath,
    // so the CI provisioning in the job below has exactly one place to land.
    const runtime = readFileSync(fileURLToPath(new URL('./e2e/headless-real-runtime.ts', import.meta.url)), 'utf8')
    expect(runtime).toContain("'target', 'release', 'rtk'")
    expect(runtime).toContain("'dist', 'bin', 'codegraph.js'")
  })

  it('keeps the manual CI job that provisions those binaries', () => {
    const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
    expect(ci).toContain('workflow_dispatch')
    expect(ci).toContain('real-e2e:')
    expect(ci).toContain('../rtk/target/release/rtk')
    expect(ci).toContain('../codegraph/dist/bin/codegraph.js')
    expect(ci).toContain('pnpm test:e2e:headless')
  })

  it('documents how to run the lane (AGENTS.md)', () => {
    const agents = readFileSync(fileURLToPath(new URL('../AGENTS.md', import.meta.url)), 'utf8')
    expect(agents).toContain('test:e2e:headless')
    expect(agents).toContain('RUN_REAL_HEADLESS_E2E')
  })
})
