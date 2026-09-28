import { describe, expect, it } from 'vitest'
import type { PostExecuteExecution, PostExecuteResult, PostToolDecision } from '../grep-compress.js'
import { createRtkShellHarness, installFakeRtkPathHooks, runForeground } from './helpers.js'

const GREP_INPUT = 'alpha\nbeta\n\ncharlie\n'

// This plugin deliberately does not depend on `@deepseek-ai/dsh-tools`, so the
// `tools/post-execute` contract it registers against is declared here as the
// mirror of that package's 0.1.7-rc.2 event, using the exact shapes
// `createGrepPostExecuteListener` is typed against.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'tools/post-execute'(
      exec: PostExecuteExecution,
      result: PostExecuteResult,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision>
  }
}

installFakeRtkPathHooks()

describe('duplicate mounts', () => {
  it('consults the rewrite oracle exactly once for one command', async () => {
    // Given
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell, calls, mounts } = await createRtkShellHarness({ mounts: 2 })

    // When
    const result = await runForeground(shell, shell.resolve({ command: 'rewrite printf done' }))

    // Then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk rewrite printf done'])
    expect(result.stdout.text).toBe('rtk printf done\n')
    await Promise.all(mounts.map((mount) => mount.dispose()))
  })

  it('keeps the decoration until the last owner unmounts out of order', async () => {
    // Given
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell, shellTarget, mounts, originalExecute } = await createRtkShellHarness({ mounts: 2 })
    const firstMount = mounts[0]
    const secondMount = mounts[1]
    if (firstMount === undefined || secondMount === undefined) {
      throw new TypeError('expected two rtk mounts')
    }

    // When
    await firstMount.dispose()
    const decorated = await runForeground(shell, shell.resolve({ command: 'rewrite printf active' }))

    // Then
    expect(decorated.stdout.text).toBe('rtk printf active\n')

    // When
    await secondMount.dispose()

    // Then
    expect(shellTarget.execute).toBe(originalExecute)
    const restored = await runForeground(shell, shell.resolve({ command: "printf 'restored\\n'" }))
    expect(restored.stdout.text).toBe('restored\n')
  })

  it('compresses one grep tool result exactly once', async () => {
    // Given
    process.env.FAKE_RTK_PIPE_MODE = 'compress'
    const { ctx, mounts } = await createRtkShellHarness({ mounts: 2 })
    const result = {
      isError: false as const,
      value: { matches: [] },
      content: [{ type: 'text' as const, text: GREP_INPUT }],
    }

    // When
    const decision = await ctx.waterfall(
      'tools/post-execute',
      { name: 'grep' },
      result,
      () => Promise.resolve({ kind: 'accept' as const }),
    )

    // Then
    expect(decision).toEqual({
      kind: 'accept',
      content: [{ type: 'text', text: '[fake-rtk pipe -f grep] compressed 3 lines\n' }],
    })
    await Promise.all(mounts.map((mount) => mount.dispose()))
  })
})
