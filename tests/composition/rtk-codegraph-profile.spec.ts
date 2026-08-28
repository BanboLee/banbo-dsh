import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIsolatedProfile } from '../helpers/profile'
import {
  bootProfileWithBundles,
  setIsolatedProfileFactoryForTest,
  waitForNoFakeMcpServer,
  type BootedProfile,
} from './profile-boot'

const RTK_BUNDLE = 'plugins/rtk-shell'
const CODEGRAPH_BUNDLE = 'plugins/codegraph-mcp'
const PROFILE_TMP_PREFIX = 'dsh-rtk-codegraph-profile-'

const bootedProfiles: BootedProfile[] = []

function tempProfileHomes(): Set<string> {
  return new Set(readdirSync(tmpdir())
    .filter((entry) => entry.startsWith(PROFILE_TMP_PREFIX))
    .map((entry) => join(tmpdir(), entry)))
}

function restoreEnv(snapshot: { readonly dshHome?: string; readonly path?: string; readonly fakeMode?: string }): void {
  if (snapshot.dshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = snapshot.dshHome
  if (snapshot.path === undefined) delete process.env.PATH
  else process.env.PATH = snapshot.path
  if (snapshot.fakeMode === undefined) delete process.env.FAKE_RTK_MODE
  else process.env.FAKE_RTK_MODE = snapshot.fakeMode
}

afterEach(async () => {
  while (bootedProfiles.length > 0) {
    const profile = bootedProfiles.pop()
    if (profile !== undefined) await profile.cleanup()
  }
  await waitForNoFakeMcpServer()
})

describe('isolated DSH profile composition for rtk + codegraph bundles', () => {
  it('loads both local bundles into one temporary profile with one shell provider and one CodeGraph MCP tool', async () => {
    const booted = await bootProfileWithBundles([RTK_BUNDLE, CODEGRAPH_BUNDLE])
    bootedProfiles.push(booted)

    const rewritten = await booted.runShell('rewrite git status')
    const toolResult = await booted.callTool('mcp__codegraph__echo_context', {})

    expect(booted.shellProviders()).toEqual(['rtk-shell'])
    expect(booted.realProfilePath()).toMatchObject({
      loader: 'dsh-app-boot',
      installedBundles: expect.arrayContaining(['dsh-rtk-shell', 'dsh-codegraph-mcp']),
    })
    expect(rewritten.stdout.text).toBe('rtk git status\n')
    expect(booted.toolNames()).toEqual(['mcp__codegraph__echo_context'])
    expect(toolResult).toEqual({ content: [{ type: 'text', text: 'codegraph-ok' }] })
  })

  it('fails with a missing MCP assertion when the codegraph bundle row is removed', async () => {
    const booted = await bootProfileWithBundles([RTK_BUNDLE])
    bootedProfiles.push(booted)

    expect(() => booted.assertHasTool('mcp__codegraph__echo_context')).toThrow(/missing MCP tool/)
  })

  it('has no shell provider when the rtk bundle entry is omitted', async () => {
    const booted = await bootProfileWithBundles([CODEGRAPH_BUNDLE])
    bootedProfiles.push(booted)

    expect(booted.shellProviders()).toEqual([])
  })

  it('restores env and removes temp DSH_HOME when profile setup fails before returning', async () => {
    const beforeEnv = {
      dshHome: process.env.DSH_HOME,
      path: process.env.PATH,
      fakeMode: process.env.FAKE_RTK_MODE,
    }
    const beforeHomes = tempProfileHomes()
    let thrown: unknown

    try {
      try {
        await bootProfileWithBundles(['plugins/does-not-exist'])
      } catch (error) {
        thrown = error
      }

      const afterHomes = tempProfileHomes()
      const newHomes = [...afterHomes].filter((path) => !beforeHomes.has(path))
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('does-not-exist')
      expect(process.env.DSH_HOME).toBe(beforeEnv.dshHome)
      expect(process.env.PATH).toBe(beforeEnv.path)
      expect(process.env.FAKE_RTK_MODE).toBe(beforeEnv.fakeMode)
      expect(newHomes).toEqual([])
    } finally {
      restoreEnv(beforeEnv)
      for (const path of tempProfileHomes()) {
        if (!beforeHomes.has(path)) rmSync(path, { recursive: true, force: true })
      }
      await waitForNoFakeMcpServer()
    }
  })

  it('preserves the original setup error when failure cleanup also throws', async () => {
    const beforeEnv = {
      dshHome: process.env.DSH_HOME,
      path: process.env.PATH,
      fakeMode: process.env.FAKE_RTK_MODE,
    }
    const beforeHomes = tempProfileHomes()
    const restoreFactory = setIsolatedProfileFactoryForTest((name) => {
      const isolated = createIsolatedProfile(name)
      return {
        ...isolated,
        cleanup: async () => {
          await isolated.cleanup()
          throw new Error('forced cleanup failure')
        },
      }
    })
    let thrown: unknown

    try {
      try {
        await bootProfileWithBundles(['plugins/does-not-exist'])
      } catch (error) {
        thrown = error
      }

      const afterHomes = tempProfileHomes()
      const newHomes = [...afterHomes].filter((path) => !beforeHomes.has(path))
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('does-not-exist')
      expect((thrown as Error).message).not.toContain('forced cleanup failure')
      expect(process.env.DSH_HOME).toBe(beforeEnv.dshHome)
      expect(process.env.PATH).toBe(beforeEnv.path)
      expect(process.env.FAKE_RTK_MODE).toBe(beforeEnv.fakeMode)
      expect(newHomes).toEqual([])
    } finally {
      restoreFactory()
      restoreEnv(beforeEnv)
      for (const path of tempProfileHomes()) {
        if (!beforeHomes.has(path)) rmSync(path, { recursive: true, force: true })
      }
      await waitForNoFakeMcpServer()
    }
  })

  it('removes temporary DSH_HOME state during cleanup', async () => {
    const booted = await bootProfileWithBundles([RTK_BUNDLE, CODEGRAPH_BUNDLE])
    const dshHome = booted.dshHome

    expect(existsSync(dshHome)).toBe(true)
    await booted.cleanup()

    expect(existsSync(dshHome)).toBe(false)
    await waitForNoFakeMcpServer()
  })
})
