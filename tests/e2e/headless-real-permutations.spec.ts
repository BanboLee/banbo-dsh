import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createRealHeadlessHarness,
  readTextToolResult,
  type PluginName,
  type RealBoot,
  type RealHeadlessHarness,
} from './headless-real-harness'

const REAL_E2E_ENABLED = process.env.RUN_REAL_HEADLESS_E2E === '1'
const realDescribe = REAL_E2E_ENABLED ? describe : describe.skip
const PERMUTATIONS = [
  ['dsh-fish-shell', 'dsh-rtk', 'dsh-codegraph-mcp'],
  ['dsh-fish-shell', 'dsh-codegraph-mcp', 'dsh-rtk'],
  ['dsh-rtk', 'dsh-fish-shell', 'dsh-codegraph-mcp'],
  ['dsh-rtk', 'dsh-codegraph-mcp', 'dsh-fish-shell'],
  ['dsh-codegraph-mcp', 'dsh-fish-shell', 'dsh-rtk'],
  ['dsh-codegraph-mcp', 'dsh-rtk', 'dsh-fish-shell'],
] as const satisfies readonly (readonly PluginName[])[]

let harness: RealHeadlessHarness
let booted: RealBoot | undefined

beforeAll(async () => {
  harness = await createRealHeadlessHarness()
}, 120_000)

afterEach(async () => {
  await booted?.cleanup()
  booted = undefined
})

afterAll(async () => {
  await harness?.cleanup()
})

realDescribe('all real local plugin layer permutations', () => {
  it.each(PERMUTATIONS)('keeps fish, RTK, and CodeGraph usable for %j', async (...order) => {
    // Given one preinstalled real headless profile and a distinct local-layer order
    booted = await harness.boot({ order })

    // When fish, RTK rewrite execution, and CodeGraph query are exercised
    const shell = await booted.runShell({
      command: 'git status --short',
      workdir: harness.gitProject,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: harness.gitProject },
    })
    const graph = await booted.callTool('mcp__codegraph__codegraph_explore', {
      query: harness.defaultIndexedSymbol,
    })

    // Then every order preserves exactly one fish provider and both integrations
    expect(booted.proof.installedBundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
      ...order,
    ])
    expect(booted.localPluginOrder()).toEqual(order)
    expect(booted.shellProviders()).toEqual(['dsh-fish-shell'])
    expect(booted.toolNames()).toContain('fish')
    expect(booted.toolNames()).not.toContain('bash')
    expect(shell.exitCode).toBe(0)
    expect(shell.stderr.text).not.toContain('rtk rewrite exit 3 (ask)')
    expect(readTextToolResult(graph)).toContain(harness.defaultIndexedSymbol)
  }, 120_000)
})
