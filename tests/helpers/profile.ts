import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface IsolatedProfile {
  /** Fresh temporary DSH home directory, never the real user DSH home. */
  dshHome: string
  /** Profile directory inside `dshHome`, ready for DSH profile state. */
  profile: string
  /** Remove the whole temporary tree. Idempotent. */
  cleanup(): Promise<void>
}

/**
 * Create a throwaway DSH home + profile under the OS temp directory.
 * Never reads or writes the real user DSH home (`$DSH_HOME` or `~/.dsh`).
 * Consumers must set `DSH_HOME`/PATH from the returned paths themselves.
 */
export function createIsolatedProfile(testName: string): IsolatedProfile {
  const safeName = testName.replace(/[^A-Za-z0-9._-]/g, '-')
  const dshHome = mkdtempSync(join(tmpdir(), `dsh-${safeName}-`))
  const profile = join(dshHome, 'profiles', safeName)
  mkdirSync(profile, { recursive: true })

  let cleaned = false
  return {
    dshHome,
    profile,
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      rmSync(dshHome, { recursive: true, force: true })
    },
  }
}
