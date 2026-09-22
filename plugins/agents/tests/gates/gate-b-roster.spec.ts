/**
 * Gate B — rc.2 roster/profile platform probes.
 *
 * This file locks only platform facts: the Web/TUI row ids, include-patch
 * semantics, profile-root path expressions, and the official roster's root
 * ordering/unmemoized discovery. It never starts an app, provider, or network.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'

import { Context } from '@deepseek-ai/cordis'
import { AgentPresets, discoverPresets, SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')
const patchPath = join(pluginRoot, 'cordis.patch.yml')
const patchText = readFileSync(patchPath, 'utf8')
const require = createRequire(import.meta.url)

interface JsExpr { __jsExpr: string }
interface RootConfig { path: JsExpr; trust: 'system' | 'user' }
interface RosterPatch {
  id?: string
  name?: string
  config?: {
    default?: string
    includeShippedRoot?: boolean
    includeUserRoot?: boolean
    roots?: RootConfig[]
  }
  insert?: unknown[]
}

function parsePatches(text = patchText): RosterPatch[] {
  const document = parseDocument(text, { schema: 'core', customTags: [{
    tag: 'tag:yaml.org,2002:js',
    resolve: (value: string) => ({ __jsExpr: value }),
  }] })
  if (document.errors.length > 0) throw document.errors[0]
  return document.toJS() as RosterPatch[]
}

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  throw new Error(`${name} is required on PATH for Gate B`)
}

function packageRoot(name: string): string {
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    const dshRoot = dirname(dirname(executable('dsh')))
    const globalModules = dirname(dirname(dshRoot))
    const candidates = [
      join(dshRoot, 'node_modules', name),
      join(globalModules, name),
    ]
    const match = candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
    if (match !== undefined) return realpathSync(match)
    throw new Error(`cannot resolve Gate B package ${name}`)
  }
}

function upstreamPatches(name: string): RosterPatch[] {
  const path = join(packageRoot(name), 'cordis.patch.yml')
  return parsePatches(readFileSync(path, 'utf8'))
}

function flatten(rows: RosterPatch[]): RosterPatch[] {
  return rows.flatMap((row) => [row, ...(Array.isArray(row.insert) ? flatten(row.insert as RosterPatch[]) : [])])
}

function targetIds(rows: RosterPatch[]): string[] {
  return rows.filter((row) => row.name === '@deepseek-ai/dsh-agent-presets').map((row) => row.id!).sort()
}

async function composeOfficial(layers: RosterPatch[][]): Promise<{ rows: RosterPatch[]; warnings: string[] }> {
  const dshRoot = dirname(dirname(executable('dsh')))
  const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
  const appBootPath = requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')
  const appBoot = await import(pathToFileURL(appBootPath).href) as {
    composeEntries(layers: unknown[][], warn?: (message: string) => void): unknown[]
  }
  const warnings: string[] = []
  const rows = appBoot.composeEntries(layers, (message) => warnings.push(message)) as RosterPatch[]
  return { rows, warnings }
}

const scratch: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'banbo-gate-b-'))
  scratch.push(root)
  return root
}

afterEach(() => {
  vi.unstubAllEnvs()
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function writePreset(root: string, id: string): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'preset.yml'), `name: ${id}\n`)
}

describe('B1 — Web and TUI expose different roster seats', () => {
  it('rc.2 Web owns agent-presets while dsh-tui 0.10.2 owns dsh-tui-agent-presets', () => {
    expect(targetIds(flatten(upstreamPatches('@deepseek-ai/dsh-web-app')))).toEqual(['agent-presets'])
    expect(targetIds(flatten(upstreamPatches('@deepseek-harness-tui/dsh-tui')))).toEqual(['dsh-tui-agent-presets'])
  })

  it('the bundle targets both seats with one identical complete roster config', () => {
    const targets = parsePatches().filter((row) => row.name === '@deepseek-ai/dsh-agent-presets')
    expect(targets.map((row) => row.id).sort()).toEqual(['agent-presets', 'dsh-tui-agent-presets'])
    expect(targets[0].config).toEqual(targets[1].config)
    expect(targets[0].config).toMatchObject({
      default: 'standard',
      includeShippedRoot: true,
      includeUserRoot: true,
      roots: [
        { trust: 'system' },
        { trust: 'system' },
      ],
    })
  })

  it('the official composer replaces each target and only the absent sibling warns', async () => {
    const overlays = parsePatches()
    for (const [name, expected, absent] of [
      ['@deepseek-ai/dsh-web-app', 'agent-presets', 'dsh-tui-agent-presets'],
      ['@deepseek-harness-tui/dsh-tui', 'dsh-tui-agent-presets', 'agent-presets'],
    ] as const) {
      const upstream = upstreamPatches(name)
      const original = flatten(upstream).find((row) => row.id === expected)
      const result = await composeOfficial([upstream, overlays])
      const target = flatten(result.rows).find((row) => row.id === expected)
      expect(target?.config).toEqual(overlays.find((row) => row.id === expected)?.config)
      expect((target as RosterPatch & { disabled?: unknown })?.disabled)
        .toEqual((original as RosterPatch & { disabled?: unknown })?.disabled)
      const rosterWarnings = result.warnings.filter((warning) => warning.includes('agent-presets'))
      expect(rosterWarnings).toEqual([`patch: entry ${JSON.stringify(absent)} not found`])

      const restored = await composeOfficial([upstream])
      expect(flatten(restored.rows).find((row) => row.id === expected)).toEqual(original)
    }
  })
})

describe('B2 — profile-root path expressions', () => {
  it('resolve package and generated roots from public profile bindings', () => {
    const [packageRootConfig, generatedRootConfig] = parsePatches()
      .find((row) => row.id === 'agent-presets')!.config!.roots!
    const profile = join(tempRoot(), 'profiles with spaces', 'web')
    const baseUrl = pathToFileURL(`${profile}/`).href
    const dshHome = dirname(dirname(profile))
    const dshHomePath = (...segments: string[]) => join(dshHome, ...segments)
    const evaluate = (expression: string) => Function('baseUrl', 'dshHomePath', `return (${expression})`)(baseUrl, dshHomePath)
    expect(evaluate(packageRootConfig.path.__jsExpr)).toBe(join(profile, 'node_modules', '@banbolee', 'dsh-agents', 'presets') + '/')
    expect(evaluate(generatedRootConfig.path.__jsExpr)).toBe(join(dshHome, 'banbo-agents', '.generated', 'current', 'presets'))
  })
})

describe('B3 — official roster discovery is ordered and unmemoized', () => {
  it('materializes shipped/package/generated/user roots and follows current on the same instance', async () => {
    const dshHome = tempRoot()
    vi.stubEnv('DSH_HOME', dshHome)
    const profile = join(dshHome, 'profiles', 'web')
    const packagePresets = join(profile, 'node_modules', '@banbolee', 'dsh-agents', 'presets')
    const generations = join(dshHome, 'banbo-agents', '.generated', 'generations')
    const firstGeneration = join(generations, 'first')
    const secondGeneration = join(generations, 'second')
    writePreset(packagePresets, 'package-probe')
    writePreset(join(firstGeneration, 'presets'), 'first-probe')
    writePreset(join(secondGeneration, 'presets'), 'second-probe')
    mkdirSync(join(dshHome, 'banbo-agents', '.generated'), { recursive: true })
    symlinkSync(firstGeneration, join(dshHome, 'banbo-agents', '.generated', 'current'))

    const configuredRoots = parsePatches().find((row) => row.id === 'agent-presets')!.config!.roots!
    const baseUrl = pathToFileURL(`${profile}/`).href
    const dshHomePath = (...segments: string[]) => join(dshHome, ...segments)
    const evaluate = (expression: string) => Function('baseUrl', 'dshHomePath', `return (${expression})`)(baseUrl, dshHomePath)
    const ctx = new Context()
    ctx.baseUrl = baseUrl
    new SessionProjectionRegistry(ctx)
    const roster = new AgentPresets(ctx, {
      default: 'standard',
      includeShippedRoot: true,
      includeUserRoot: true,
      roots: configuredRoots.map((root) => ({ path: evaluate(root.path.__jsExpr), trust: root.trust })),
    })

    expect(roster.roots).toEqual([
      { path: SHIPPED_PRESET_ROOT, trust: 'system' },
      { path: packagePresets + '/', trust: 'system' },
      { path: join(dshHome, 'banbo-agents', '.generated', 'current', 'presets'), trust: 'system' },
      { path: join(dshHome, '.agent-presets'), trust: 'user' },
    ])
    expect(roster.authorable).toBe(true)
    expect((await roster.list()).map((preset) => preset.id)).toContain('first-probe')

    const nextLink = join(dshHome, 'banbo-agents', '.generated', '.current-next')
    symlinkSync(secondGeneration, nextLink)
    renameSync(nextLink, join(dshHome, 'banbo-agents', '.generated', 'current'))
    const after = (await roster.list()).map((preset) => preset.id)
    expect(after).toContain('second-probe')
    expect(after).not.toContain('first-probe')
    expect(roster.roots[2].path).toBe(join(dshHome, 'banbo-agents', '.generated', 'current', 'presets'))
    await ctx.fiber.dispose()
  })

  it('keeps first-root-wins and sees presets written after the first list', async () => {
    const packagePresets = tempRoot()
    const generatedPresets = tempRoot()
    const userPresets = tempRoot()
    writePreset(packagePresets, 'package-probe')
    writePreset(generatedPresets, 'collision')
    writePreset(userPresets, 'collision')

    const roots = [
      { path: SHIPPED_PRESET_ROOT, trust: 'system' as const },
      { path: packagePresets, trust: 'system' as const },
      { path: generatedPresets, trust: 'system' as const },
      { path: userPresets, trust: 'user' as const },
    ]
    const harnessBase = pathToFileURL(join(packageRoot('@deepseek-ai/dsh-agent-presets'), 'package.json')).href
    const first = await discoverPresets(roots, harnessBase)
    expect(first.find((preset) => preset.id === 'standard')?.trust).toBe('system')
    expect(realpathSync(first.find((preset) => preset.id === 'collision')!.path)).toBe(realpathSync(join(generatedPresets, 'collision', 'agent.cordis.yml')))
    expect(first.some((preset) => preset.id === 'late')).toBe(false)

    writePreset(generatedPresets, 'late')
    const second = await discoverPresets(roots, harnessBase)
    expect(realpathSync(second.find((preset) => preset.id === 'late')!.path)).toBe(realpathSync(join(generatedPresets, 'late', 'agent.cordis.yml')))
    expect(roots.map((root) => root.trust)).toEqual(['system', 'system', 'system', 'user'])
  })
})
