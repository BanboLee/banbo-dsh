import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEGRAPH_BIN,
  createRealHeadlessHarness,
  NODE_BIN,
  PROCESS_INSPECTION_AVAILABLE,
  readTextToolResult,
  type RealHeadlessHarness,
} from './headless-real-harness'

const REAL_E2E_ENABLED = process.env.RUN_REAL_HEADLESS_E2E === '1'
const realDescribe = REAL_E2E_ENABLED ? describe : describe.skip
const harnesses: RealHeadlessHarness[] = []

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()
    if (harness !== undefined) await harness.cleanup()
  }
})

realDescribe('real CodeGraph stdio MCP in the headless profile', () => {
  it('uses the pinned Node 22 and local CodeGraph binary', async () => {
    // Given the explicit runtime patch in an isolated real profile
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const booted = await harness.boot()

    // When the pinned Node runtime executes the pinned local CodeGraph CLI
    const provenance = spawnSync(NODE_BIN, [CODEGRAPH_BIN, '--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    const tools = booted.toolNames()

    // Then the configured override and stable local version are observable
    if (process.env.DSH_REAL_E2E_CODEGRAPH_BIN !== undefined) {
      expect(CODEGRAPH_BIN).toBe(process.env.DSH_REAL_E2E_CODEGRAPH_BIN)
    }
    expect(provenance.status).toBe(0)
    expect(provenance.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
    expect(tools).toContain('mcp__codegraph__codegraph_explore')
  }, 120_000)

  it('returns indexed source and symbol evidence from the disposable fixture', async () => {
    // Given the disposable indexed project created by the real harness
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const booted = await harness.boot()

    // When the real MCP server explores its unique fixture symbol
    const value = await booted.callTool('mcp__codegraph__codegraph_explore', {
      query: harness.defaultIndexedSymbol,
    })

    // Then the response contains machine-observable indexed source evidence
    const text = readTextToolResult(value)
    expect(text).toContain(harness.defaultIndexedSymbol)
    expect(text).not.toContain(harness.explicitIndexedSymbol)
    expect(text).toContain('fixture.ts')
  }, 120_000)

  it('honors an explicit projectPath on a real tool call', async () => {
    // Given a real CodeGraph MCP server rooted at the disposable indexed project
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const booted = await harness.boot()

    // When the tool call explicitly selects that project
    const value = await booted.callTool('mcp__codegraph__codegraph_explore', {
      query: harness.explicitIndexedSymbol,
      projectPath: harness.explicitIndexedProject,
    })

    // Then the selected project returns its indexed symbol
    const text = readTextToolResult(value)
    expect(text).toContain(harness.explicitIndexedSymbol)
    expect(text).not.toContain(harness.defaultIndexedSymbol)
    expect(text).toContain('fixture.ts')
  }, 120_000)

  it('keeps tools visible and returns actionable success for a fresh unindexed directory', async () => {
    // Given a fresh isolated directory with no .codegraph index
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const booted = await harness.boot()

    // When the real tool receives that explicit unindexed projectPath
    const value = await booted.callTool('mcp__codegraph__codegraph_explore', {
      query: 'anything',
      projectPath: harness.home,
    })

    // Then the call succeeds with actionable indexing guidance and the tool stays registered
    const text = readTextToolResult(value)
    expect(booted.toolNames()).toContain('mcp__codegraph__codegraph_explore')
    expect(text).toMatch(/isn't indexed/)
    expect(text).toContain('codegraph init')
  }, 120_000)

  it.runIf(PROCESS_INSPECTION_AVAILABLE)('terminates the real stdio child without creating a daemon', async () => {
    // Given a running real MCP child under CODEGRAPH_NO_DAEMON=1
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const booted = await harness.boot()
    await booted.callTool('mcp__codegraph__codegraph_explore', {
      query: harness.defaultIndexedSymbol,
    })
    expect(booted.ownedProcessPids()).not.toEqual([])

    // When the booted profile and isolated harness are disposed
    await booted.cleanup()
    await harness.cleanup()
    harnesses.pop()

    // Then no CodeGraph server or daemon process survives
    expect(booted.ownedProcessPids()).toEqual([])
  }, 120_000)

  it.runIf(PROCESS_INSPECTION_AVAILABLE)('rejects boot for a missing local CodeGraph CLI without leaving a child', async () => {
    // Given a definitely missing CodeGraph module under the isolated home
    const harness = await createRealHeadlessHarness()
    harnesses.push(harness)
    const missingCodeGraph = join(harness.home, 'missing-codegraph.js')

    // When profile boot uses that missing module in the pinned Node argv
    const boot = harness.boot({ codegraphBin: missingCodeGraph })

    // Then startup fails clearly within the bound and leaves no owned child
    await expect(boot).rejects.toThrow(/initial connection or tool synchronization failed|Connection closed/i)
    expect(harness.ownedProcessCount()).toBe(0)
    await harness.cleanup()
    harnesses.pop()
  }, 120_000)
})
