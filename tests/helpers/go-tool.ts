import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function goBuildStatus(
  source: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lsp-go-'))
  try {
    writeFileSync(join(dir, 'main.go'), source)
    const executable = environment.QA_GO ?? 'go'
    const result = spawnSync(executable, ['build', '.'], {
      cwd: dir,
      env: {
        ...environment,
        GO111MODULE: 'off',
        GOPATH: join(dir, 'gopath'),
        GOCACHE: join(dir, 'gocache'),
        GOFLAGS: '-mod=mod',
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error !== undefined) {
      throw new Error(result.error.message, { cause: result.error })
    }
    if (result.status === null) {
      throw new Error(
        `Go build terminated without status (signal=${result.signal ?? 'none'}): ${result.stderr}`,
      )
    }
    return result.status
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
