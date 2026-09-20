import { describe, expect, it, vi } from 'vitest'
import { resolveWorkspaceRoot } from '../workspace-root.js'

interface Target {
  readonly targetKey: string
  readonly displayPath: string
}

function target(path: string): Target {
  return { targetKey: path, displayPath: path }
}

function makeFs(entries: Record<string, 'file' | 'directory'>) {
  return {
    resolve: vi.fn(async (path: string) => target(path)),
    stat: vi.fn(async (value: Target) => {
      const type = entries[value.targetKey]
      return type === undefined ? undefined : { version: `v:${value.targetKey}`, type }
    }),
    contains: vi.fn((parent: Target, child: Target) => {
      return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`)
    }),
    processPath: vi.fn((value: Target) => value.targetKey),
  }
}

describe('resolveWorkspaceRoot', () => {
  it('uses a sibling git worktree root instead of the session cwd', async () => {
    const fs = makeFs({
      '/repo': 'directory',
      '/repo-worktree': 'directory',
      '/repo-worktree/.git': 'file',
    })

    const result = await resolveWorkspaceRoot({
      fs,
      target: target('/repo-worktree/service/a.go'),
      extension: '.go',
      sessionRoot: '/repo',
    })

    expect(result).toEqual(target('/repo-worktree'))
  })

  it('uses the nearest language project marker before the git worktree root', async () => {
    const fs = makeFs({
      '/repo-worktree': 'directory',
      '/repo-worktree/.git': 'file',
      '/repo-worktree/service': 'directory',
      '/repo-worktree/service/go.mod': 'file',
    })

    const result = await resolveWorkspaceRoot({
      fs,
      target: target('/repo-worktree/service/internal/a.go'),
      extension: '.go',
      sessionRoot: '/repo',
    })

    expect(result).toEqual(target('/repo-worktree/service'))
  })

  it('can restrict probing to git roots for automatic sibling-worktree feedback', async () => {
    const fs = makeFs({
      '/repo-worktree': 'directory',
      '/repo-worktree/.git': 'file',
      '/repo-worktree/service': 'directory',
      '/repo-worktree/service/go.mod': 'file',
    })

    const result = await resolveWorkspaceRoot({
      fs,
      target: target('/repo-worktree/service/internal/a.go'),
      extension: '.go',
      sessionRoot: '/repo',
      markerMode: 'git',
    })

    expect(result).toEqual(target('/repo-worktree'))
  })

  it('falls back to the session root only when it contains the target', async () => {
    const fs = makeFs({ '/repo': 'directory' })

    await expect(resolveWorkspaceRoot({
      fs,
      target: target('/repo/src/a.ts'),
      extension: '.ts',
      sessionRoot: '/repo',
    })).resolves.toEqual(target('/repo'))

    await expect(resolveWorkspaceRoot({
      fs,
      target: target('/outside/a.ts'),
      extension: '.ts',
      sessionRoot: '/repo',
    })).resolves.toBeUndefined()
  })
})
