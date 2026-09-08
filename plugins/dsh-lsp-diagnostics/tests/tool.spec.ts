import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticsTool } from '../tool.js'
import { DEFAULT_CONFIG } from './helpers.js'

const WORKSPACE = { targetKey: 'workspace', displayPath: '/workspace' }
const TARGET = { targetKey: 'target', displayPath: '/workspace/src/a.ts' }
const WORKSPACE_INFO = { version: 'workspace-v1', type: 'directory' }
const TARGET_INFO = { version: 'target-v1', type: 'file', size: 12 }

const DIAGNOSTIC = {
  uri: 'file:///workspace/src/a.ts',
  range: {
    start: { line: 12, character: 4 },
    end: { line: 12, character: 9 },
  },
  severity: 'error',
  severityRank: 0,
  code: 'TS2322',
  source: 'typescript',
  message: "Type 'string' is not assignable to type 'number'.",
} as const

type ToolOwner = ReturnType<typeof createDiagnosticsTool>
type Tool = ToolOwner['definition']
type Exec = Parameters<Tool['execute']>[1]

interface FakeFs {
  resolve: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  contains: ReturnType<typeof vi.fn>
  fileUrl: ReturnType<typeof vi.fn>
}

interface FakeRuntime {
  diagnoseTarget: ReturnType<typeof vi.fn>
}

function execution(signal = new AbortController().signal, cwd: string | null = '/workspace'): Exec {
  const agent = cwd === null ? { session: { header: {} } } : { session: { header: { cwd } } }
  return { signal, agent } as unknown as Exec
}

function makeFs(options: {
  workspaceInfo?: unknown
  targetInfos?: unknown[]
  contained?: boolean
  uri?: string
} = {}): FakeFs {
  const targetInfos = [...(options.targetInfos ?? [TARGET_INFO, TARGET_INFO])]
  return {
    resolve: vi.fn(async (path: string, opts?: { cwd?: string; signal?: AbortSignal }) => {
      if (path === '/workspace' && opts?.cwd === undefined) return WORKSPACE
      return TARGET
    }),
    stat: vi.fn(async (target: unknown) => {
      if (target === WORKSPACE) {
        return Object.prototype.hasOwnProperty.call(options, 'workspaceInfo')
          ? options.workspaceInfo
          : WORKSPACE_INFO
      }
      return targetInfos.shift()
    }),
    contains: vi.fn(() => options.contained ?? true),
    fileUrl: vi.fn(() => options.uri ?? 'file:///workspace/src/a.ts'),
  }
}

function makeRuntime(outcome: unknown = { kind: 'ok', diagnostics: [DIAGNOSTIC], uri: DIAGNOSTIC.uri, version: 1 }): FakeRuntime {
  return { diagnoseTarget: vi.fn(async () => outcome) }
}

function makeTool(options: {
  fs?: FakeFs
  runtime?: FakeRuntime
  config?: Record<string, unknown>
} = {}): { owner: ToolOwner; tool: Tool; fs: FakeFs; runtime: FakeRuntime } {
  const fs = options.fs ?? makeFs()
  const runtime = options.runtime ?? makeRuntime()
  const config = options.config ?? structuredClone(DEFAULT_CONFIG)
  const owner = createDiagnosticsTool({ fs, runtime, config } as Parameters<typeof createDiagnosticsTool>[0])
  return { owner, tool: owner.definition, fs, runtime }
}

function rendered(tool: Tool, args: unknown, value: unknown): string {
  const blocks = tool.output.render(args, value as never)
  expect(blocks).toHaveLength(1)
  expect(blocks[0]).toMatchObject({ type: 'text' })
  return (blocks[0] as { type: 'text'; text: string }).text
}

afterEach(() => {
  vi.useRealTimers()
})

describe('lsp_diagnostics tool definition', () => {
  it('defines one required file_path argument and rejects an empty path', async () => {
    const { tool, fs } = makeTool()

    expect(tool.name).toBe('lsp_diagnostics')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['file_path'],
      properties: { file_path: { type: 'string' } },
    })
    await expect(tool.execute({ file_path: '   ' }, execution())).rejects.toThrow(
      'file_path must be a non-empty string',
    )
    expect(fs.resolve).not.toHaveBeenCalled()
  })

  it('returns the strict canonical diagnostics projection and forwards the operation signal', async () => {
    const { tool, fs, runtime } = makeTool()
    const caller = new AbortController()

    const result = await tool.execute({ file_path: 'src/a.ts' }, execution(caller.signal))

    expect(fs.resolve).toHaveBeenNthCalledWith(1, '/workspace', { signal: expect.any(AbortSignal) })
    expect(fs.resolve).toHaveBeenNthCalledWith(2, 'src/a.ts', {
      cwd: '/workspace',
      signal: expect.any(AbortSignal),
    })
    const operationSignal = runtime.diagnoseTarget.mock.calls[0]?.[3]
    expect(operationSignal).toBeInstanceOf(AbortSignal)
    expect(operationSignal).not.toBe(caller.signal)
    expect(runtime.diagnoseTarget).toHaveBeenCalledWith(
      TARGET,
      WORKSPACE,
      'file:///workspace/src/a.ts',
      operationSignal,
      'target-v1',
    )
    expect(result).toEqual({
      kind: 'diagnostics',
      file_path: '/workspace/src/a.ts',
      diagnostics: [{
        range: DIAGNOSTIC.range,
        severity: 'error',
        code: 'TS2322',
        source: 'typescript',
        message: "Type 'string' is not assignable to type 'number'.",
      }],
    })
  })

  it('returns no_diagnostics and never renders an empty result as clean', async () => {
    const { tool } = makeTool({ runtime: makeRuntime({ kind: 'ok', diagnostics: [], uri: DIAGNOSTIC.uri, version: 1 }) })

    const result = await tool.execute({ file_path: 'src/a.ts' }, execution())
    const text = rendered(tool, { file_path: 'src/a.ts' }, result)

    expect(result).toEqual({ kind: 'no_diagnostics', file_path: '/workspace/src/a.ts' })
    expect(text).toContain(
      '[LSP diagnostics]\nFile: /workspace/src/a.ts\nNo diagnostics reported for this file snapshot.',
    )
    expect(text.toLowerCase()).not.toContain('clean')
  })

  it('uses the sanitized resolved display path as canonical file identity', async () => {
    const fs = makeFs()
    fs.resolve.mockImplementation(async (path: string, opts?: { cwd?: string }) => {
      if (path === '/workspace' && opts?.cwd === undefined) return WORKSPACE
      return { ...TARGET, displayPath: '/workspace/src/a\n.ts' }
    })
    const { tool } = makeTool({
      fs,
      runtime: makeRuntime({ kind: 'ok', diagnostics: [], uri: DIAGNOSTIC.uri, version: 1 }),
    })

    const result = await tool.execute({ file_path: 'src/a.ts' }, execution())

    expect(result).toEqual({ kind: 'no_diagnostics', file_path: '/workspace/src/a .ts' })
    expect(rendered(tool, { file_path: 'src/a.ts' }, result)).toContain('File: /workspace/src/a .ts')
  })

  it('preserves closed runtime unavailable reasons in canonical output', async () => {
    const { tool } = makeTool({ runtime: makeRuntime({ kind: 'unavailable', reason: 'server crashed' }) })

    const result = await tool.execute({ file_path: 'src/a.ts' }, execution())

    expect(result).toEqual({
      kind: 'unavailable',
      file_path: '/workspace/src/a.ts',
      reason: 'server crashed',
    })
    expect(rendered(tool, { file_path: 'src/a.ts' }, result)).toContain(
      'Diagnostics unavailable (server crashed).',
    )
  })

  it('renders one-based ranges with both configured bounds', () => {
    const config = { ...structuredClone(DEFAULT_CONFIG), maxDiagnostics: 1, maxResultChars: 1_000 }
    const { tool } = makeTool({ config })
    const value = {
      kind: 'diagnostics',
      file_path: '/workspace/src/a.ts',
      diagnostics: [
        {
          range: DIAGNOSTIC.range,
          severity: DIAGNOSTIC.severity,
          code: DIAGNOSTIC.code,
          source: DIAGNOSTIC.source,
          message: DIAGNOSTIC.message,
        },
        {
          range: { start: { line: 20, character: 1 }, end: { line: 20, character: 2 } },
          severity: 'warning',
          code: 'TS2',
          source: 'typescript',
          message: 'second',
        },
      ],
    }

    const text = rendered(tool, { file_path: 'src/a.ts' }, value)

    expect(text).toContain('error 13:5-13:10')
    expect(text).toContain('1 more diagnostic omitted')
    expect(text).not.toContain('second')
    expect(Array.from(text).length).toBeLessThanOrEqual(1_000)

    const capped = makeTool({ config: { ...config, maxResultChars: 24 } }).tool
    expect(Array.from(rendered(capped, { file_path: 'src/a.ts' }, value)).length).toBeLessThanOrEqual(24)
  })
})

describe('lsp_diagnostics eligibility and freshness', () => {
  it('requires a non-empty session workspace cwd before filesystem work', async () => {
    for (const cwd of [null, '', '   ']) {
      const { tool, fs } = makeTool()
      await expect(tool.execute({ file_path: 'src/a.ts' }, execution(undefined, cwd))).rejects.toThrow(
        'requires a session workspace cwd',
      )
      expect(fs.resolve).not.toHaveBeenCalled()
    }
  })

  it('throws useful errors for a missing or non-directory workspace', async () => {
    for (const workspaceInfo of [undefined, { version: 'w1', type: 'file' }]) {
      const fs = makeFs({ workspaceInfo })
      const { tool } = makeTool({ fs })
      await expect(tool.execute({ file_path: 'src/a.ts' }, execution())).rejects.toThrow(
        'workspace is not an existing directory',
      )
    }
  })

  it('throws useful errors for a missing or non-file target', async () => {
    for (const targetInfo of [undefined, { version: 'v1', type: 'directory' }]) {
      const fs = makeFs({ targetInfos: [targetInfo] })
      const { tool, runtime } = makeTool({ fs })
      await expect(tool.execute({ file_path: 'src/a.ts' }, execution())).rejects.toThrow(
        targetInfo === undefined ? 'target does not exist' : 'target is not a regular file',
      )
      expect(runtime.diagnoseTarget).not.toHaveBeenCalled()
    }
  })

  it('rejects targets outside the canonical workspace before target metadata I/O', async () => {
    const fs = makeFs({ contained: false })
    const { tool, runtime } = makeTool({ fs })

    await expect(tool.execute({ file_path: '../outside.ts' }, execution())).rejects.toThrow(
      'target is outside the session workspace',
    )
    expect(fs.stat).toHaveBeenCalledTimes(1)
    expect(fs.stat).toHaveBeenCalledWith(WORKSPACE, expect.any(AbortSignal))
    expect(runtime.diagnoseTarget).not.toHaveBeenCalled()
  })

  it('rejects an extension with no configured provider route', async () => {
    const { tool, runtime } = makeTool({ fs: makeFs({ uri: 'file:///workspace/src/a.js' }) })

    await expect(tool.execute({ file_path: 'src/a.js' }, execution())).rejects.toThrow(
      'no configured diagnostics provider for extension .js',
    )
    expect(runtime.diagnoseTarget).not.toHaveBeenCalled()
  })

  it('uses configured extension routes without language-specific branching', async () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      servers: {
        custom: {
          command: 'custom-lsp',
          args: [],
          env: {},
          configuration: {},
          initializationOptions: null,
          extensionToLanguage: { '.foo': 'custom' },
        },
      },
    }
    const { tool, runtime } = makeTool({ config, fs: makeFs({ uri: 'file:///workspace/src/a.foo' }) })

    await expect(tool.execute({ file_path: 'src/a.foo' }, execution())).resolves.toMatchObject({
      kind: 'diagnostics',
    })
    expect(runtime.diagnoseTarget).toHaveBeenCalledOnce()
  })

  it('throws instead of returning diagnostics when the FsVersion changes during diagnosis', async () => {
    const fs = makeFs({
      targetInfos: [TARGET_INFO, { ...TARGET_INFO, version: 'target-v2' }],
    })
    const { tool } = makeTool({ fs })

    await expect(tool.execute({ file_path: 'src/a.ts' }, execution())).rejects.toThrow(
      'target changed during diagnosis',
    )
  })

  it('detects an observed mutation even when the FsVersion repeats', async () => {
    const fs = makeFs()
    let owner!: ToolOwner
    const runtime: FakeRuntime = {
      diagnoseTarget: vi.fn(async () => {
        owner.observeMutation(TARGET)
        return { kind: 'ok', diagnostics: [DIAGNOSTIC], uri: DIAGNOSTIC.uri, version: 1 }
      }),
    }
    owner = createDiagnosticsTool({ fs, runtime, config: structuredClone(DEFAULT_CONFIG) } as Parameters<typeof createDiagnosticsTool>[0])

    await expect(owner.definition.execute({ file_path: 'src/a.ts' }, execution())).rejects.toThrow(
      'target changed during diagnosis',
    )
  })
})

describe('lsp_diagnostics cancellation', () => {
  it('owns a non-extendable timeout, awaits diagnosis quiescence, and reports timeout unavailable', async () => {
    vi.useFakeTimers()
    let settled = false
    const runtime: FakeRuntime = {
      diagnoseTarget: vi.fn(async (_target, _workspace, _uri, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        settled = true
        return { kind: 'stale' }
      }),
    }
    const { tool } = makeTool({
      runtime,
      config: { ...structuredClone(DEFAULT_CONFIG), timeoutMs: 25 },
    })

    const resultPromise = tool.execute({ file_path: 'src/a.ts' }, execution())
    await vi.advanceTimersByTimeAsync(25)
    const result = await resultPromise

    expect(settled).toBe(true)
    expect(result).toEqual({
      kind: 'unavailable',
      file_path: '/workspace/src/a.ts',
      reason: 'timeout',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('relays caller abort, awaits diagnosis quiescence, and removes its timer and listener', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const removeSpy = vi.spyOn(caller.signal, 'removeEventListener')
    let settled = false
    const runtime: FakeRuntime = {
      diagnoseTarget: vi.fn(async (_target, _workspace, _uri, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        settled = true
        return { kind: 'stale' }
      }),
    }
    const { tool } = makeTool({
      runtime,
      config: { ...structuredClone(DEFAULT_CONFIG), timeoutMs: 10_000 },
    })

    const resultPromise = tool.execute({ file_path: 'src/a.ts' }, execution(caller.signal))
    while (runtime.diagnoseTarget.mock.calls.length === 0) await Promise.resolve()
    caller.abort(new Error('caller stopped'))

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(settled).toBe(true)
    expect(removeSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes admission, aborts active calls, and awaits their quiescence before disposal', async () => {
    const runtime: FakeRuntime = {
      diagnoseTarget: vi.fn(async (_target, _workspace, _uri, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { kind: 'stale' }
      }),
    }
    const { owner, tool } = makeTool({ runtime })
    const active = tool.execute({ file_path: 'src/a.ts' }, execution())
    while (runtime.diagnoseTarget.mock.calls.length === 0) await Promise.resolve()

    owner.stopAdmission()
    await expect(tool.execute({ file_path: 'src/a.ts' }, execution())).rejects.toThrow(
      'lsp_diagnostics is shutting down',
    )
    let drained = false
    const drain = owner.awaitActiveOperations().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    owner.abortActiveOperations()
    await expect(active).rejects.toMatchObject({ name: 'AbortError' })
    await drain
    expect(drained).toBe(true)
  })
})
