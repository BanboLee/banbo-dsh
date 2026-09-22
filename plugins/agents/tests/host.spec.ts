/**
 * Specification for `plugins/agents/index.js` — Host-side assembly
 * (docs/agents-plugin-plan.md §8.4, §9.1, §9.2).
 *
 * The Host has one job before anything else may run: read the built-in and user
 * catalog, merge and validate it, and publish an immutable generation the
 * roster can mount. Two properties are non-negotiable and are what this suite
 * pins down:
 *
 *   - **nothing is published half-done** — a bad user file must fail the whole
 *     startup with the old generation still active and complete;
 *   - **the generated root is a mirror, not an accumulator** — deleting a
 *     definition removes its preset from the next generation while its ABI
 *     record survives as a retired shell (§6.3, §11.2).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import hostPlugin, {
  Config,
  dependencyFamilyVersion,
  findPresetIdConflicts,
  initialiseCatalog,
  inject,
  name as pluginName,
  shippedPresetIds,
  verifyRosterRoots,
} from '../index.js'
import { readCurrentGeneration } from '../preset-compiler.js'
import { IDENTITY_TEXT } from '../main-runtime.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.2', '@deepseek-ai/dsh-agent': '^0.1.6' },
    })).toThrow(/family|uniform|one range/i)
  })

  it('is content, not a host path — the same manifest gives the same answer', () => {
    const manifest = { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.2' } }
    expect(dependencyFamilyVersion(manifest)).toBe(dependencyFamilyVersion(manifest))
  })
})

describe('shippedPresetIds', () => {
  it('lists the preset directories the package ships', () => {
    expect([...shippedPresetIds()].sort()).toEqual(['banbo', 'planner'])
  })
})

/* ----------------------------------------------------------- host startup --- */

describe('initialiseCatalog — Host startup (§9.2)', () => {
  it('loads the built-in catalog and activates a valid empty generation', () => {
    const root = scratchDir()
    const state = init(root)
    expect([...state.definitions.keys()]).toEqual(['banbo', 'executor', 'explorer', 'implement', 'planner', 'research', 'review'])
    expect(state.reused).toBe(false)
    // The built-in main agents ship in the package, so nothing is generated.
    expect(readdirSync(join(state.generationDir, 'presets'))).toEqual([])
    expect(existsSync(join(root, '.generated', 'current', 'complete'))).toBe(true)
    expect(state.presetRootDir).toBe(join(root, '.generated', 'current', 'presets'))
  })

  it('compiles a user main agent into a mountable preset', () => {
    const root = scratchDir()
    writeUserTeam(root)
    const state = init(root)
    const generated = join(root, '.generated', 'current', 'presets')
    expect(readdirSync(generated)).toEqual(['my-lead'])
    const composition = readFileSync(join(generated, 'my-lead', 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain('agentId: my-lead')
    expect(readFileSync(join(generated, 'my-lead', 'preset.yml'), 'utf8')).toMatch(/^name: /m)
    // `helper` is child-only, so it contributes no preset of its own.
    expect(state.abi.agents.map((record: { id: string }) => record.id)).toEqual([
      'banbo', 'executor', 'explorer', 'helper', 'implement', 'my-lead', 'planner', 'research', 'review',
    ])
  })

  it('keeps the harness placeholders in the generated composition', () => {
    const root = scratchDir()
    writeUserTeam(root)
    init(root)
    const composition = readFileSync(join(root, '.generated', 'current', 'presets', 'my-lead', 'agent.cordis.yml'), 'utf8')
    // `{{cwd}}` belongs to the harness and must survive rendering verbatim in a
    // real config VALUE. Asserting it against the whole file is not enough: the
    // previous version of this test was satisfied by a template COMMENT that
    // merely mentioned `{{model}}`, so it passed while the value was absent.
    expect(composition).toContain('suffix: Your working directory is {{cwd}}.')
    // `{{agentId}}` is ours and must be substituted away.
    expect(composition).not.toContain('{{agentId}}')
    // `{{model}}` is deliberately NOT carried by the composition any more: the
    // identity line that uses it is registered at runtime under a section name
    // the child composition cannot shadow. Assert it where it actually lives.
    expect(IDENTITY_TEXT).toContain('{{model}}')
    expect(composition).not.toContain('{{model}}')
  })

  it('does not regenerate a preset that already ships in the package', () => {
    const root = scratchDir()
    // Shadow the built-in `banbo` definition: the package preset still wins.
    write(root, 'agents/banbo.yaml', 'id: banbo\ndisplayName: Banbo\ndescription: shadow\nallowedChildren: []\nmain:\n  presetId: banbo\n  persona: prompts/banbo-main.md\n  tools: [read]\n  maxDepth: 0\n')
    const state = init(root)
    expect(readdirSync(join(state.generationDir, 'presets'))).toEqual([])
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
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toEqual(['my-lead'])
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
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toEqual([])
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
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toEqual([])

    writeUserTeam(root)
    const revived = init(root)
    expect(revived.abi.agents.find((entry: { id: string }) => entry.id === 'my-lead')?.retired).toBeFalsy()
    expect(readdirSync(join(root, '.generated', 'current', 'presets'))).toContain('my-lead')
  })
})

/* ------------------------------------------------------- roster integrity --- */

describe('findPresetIdConflicts — §8.5 duplicate ids', () => {
  it('reports both sources instead of letting the earlier root win', () => {
    const first = scratchDir()
    const second = scratchDir()
    for (const root of [first, second]) {
      mkdirSync(join(root, 'clash'), { recursive: true })
      writeFileSync(join(root, 'clash', 'preset.yml'), 'name: Clash\n')
    }
    const conflicts = findPresetIdConflicts([{ path: first }, { path: second }])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].presetId).toBe('clash')
    expect(conflicts[0].paths).toEqual([join(first, 'clash'), join(second, 'clash')])
  })

  it('ignores directories that are not presets and roots that do not exist', () => {
    const root = scratchDir()
    mkdirSync(join(root, 'not-a-preset'), { recursive: true })
    expect(findPresetIdConflicts([{ path: root }, { path: join(root, 'absent') }])).toEqual([])
  })
})

describe('verifyRosterRoots — §8.4 fail-loud root check', () => {
  it('accepts a root spelled with a trailing separator', () => {
    const root = scratchDir()
    expect(() => verifyRosterRoots([{ path: `${root}/` }], [root])).not.toThrow()
  })

  it('names every root the roster is missing', () => {
    const root = scratchDir()
    expect(() => verifyRosterRoots([{ path: '/somewhere/else' }], [root, `${root}/generated`]))
      .toThrow(/generated/)
  })

  it('accepts a root reached through a symlink (linked / source install)', () => {
    // `dsh plugin add -w ./plugins/agents` installs a `link:`, so the roster
    // stores the symlinked path while `import.meta.url` inside the package
    // reports the checkout path. Comparing those two lexically rejected a
    // correct install and blamed another bundle for it.
    const real = scratchDir()
    mkdirSync(join(real, 'presets'), { recursive: true })
    const holder = scratchDir()
    const linked = join(holder, 'node_modules', '@banbolee', 'dsh-agents')
    mkdirSync(dirname(linked), { recursive: true })
    symlinkSync(real, linked, 'dir')

    expect(() => verifyRosterRoots([{ path: join(linked, 'presets') }], [join(real, 'presets')])).not.toThrow()
    // The reverse direction must work too: real on the roster, link expected.
    expect(() => verifyRosterRoots([{ path: join(real, 'presets') }], [join(linked, 'presets')])).not.toThrow()
  })

  it('still reports a genuinely absent root as missing', () => {
    const root = scratchDir()
    const holder = scratchDir()
    const dangling = join(holder, 'node_modules', 'gone')
    mkdirSync(dirname(dangling), { recursive: true })
    symlinkSync(join(holder, 'does-not-exist'), dangling, 'dir')

    expect(() => verifyRosterRoots([{ path: dangling }], [join(root, 'presets')])).toThrow(/missing/i)
  })
})

/* ------------------------------------------------------------ plugin row --- */

describe('the Host plugin row', () => {
  it('rolls the pointer back when a post-activation startup step fails (§9.2)', async () => {
    // `compilePresets` activates while compiling, so a settings-registration
    // failure used to leave the NEW generation live for a catalog that never
    // ran. The previous generation must stay pointed at instead.
    const root = scratchDir()
    writeUserTeam(root)
    const first = init(root)

    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)
    ctx.provide('agentPresets', {
      roots: [
        { path: pluginRoot + '/presets' },
        { path: join(root, '.generated', 'current', 'presets') },
      ],
    })
    ctx.provide('settings', {
      register: () => { throw new Error('settings namespace refused') },
    })

    // Add a second agent so the candidate catalog differs from the live one.
    write(root, 'agents/second.yaml', 'id: second\ndisplayName: Second\ndescription: probe\nallowedChildren: []\nmain:\n  presetId: second\n  persona: prompts/my-lead-main.md\n  tools: [read]\n  maxDepth: 0\n')

    await expect(hostPlugin(ctx as never, {})).rejects.toThrow(/settings namespace refused/)

    expect(readCurrentGeneration(root)).toBe(first.generationDir)
    expect(readFileSync(join(first.generationDir, 'abi.json'), 'utf8')).not.toContain('second')
  })

  it('removes the pointer when the very first activation is rolled back', async () => {
    const root = scratchDir()
    writeUserTeam(root)

    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)
    ctx.provide('agentPresets', {
      roots: [
        { path: pluginRoot + '/presets' },
        { path: join(root, '.generated', 'current', 'presets') },
      ],
    })
    ctx.provide('settings', {
      register: () => { throw new Error('settings namespace refused') },
    })

    await expect(hostPlugin(ctx as never, {})).rejects.toThrow(/settings namespace refused/)
    // Nothing was ever accepted, so nothing may be pointed at.
    expect(readCurrentGeneration(root)).toBeUndefined()
  })

  it('declares the cordis metadata the bundle patch depends on', () => {
    expect(pluginName).toBe('banbo-agents')
    expect(inject).toContain('agentPresets')
    expect(inject).toContain('dshHomePath')
    expect(inject).toContain('settings')
    expect(typeof hostPlugin).toBe('function')
    expect(Config['~standard'].validate({}).value).toEqual({ rootDir: undefined, enabled: true })
  })

  it('publishes built-in provenance for includeDefaults policy', () => {
    const state = init(scratchDir())
    expect([...(state as any).builtinIds].sort()).toEqual([
      'banbo', 'executor', 'explorer', 'implement', 'planner', 'research', 'review',
    ])
  })

  it('registers the official settings namespace and publishes a live SettingsView', async () => {
    const root = scratchDir()
    const settingsValue = { includeDefaults: true, agents: {} }
    let current = settingsValue
    const scope = { get: vi.fn(() => current) }
    const register = vi.fn((_ns, _schema, options) => {
      // Registration owner validation must be catalog-bound before publication.
      options.validate(options.base)
      return scope
    })
    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)
    ctx.provide('agentPresets', {
      roots: [
        { path: pluginRoot + '/presets' },
        { path: join(root, '.generated', 'current', 'presets') },
      ],
    })
    ctx.provide('settings', { register })
    const provide = vi.spyOn(ctx, 'provide')

    await hostPlugin(ctx as never, {})
    const provided = ctx.get('banboAgents') as any

    expect(register).toHaveBeenCalledWith('banbo-agents', expect.anything(), expect.objectContaining({
      base: { includeDefaults: true, agents: {} },
      validate: expect.any(Function),
    }))
    expect(provide).toHaveBeenCalledWith('banboAgents', expect.objectContaining({ settings: expect.anything() }))
    expect(ctx.get('banboAgentsCatalog')).toBeDefined()
    expect(provided.settings.policy('banbo').effectiveEnabled).toBe(true)
    current = { includeDefaults: false, agents: {} }
    expect(provided.settings.policy('banbo').effectiveEnabled).toBe(false)
    // One startup read scans for stale retained entries; each policy call then
    // reads the live scope again instead of consulting a cache.
    expect(scope.get).toHaveBeenCalledTimes(3)
  })

  it('emits one privacy-safe catalog/generation record at startup (§13.1.1)', async () => {
    const root = scratchDir()
    const ctx = new Context()
    ctx.provide('dshHomePath', () => root)
    ctx.provide('agentPresets', {
      roots: [
        { path: pluginRoot + '/presets' },
        { path: join(root, '.generated', 'current', 'presets') },
      ],
    })
    ctx.provide('settings', {
      register: () => ({ get: () => ({ includeDefaults: true, agents: {} }), watch: () => () => {} }),
    })
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
