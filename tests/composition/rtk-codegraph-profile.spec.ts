import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { bootProfileWithBundles, type BootedProfile } from './profile-boot'

const RTK_BUNDLE = 'plugins/rtk-shell'
const CODEGRAPH_BUNDLE = 'plugins/codegraph-mcp'

const bootedProfiles: BootedProfile[] = []

afterEach(async () => {
  while (bootedProfiles.length > 0) {
    const profile = bootedProfiles.pop()
    if (profile !== undefined) await profile.cleanup()
  }
})

describe('isolated DSH profile composition for rtk + codegraph bundles', () => {
  it('loads both local bundles into one temporary profile with one shell provider and one CodeGraph MCP tool', async () => {
    const booted = await bootProfileWithBundles([RTK_BUNDLE, CODEGRAPH_BUNDLE])
    bootedProfiles.push(booted)

    const rewritten = await booted.runShell('rewrite git status')
    const toolResult = await booted.callTool('mcp__codegraph__echo_context', {})

    expect(booted.shellProviders()).toEqual(['rtk-shell'])
    expect(rewritten.stdout.text).toBe('rtk git status\n')
    expect(booted.toolNames()).toEqual(['mcp__codegraph__echo_context'])
    expect(toolResult).toEqual({ content: [{ type: 'text', text: 'codegraph-ok' }] })
  })

  it('fails with a missing MCP assertion when the codegraph bundle row is removed', async () => {
    const booted = await bootProfileWithBundles([RTK_BUNDLE])
    bootedProfiles.push(booted)

    expect(() => booted.assertHasTool('mcp__codegraph__echo_context')).toThrow(/missing MCP tool/)
  })

  it('removes temporary DSH_HOME state during cleanup', async () => {
    const booted = await bootProfileWithBundles([RTK_BUNDLE, CODEGRAPH_BUNDLE])
    const dshHome = booted.dshHome

    expect(existsSync(dshHome)).toBe(true)
    await booted.cleanup()

    expect(existsSync(dshHome)).toBe(false)
  })
})
