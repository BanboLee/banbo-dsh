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
