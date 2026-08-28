import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, type StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import {
  ROW_ID,
  patchPath,
  readPatch,
  composePatch,
  rowById,
  parseRowConfig,
  type McpRowConfig,
} from './helpers'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fakeMcpServer = join(root, 'tests', 'fixtures', 'fake-mcp-server.mjs')

// Minimal shape of the tool registry the official bridge needs. The real
// dsh-tools ToolRuntime is a superset; the bridge only calls
// ctx.tools.register() and expects a disposer back.
interface FakeToolDefinition {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

function makeContext(): { ctx: Context; registered: Map<string, FakeToolDefinition> } {
  const registered = new Map<string, FakeToolDefinition>()
  const ctx = new Context()
  // dsh-tools declares ctx.tools as the full ToolRuntime type; the official
  // bridge only calls ctx.tools.register(). The cast is the test seam that
  // provides the minimal registry the bridge consumes.
  ;(ctx as unknown as { tools: { register(def: FakeToolDefinition): () => void } }).tools = {
    register(def) {
      registered.set(def.name, def)
      return () => void registered.delete(def.name)
    },
  }
  return { ctx, registered }
}

/**
 * Compose the bundle row through the same override seam a profile uses for
 * `--path`, then point the spawned command at the deterministic fake MCP
 * server so no live `codegraph` binary or daemon is ever required.
 */
function bridgeConfig(overrides: Partial<Pick<McpRowConfig, 'command' | 'args'>> = {}): StdioConfig {
  const base = parseRowConfig(rowById(composePatch(readPatch(patchPath())), ROW_ID))
  return {
    ...base,
    command: overrides.command ?? base.command,
    args: overrides.args ?? base.args,
    cwd: '',
    toolCallTimeoutMs: 5000,
    failOnStartupError: true,
  }
}

const liveContexts: Context[] = []
afterEach(async () => {
  while (liveContexts.length > 0) {
    await liveContexts.pop()!.fiber.dispose()
  }
})

describe('deterministic MCP bridge composition (fake server, no live codegraph)', () => {
  it('registers the server-qualified public tool mcp__codegraph__echo_context and never the raw name', async () => {
    const { ctx, registered } = makeContext()
    liveContexts.push(ctx)
    await apply(ctx, bridgeConfig({ command: process.execPath, args: [fakeMcpServer] }))
    expect([...registered.keys()]).toEqual(['mcp__codegraph__echo_context'])
    expect(registered.has('echo_context')).toBe(false)
  })

  it('invoking mcp__codegraph__echo_context returns the deterministic codegraph-ok text', async () => {
    const { ctx, registered } = makeContext()
    liveContexts.push(ctx)
    await apply(ctx, bridgeConfig({ command: process.execPath, args: [fakeMcpServer] }))
    const definition = registered.get('mcp__codegraph__echo_context')
    expect(definition).toBeDefined()
    const result = (await definition!.execute({}, { signal: new AbortController().signal })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content).toEqual([{ type: 'text', text: 'codegraph-ok' }])
  })

  it('fails loud when a second row reuses the serverName codegraph (official bridge contract)', async () => {
    const { ctx, registered } = makeContext()
    liveContexts.push(ctx)
    const config = bridgeConfig({ command: process.execPath, args: [fakeMcpServer] })
    await apply(ctx, config)
    await expect(apply(ctx, config)).rejects.toThrow(/serverName "codegraph" is already in use/)
    expect([...registered.keys()]).toEqual(['mcp__codegraph__echo_context'])
  })

  it('disposes cleanly and unregisters every tool', async () => {
    const { ctx, registered } = makeContext()
    await apply(ctx, bridgeConfig({ command: process.execPath, args: [fakeMcpServer] }))
    expect([...registered.keys()]).toHaveLength(1)
    await ctx.fiber.dispose()
    expect([...registered.keys()]).toHaveLength(0)
  })
})
