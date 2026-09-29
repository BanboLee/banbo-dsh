/**
 * Specification for `plugins/agents/index.js` — Host-side assembly
 * (docs/agents-plugin-plan.md §8.4, §9.1, §9.2).
 *
 * The Host has one job before anything else may run: read the built-in and user
 * catalog, merge and validate it, and publish an immutable ABI generation. Two
 * properties are non-negotiable and are what this suite pins down:
 *
 *   - **nothing is published half-done** — a bad user file (or a settings entry
 *     naming an agent that was never published) must fail the whole startup with
 *     the old generation still active and complete;
 *   - **the generation is a mirror, not an accumulator** — deleting a
 *     definition retires its ABI record while the next generation carries only
 *     what is live (§6.3, §11.2).
 *
 * The presets themselves are rows in `cordis.patch.yml` (see
 * `preset-compiler.spec.ts` and `gates/gate-b-roster.spec.ts`); nothing here
 * scans a directory for them any more.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import hostPlugin, {
  Config,
  SHIPPED_PRESET_IDS,
  dependencyFamilyVersion,
  initialiseCatalog,
  inject,
  name as pluginName,
} from '../index.js'
import { readCurrentGeneration } from '../preset-compiler.js'
import { IDENTITY_TEXT } from '../main-runtime.js'

const require = createRequire(import.meta.url)
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchText = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8')

/** What one complete 0.1.7 generation contains: the ABI manifest and its marker. */
const GENERATION_CONTENTS = ['abi.json', 'complete']

/** The agent ids one generation directory published, in ABI order. */
function abiAgentIds(generationDir: string): string[] {
  const abi = JSON.parse(readFileSync(join(generationDir, 'abi.json'), 'utf8')) as {
    agents: Array<{ id: string }>
  }
  return abi.agents.map((agent) => agent.id)
}

/** The preset ids the bundle patch declares, in patch order. */
function declaredPresetRows(): Array<Record<string, unknown>> {
  const { parseDocument } = require('yaml') as typeof import('yaml')
  const document = parseDocument(patchText, { schema: 'core', merge: false })
  if (document.errors.length > 0) throw document.errors[0]
  return (document.toJS() as Array<Record<string, unknown>>)
    .flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert as Array<Record<string, unknown>> : []))
    .filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
}

/** The preset ids the bundle patch declares, in patch order. */
function declaredPresetIds(): string[] {
  return declaredPresetRows().map((row) => (row.config as Record<string, unknown>).id as string)
}

/** The child rows of one declared preset, parsed with `!!js` gates inert. */
function declaredPresetPlugins(id: string): Array<Record<string, unknown>> {
  const row = declaredPresetRows().find((candidate) => (candidate.config as Record<string, unknown>).id === id)
  if (row === undefined) throw new Error(`preset ${id} is not declared`)
  return (row.config as Record<string, unknown>).plugins as Array<Record<string, unknown>>
}

/**
 * Test roots live under the system temp directory; `afterEach` removes every
 * one, so a failing test cannot leave a generation behind.
 */
const scratch: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'banbo-host-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** Write one file under the scratch root, creating parents. */
function write(root: string, relativePath: string, text: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const MAIN_PERSONA = '# Role\n\nLead the probe.\n'
const CHILD_PERSONA = '# Role\n\nHelp the probe.\n'

/** A user main agent plus the child it is allowed to delegate to. */
function writeUserTeam(root: string): void {
  write(root, 'agents/my-lead.yaml', [
    'id: my-lead',
    'displayName: My Lead',
    'description: probe lead',
    'allowedChildren: [helper]',
    'main:',
    '  presetId: my-lead',
    '  persona: prompts/my-lead-main.md',
    '  tools: [read, agent-control]',
    '  maxDepth: 1',
    '',
  ].join('\n'))
  write(root, 'agents/helper.yaml', [
    'id: helper',
    'displayName: Helper',
    'description: probe helper',
    'allowedChildren: []',
    'child:',
    '  model:',
    '    default: true',
    '  persona: prompts/helper-child.md',
    '  guidance: use me for probe work',
    '  tools: [read]',
    '  continuation: one-shot',
    '',
  ].join('\n'))
  write(root, 'prompts/my-lead-main.md', MAIN_PERSONA)
  write(root, 'prompts/helper-child.md', CHILD_PERSONA)
}

/** Every generation directory present under one scratch root. */
function generations(root: string): string[] {
  const dir = join(root, '.generated', 'generations')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

const init = (root: string) => initialiseCatalog({ rootDir: root, packageRoot: pluginRoot })

/* --------------------------------------------------------------- versions --- */

describe('dependencyFamilyVersion — the locked harness range (§11.2)', () => {
  it('reads the single range every harness dependency declares', () => {
    expect(dependencyFamilyVersion()).toMatch(/^\^\d+\.\d+\.\d+/)
  })

  it('refuses a manifest whose harness dependencies disagree', () => {
    expect(() => dependencyFamilyVersion({
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.1', '@deepseek-ai/dsh-agent': '^0.1.8' },
    })).toThrow(/family|uniform|one range/i)
  })

  it('is content, not a host path — the same manifest gives the same answer', () => {
    const manifest = { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.1' } }
    expect(dependencyFamilyVersion(manifest)).toBe(dependencyFamilyVersion(manifest))
  })
})

/* ------------------------------------------------- range ⇄ target runtime --- */

const repoRoot = resolve(pluginRoot, '..', '..')
/** The runtime the declared family names — the version the range must admit. */
const TARGET_DSH_VERSION = '0.2.0-rc.1'
/** The runtime the family was upgraded FROM: the negative control. */
const PREVIOUS_DSH_VERSION = '0.1.7-rc.2'

/**
 * Load a module from THIS workspace's installed tree.
 *
 * pnpm hoists every installed package into `node_modules/.pnpm/node_modules`,
 * which is on no test file's resolution path; `@deepseek-ai/dsh-app-boot` is
 * not a declared dependency of this bundle either. Resolving from the hoisted
 * store keeps the check offline and deterministic: the module comes from the
 * lockfile's own install, never from the network and never from whatever
 * global `dsh` happens to be on `PATH`.
 *
 * @returns the module namespace, or `undefined` when it is not installed.
 */
function optionalInstalledModule(id: string): unknown {
  try {
    const hoisted = createRequire(join(repoRoot, 'node_modules', '.pnpm', 'node_modules', 'package.json'))
    return hoisted(id) as unknown
  } catch {
    return undefined
  }
}

describe('dependencyFamilyVersion — the declared range admits the target runtime', () => {
  it('accepts 0.2.0-rc.1 through the platform evaluator, with semver as the fallback', () => {
    const manifest: object = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
    const appBoot = optionalInstalledModule('@deepseek-ai/dsh-app-boot') as {
      evaluatePluginCompatibility: (
        manifest: object,
        exemptions?: Readonly<Record<string, readonly string[]>>,
        runtimeVersion?: string,
      ) => { peers: Record<string, string> } | undefined
    } | undefined
    if (appBoot !== undefined) {
      // The evaluator the plugin manager refuses a plugin with, so agreeing
      // with it is the one non-approximate statement about the declaration.
      expect(appBoot.evaluatePluginCompatibility(manifest, {}, TARGET_DSH_VERSION)).toBeUndefined()
      // A probe that cannot fail proves nothing: the same manifest against the
      // previous runtime must be rejected, peer by peer.
      const stale = appBoot.evaluatePluginCompatibility(manifest, {}, PREVIOUS_DSH_VERSION)
      expect(stale).toBeDefined()
      expect(Object.keys(stale?.peers ?? {}).length).toBeGreaterThan(0)
      return
    }
    // Documented fallback when the platform module is absent: plain `semver`
    // with prereleases participating in the range.
    const semver = optionalInstalledModule('semver') as {
      satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean
    }
    expect(semver.satisfies(TARGET_DSH_VERSION, dependencyFamilyVersion(), { includePrerelease: true })).toBe(true)
    expect(semver.satisfies(PREVIOUS_DSH_VERSION, dependencyFamilyVersion(), { includePrerelease: true })).toBe(false)
  })
})

describe('SHIPPED_PRESET_IDS — the presets this bundle declares', () => {
  it('names exactly the preset rows cordis.patch.yml declares', () => {
    expect(Object.isFrozen(SHIPPED_PRESET_IDS)).toBe(true)
    expect([...SHIPPED_PRESET_IDS].sort()).toEqual(['banbo', 'planner'])
    // The constant is what the Host publishes for provenance; the patch is what
    // the Loader actually mounts. They must agree.
    expect([...SHIPPED_PRESET_IDS].sort()).toEqual(declaredPresetIds().sort())
  })
})

/* ----------------------------------------------------------- host startup --- */

describe('initialiseCatalog — Host startup (§9.2)', () => {
  it('loads the built-in catalog and activates a valid empty generation', () => {
    const root = scratchDir()
    const state = init(root)
    expect([...state.definitions.keys()]).toEqual(['banbo', 'executor', 'explorer', 'implement', 'planner', 'research', 'review'])
    expect(state.reused).toBe(false)
    // A generation is the published ABI alone: presets are declared as rows, so
    // nothing is compiled into `presets/` any more.
    expect(readdirSync(state.generationDir).sort()).toEqual(GENERATION_CONTENTS)
    expect(existsSync(join(root, '.generated', 'current', 'complete'))).toBe(true)
  })

  it('records a user main agent in the published ABI with the preset id it claims', () => {
    const root = scratchDir()
    writeUserTeam(root)
    const state = init(root)
    const lead = state.abi.agents.find((record: { id: string }) => record.id === 'my-lead')!
    expect(lead).toMatchObject({ presetId: 'my-lead', hasMain: true, toolName: 'agent_my_lead' })
    // `helper` is child-only, so it owns no preset.
    expect(state.abi.agents.find((record: { id: string }) => record.id === 'helper')).not.toHaveProperty('presetId')
    expect(abiAgentIds(join(root, '.generated', 'current'))).toEqual([
      'banbo', 'executor', 'explorer', 'helper', 'implement', 'my-lead', 'planner', 'research', 'review',
    ])
  })

  it('keeps the harness placeholders in the declared preset composition', () => {
    // The composition a preset mounts is now the `config.plugins` list of the
    // `preset-<id>` rows, which is generated from the template. `{{cwd}}`
    // belongs to the harness and must survive verbatim in a real config VALUE:
    // asserting it against the template is not enough, because the previous
    // version of this test was satisfied by a template COMMENT that merely
    // mentioned `{{model}}`, so it passed while the value was absent.
    const persona = declaredPresetPlugins('banbo').find((row) => row.id === 'persona')!
    expect((persona.config as Record<string, unknown>).suffix).toBe('Your working directory is {{cwd}}.')
    // `{{agentId}}` is ours and must be substituted away.
    expect(patchText).not.toContain('{{agentId}}')
    // `{{model}}` is deliberately NOT carried by the composition any more: the
    // identity line that uses it is registered at runtime under a section name
    // the child composition cannot shadow. Assert it where it actually lives.
    expect(IDENTITY_TEXT).toContain('{{model}}')
    expect(patchText).not.toContain('{{model}}')
    for (const id of ['banbo', 'planner']) {
      const runtime = declaredPresetPlugins(id).filter((row) => typeof row.name === 'string' && row.name.startsWith('@banbolee/dsh-agents/'))
      expect(runtime).toHaveLength(2)
      for (const row of runtime) expect((row.config as Record<string, unknown>).agentId).toBe(id)
    }
  })

  it('publishes one ABI record when a user definition shadows a shipped id', () => {
    const root = scratchDir()
    // Shadow the built-in `banbo` definition. The preset row is untouched: a
    // preset is a declaration, not something this plugin derives from a file.
    write(root, 'agents/banbo.yaml', 'id: banbo\ndisplayName: Banbo\ndescription: shadow\nallowedChildren: []\nmain:\n  presetId: banbo\n  persona: prompts/banbo-main.md\n  tools: [read]\n  maxDepth: 0\n')
    const state = init(root)
    expect(readdirSync(state.generationDir).sort()).toEqual(GENERATION_CONTENTS)
    const record = state.abi.agents.find((entry: { id: string }) => entry.id === 'banbo')
    expect(record).toMatchObject({ presetId: 'banbo', hasMain: true, toolName: 'agent_banbo' })
  })

  it('lets a user persona override a built-in one', () => {
    const root = scratchDir()
    write(root, 'prompts/banbo-main.md', '# Role\n\nA local override.\n')
    const state = init(root)
    expect(state.personas.get('prompts/banbo-main.md')).toBe('# Role\n\nA local override.\n')
  })

  it('fails the whole startup on a bad user definition and keeps the old generation', () => {
    const root = scratchDir()
    writeUserTeam(root)
    const first = init(root)
    write(root, 'agents/broken.yaml', 'id: broken\ndisplayName: Broken\ndescription: bad\nallowedChildren: []\nmain:\n  presetId: broken\n  persona: prompts/my-lead-main.md\n  tools: [read]\n  maxDepth: 0\n  nope: true\n')
    expect(() => init(root)).toThrow(/nope|unknown/i)
    // Nothing was activated and nothing new was left behind.
    expect(generations(root)).toEqual([first.generation])
    expect(existsSync(join(root, '.generated', 'current', 'complete'))).toBe(true)
    expect(readdirSync(join(root, '.generated', 'current')).sort()).toEqual(GENERATION_CONTENTS)
    expect(readFileSync(join(first.generationDir, 'abi.json'), 'utf8')).not.toContain('broken')
  })

  it('fails when a referenced persona is missing', () => {
    const root = scratchDir()
    write(root, 'agents/orphan.yaml', 'id: orphan\ndisplayName: Orphan\ndescription: no persona\nallowedChildren: []\nmain:\n  presetId: orphan\n  persona: prompts/absent.md\n  tools: [read]\n  maxDepth: 0\n')
    expect(() => init(root)).toThrow()
    expect(generations(root)).toEqual([])
  })

  it('keeps the previous generation on disk when the catalog changes', () => {
    const root = scratchDir()
    writeUserTeam(root)
    const first = init(root)
    write(root, 'agents/second.yaml', 'id: second\ndisplayName: Second\ndescription: probe\nallowedChildren: []\nmain:\n  presetId: second\n  persona: prompts/my-lead-main.md\n  tools: [read]\n  maxDepth: 0\n')
    const second = init(root)
    expect(second.generation).not.toBe(first.generation)
    expect(generations(root)).toEqual([first.generation, second.generation].sort())
    expect(existsSync(join(first.generationDir, 'complete'))).toBe(true)
  })

  it('refuses to start when the active generation has a corrupt ABI manifest', () => {
    // A corrupt manifest must NOT be read as "nothing was ever published":
    // that would silently disable the published-ABI protection of §11.2 and let
    // a narrowing catalog activate.
    const root = scratchDir()
    writeUserTeam(root)
    const first = init(root)
    writeFileSync(join(first.generationDir, 'abi.json'), '{ this is not json')

    expect(() => init(root)).toThrow(/abi|manifest/i)
  })

  it('refuses to start when the active generation is missing its ABI manifest', () => {
    const root = scratchDir()
    writeUserTeam(root)
    const first = init(root)
    rmSync(join(first.generationDir, 'abi.json'))

    expect(() => init(root)).toThrow(/abi|manifest/i)
  })

  it('still treats an absent current pointer as a legitimate first startup', () => {
    const root = scratchDir()
    writeUserTeam(root)
    expect(existsSync(join(root, '.generated', 'current'))).toBe(false)
    expect(() => init(root)).not.toThrow()
  })

  it('drops a deleted main agent from the next generation and retires its ABI record', () => {    const root = scratchDir()
    writeUserTeam(root)
    init(root)
    rmSync(join(root, 'agents', 'my-lead.yaml'))
    write(root, 'agents/helper.yaml', 'id: helper\ndisplayName: Helper\ndescription: probe helper\nallowedChildren: []\nchild:\n  model:\n    default: true\n  persona: prompts/helper-child.md\n  guidance: use me for probe work\n  tools: [read]\n  continuation: one-shot\n')
    const after = init(root)
    // The generation is a mirror of the live catalog, and the deleted agent's
    // ABI record survives as a retired shell (never as a mountable preset).
    expect(readdirSync(join(root, '.generated', 'current')).sort()).toEqual(GENERATION_CONTENTS)
    const record = after.abi.agents.find((entry: { id: string }) => entry.id === 'my-lead')!
    expect(record.retired).toBe(true)
    expect(record.retiredReason).toBe('definition-file-missing')
    expect(record.displayName).toBe('My Lead')
    // The retired name can never be handed to a different agent.
    expect(record.toolName).toBe('agent_my_lead')
  })

  it('revives a retired user agent when its definition file comes back (§12.1)', () => {
    // The documented recovery path: the card and the runtime errors both tell
    // the user to restore the YAML. Before this test that advice bricked the
    // Host with `abi-retired-revived`, so the whole chain is asserted here.
    const root = scratchDir()
    writeUserTeam(root)
    init(root)

    rmSync(join(root, 'agents', 'my-lead.yaml'))
    const retired = init(root)
    expect(retired.abi.agents.find((entry: { id: string }) => entry.id === 'my-lead')?.retired).toBe(true)
    expect(readdirSync(join(root, '.generated', 'current')).sort()).toEqual(GENERATION_CONTENTS)

    writeUserTeam(root)
    const revived = init(root)
    expect(revived.abi.agents.find((entry: { id: string }) => entry.id === 'my-lead')?.retired).toBeFalsy()
    expect(revived.abi.agents.find((entry: { id: string }) => entry.id === 'my-lead')).toMatchObject({ presetId: 'my-lead' })
  })
})

/* ------------------------------------------------------------ plugin row --- */

describe('the Host plugin row', () => {
  it('rolls the pointer back when a post-activation startup step fails (§9.2)', async () => {
    // `compilePresets` activates while compiling, so a failure AFTER it — the
    // catalog-aware settings validation is the one that still can — would leave
    // the NEW generation live for a catalog that never ran. The previous
    // generation must stay pointed at instead.
    const root = scratchDir()
    writeUserTeam(root)
    const first = init(root)

    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)

    // Add a second agent so the candidate catalog differs from the live one.
    write(root, 'agents/second.yaml', 'id: second\ndisplayName: Second\ndescription: probe\nallowedChildren: []\nmain:\n  presetId: second\n  persona: prompts/my-lead-main.md\n  tools: [read]\n  maxDepth: 0\n')

    await expect(hostPlugin(ctx as never, { agents: { ghost: { enabled: true } } }))
      .rejects.toThrow(/unknown agent "ghost"/)

    expect(readCurrentGeneration(root)).toBe(first.generationDir)
    expect(readFileSync(join(first.generationDir, 'abi.json'), 'utf8')).not.toContain('second')
  })

  it('removes the pointer when the very first activation is rolled back', async () => {
    const root = scratchDir()
    writeUserTeam(root)

    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)

    await expect(hostPlugin(ctx as never, { agents: { ghost: { enabled: true } } }))
      .rejects.toThrow(/unknown agent "ghost"/)
    // Nothing was ever accepted, so nothing may be pointed at.
    expect(readCurrentGeneration(root)).toBeUndefined()
  })

  it('declares the cordis metadata the bundle patch depends on', () => {
    expect(pluginName).toBe('banbo-agents')
    expect(inject).toContain('agentPresets')
    expect(inject).toContain('dshHomePath')
    expect(inject).toContain('settings')
    expect(typeof hostPlugin).toBe('function')
    // The row Config IS the settings form in 0.1.7: the two editable fields are
    // volatile (so a write commits without a remount) and the deployment fields
    // are ordinary. The Loader wraps the volatile ones in references, which is
    // why the parsed value is read back through `get()`.
    const parsed = Config({ enabled: false, rootDir: '/probe' }) as Record<string, any>
    expect(parsed.enabled).toBe(false)
    expect(parsed.rootDir).toBe('/probe')
    expect(parsed.includeDefaults.get()).toBe(true)
    expect(parsed.agents.get()).toEqual({})
    expect(() => Config({ agents: 'nope' } as never)).toThrow(/agents/)
  })

  it('publishes built-in provenance for includeDefaults policy', () => {
    const state = init(scratchDir())
    expect([...(state as any).builtinIds].sort()).toEqual([
      'banbo', 'executor', 'explorer', 'implement', 'planner', 'research', 'review',
    ])
  })

  it('publishes a live settings view over this row\'s Config references', async () => {
    const root = scratchDir()
    let current = { includeDefaults: true, agents: {} as Record<string, unknown> }
    const includeDefaults = { get: () => current.includeDefaults }
    const agents = { get: () => current.agents }
    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)
    const provide = vi.spyOn(ctx, 'provide')

    await hostPlugin(ctx as never, { includeDefaults, agents })
    const provided = ctx.get('banboAgents') as any

    expect(provide).toHaveBeenCalledWith('banboAgents', expect.objectContaining({ settings: expect.anything() }))
    expect(ctx.get('banboAgentsCatalog')).toBeDefined()
    expect(provided.settings.get()).toEqual({ includeDefaults: true, agents: {} })
    expect(provided.settings.policy('banbo').effectiveEnabled).toBe(true)

    // A settings write commits into the SAME reference (that is what `.volatile()`
    // buys), so the next policy read sees it with no restart and no cache.
    current = { includeDefaults: false, agents: {} }
    expect(provided.settings.policy('banbo').effectiveEnabled).toBe(false)
  })

  it('refuses a settings entry naming an agent that was never published', async () => {
    const root = scratchDir()
    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)

    await expect(hostPlugin(ctx as never, {
      includeDefaults: true,
      agents: { ghost: { enabled: false } },
    })).rejects.toThrow(/unknown agent "ghost"/)
  })

  it('emits one privacy-safe catalog/generation record at startup (§13.1.1)', async () => {
    const root = scratchDir()
    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)
    const info = vi.spyOn(ctx.logger, 'info')

    await hostPlugin(ctx as never, {})

    const record = info.mock.calls.find(([event]) => event === 'banbo-agents: catalog/generation')
    expect(record, 'catalog/generation must be emitted once at startup').toBeDefined()
    const fields = record![1] as Record<string, unknown>
    // Exact field set: this event answers "reused or newly written, and how
    // many agents", and nothing else.
    expect(Object.keys(fields).sort()).toEqual(['agentCount', 'generation', 'reused'])
    expect(typeof fields.generation).toBe('string')
    expect(fields.agentCount).toBe(7)
    expect(typeof fields.reused).toBe('boolean')
    // Privacy boundary: no host path and no persona/prompt text.
    const serialized = JSON.stringify(fields)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain('#')
  })
})
