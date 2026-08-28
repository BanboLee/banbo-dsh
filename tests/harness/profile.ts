import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { createIsolatedProfile } from '../helpers/profile'

describe('createIsolatedProfile', () => {
  it('creates a temp dshHome and profile under the OS temp dir and cleans them up', async () => {
    const { dshHome, profile, cleanup } = createIsolatedProfile('harness-profile-test')
    expect(dshHome.startsWith(tmpdir())).toBe(true)
    expect(profile.startsWith(dshHome)).toBe(true)
    expect(existsSync(dshHome)).toBe(true)
    expect(existsSync(profile)).toBe(true)
    await cleanup()
    expect(existsSync(dshHome)).toBe(false)
  })

  it('cleanup is idempotent', async () => {
    const { dshHome, cleanup } = createIsolatedProfile('harness-profile-idempotent')
    await cleanup()
    await cleanup()
    expect(existsSync(dshHome)).toBe(false)
  })
})
