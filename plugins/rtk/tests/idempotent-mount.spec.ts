import { describe, expect, it } from 'vitest'
import { createRtkShellHarness, installFakeRtkPathHooks } from './helpers.js'

const GREP_INPUT = 'alpha\nbeta\n\ncharlie\n'

type TextContent = { readonly type: 'text'; readonly text: string }
type PostToolDecision =
  | { readonly kind: 'accept'; readonly content?: readonly TextContent[] }
  | { readonly kind: 'block'; readonly feedback: readonly TextContent[] }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'tools/post-execute'(
      exec: { readonly name: string },
      result: { readonly content: readonly TextContent[] },
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
    const result = await shell.run(shell.resolve({ command: 'rewrite printf done' }))

    // Then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['bash', '-c', 'rtk rewrite printf done'])
    expect(result.stdout.text).toBe('rtk printf done\n')
    await Promise.all(mounts.map((mount) => mount.dispose()))
  })

  it('keeps the decoration until the last owner unmounts out of order', async () => {
    // Given
    process.env.FAKE_RTK_MODE = 'rewrite'
    const { shell, shellTarget, mounts, originalRun, originalStart } = await createRtkShellHarness({ mounts: 2 })
    const firstMount = mounts[0]
    const secondMount = mounts[1]
    if (firstMount === undefined || secondMount === undefined) {
      throw new TypeError('expected two rtk mounts')
    }

    // When
    await firstMount.dispose()
    const decorated = await shell.run(shell.resolve({ command: 'rewrite printf active' }))

    // Then
    expect(decorated.stdout.text).toBe('rtk printf active\n')

    // When
    await secondMount.dispose()

    // Then
    expect(shellTarget.run).toBe(originalRun)
    expect(shellTarget.start).toBe(originalStart)
    const restored = await shell.run(shell.resolve({ command: "printf 'restored\\n'" }))
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
