import { afterEach, describe, expect, it } from 'vitest'
import {
  bootProfileWithBundles,
  waitForNoFakeMcpServer,
  type BootedProfile,
} from './profile-boot'

const FISH_BUNDLE = 'plugins/fish-shell'
const RTK_BUNDLE = 'plugins/rtk'
const CODEGRAPH_BUNDLE = 'plugins/codegraph-mcp'

const bootedProfiles: BootedProfile[] = []

afterEach(async () => {
  while (bootedProfiles.length > 0) {
    const profile = bootedProfiles.pop()
    if (profile !== undefined) await profile.cleanup()
  }
  await waitForNoFakeMcpServer()
})

describe('isolated DSH profile composition for fish + rtk bundles', () => {
  it('boots fish and rtk together with fish owning the decorated shell', async () => {
    const booted = await bootProfileWithBundles([FISH_BUNDLE, RTK_BUNDLE])
    bootedProfiles.push(booted)

    const rewritten = await booted.runShell('rewrite git status')

    expect(booted.shellProviders()).toEqual(['dsh-fish-shell'])
    expect(rewritten.stdout.text).toBe('rtk git status\n')
    expect(booted.toolNames()).toContain('fish')
  })

  it('boots fish, rtk, and codegraph together with both model-facing tools', async () => {
    const booted = await bootProfileWithBundles([FISH_BUNDLE, RTK_BUNDLE, CODEGRAPH_BUNDLE])
    bootedProfiles.push(booted)

    const rewritten = await booted.runShell('rewrite git status')

    expect(booted.shellProviders()).toEqual(['dsh-fish-shell'])
    expect(rewritten.stdout.text).toBe('rtk git status\n')
    expect(booted.toolNames()).toEqual(expect.arrayContaining(['fish', 'mcp__codegraph__echo_context']))
  })
})
