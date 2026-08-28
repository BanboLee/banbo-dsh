import { describe, expect, it } from 'vitest'
import { configDefaults } from 'vitest/config'
import config from '../vitest.config'

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
})
