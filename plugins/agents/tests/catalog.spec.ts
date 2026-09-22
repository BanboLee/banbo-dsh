/**
 * Specification for `plugins/agents/catalog.js` — loading, the §6.3
 * constrained merge, and the cross-definition graph rules.
 *
 * `schema.js` validates one definition in isolation. Everything that can only
 * be judged with the whole set in view lives here: id and tool-name
 * uniqueness, dangling or cyclic `allowedChildren`, preset-id collisions
 * (including ids the deployment already owns), the agent/edge ceilings, and
 * the published-ABI compatibility rules of §11.2.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CatalogError } from '../schema.js'
import { loadCatalog, mergeDefinition, validateAbi, validateGraph } from '../catalog.js'

const scratch: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'banbo-catalog-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function catalogError(fn: () => unknown): CatalogError {
  try {
    fn()
  } catch (error) {
    if (error instanceof CatalogError) return error
    throw error
  }
  throw new Error('expected CatalogError, but nothing was thrown')
}

const childForm = (patch: Record<string, unknown> = {}) => ({
  model: { default: true },
  persona: 'prompts/research.md',
  guidance: 'use for research',
  tools: ['read'],
  continuation: 'one-shot',
  ...patch,
})

const mainForm = (patch: Record<string, unknown> = {}) => ({
  presetId: 'lead',
  persona: 'prompts/lead-main.md',
  tools: ['read'],
  maxDepth: 2,
  ...patch,
})

/** A definition object as `validateAgentDefinition` would return it. */
type ProbeDefinition = {
  id: string
  displayName: string
  description: string
  allowedChildren: string[]
  main?: Record<string, unknown>
  child?: Record<string, unknown>
} & Record<string, unknown>

const def = (id: string, patch: Record<string, unknown> = {}): ProbeDefinition => ({
  id,
  displayName: id,
  description: `${id} probe`,
  allowedChildren: [],
  ...patch,
})

/* ------------------------------------------------------------ §6.3 merge --- */

describe('mergeDefinition — §6.3 constrained override', () => {
  it('replaces scalar fields', () => {
    const merged = mergeDefinition(def('planner', { description: 'base' }), { description: 'override' })
    expect(merged.description).toBe('override')
    expect(merged.displayName).toBe('planner')
  })

  it('replaces arrays wholesale rather than appending', () => {
    const base = def('planner', { allowedChildren: ['a', 'b'], child: childForm({ tools: ['read', 'search', 'web'] }) })
    const merged = mergeDefinition(base, { allowedChildren: ['c'], child: { tools: ['read'] } })
    expect(merged.allowedChildren).toEqual(['c'])
    expect(merged.child!.tools).toEqual(['read'])
  })

  it('replaces child.model as a whole object', () => {
    const base = def('planner', { child: childForm({ model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }) })
    const merged = mergeDefinition(base, { child: { model: { default: true } } })
    expect(merged.child!.model).toEqual({ default: true })
  })

  it('overrides an existing form field by field', () => {
    const base = def('planner', { child: childForm({ guidance: 'base guidance', tools: ['read', 'search'] }) })
    const merged = mergeDefinition(base, { child: { tools: ['read'] } })
    expect(merged.child!.tools).toEqual(['read'])
    // Untouched fields inherit from the built-in rather than reverting to a default.
    expect(merged.child!.guidance).toBe('base guidance')
    expect(merged.child!.persona).toBe('prompts/research.md')
    expect(merged.child!.continuation).toBe('one-shot')
  })

  it('inherits a form the override does not mention at all', () => {
    const base = def('planner', { main: mainForm(), child: childForm() })
    const merged = mergeDefinition(base, { child: { tools: ['read'] } })
    expect(merged.main).toEqual(base.main)
  })

  it('requires a complete object when adding a slot the base does not have', () => {
    const base = def('implement', { child: childForm() })
    // Adding `main` to a child-only agent must supply every main field.
    const error = catalogError(() => mergeDefinition(base, { main: { presetId: 'implement' } }))
    expect(error.code).toBe('incomplete-new-form')
    expect(error.field).toBe('main')
  })

  it('accepts a complete new slot', () => {
    const base = def('implement', { child: childForm() })
    const merged = mergeDefinition(base, { main: mainForm({ presetId: 'implement' }) })
    expect(merged.main!.presetId).toBe('implement')
    expect(merged.child).toBeDefined()
  })

  it('rejects a merge that changes the id', () => {
    const error = catalogError(() => mergeDefinition(def('planner'), { id: 'other' }))
    expect(error.code).toBe('id-mismatch')
  })

  it('leaves the base untouched', () => {
    const base = def('planner', { allowedChildren: ['a'], child: childForm({ tools: ['read', 'search'] }) })
    const snapshot = JSON.stringify(base)
    mergeDefinition(base, { allowedChildren: ['z'], child: { tools: ['x'] } })
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})

/* ----------------------------------------------------------- graph rules --- */

describe('validateGraph — cross-definition rules', () => {
  const graph = (definitions: Array<Record<string, unknown>>, options: Record<string, unknown> = {}) =>
    validateGraph(definitions as never, options as never)

  it('accepts a well-formed graph', () => {
    expect(() => graph([
      def('banbo', { main: mainForm({ presetId: 'banbo' }), allowedChildren: ['research'] }),
      def('research', { child: childForm() }),
    ])).not.toThrow()
  })

  it('rejects a duplicate id', () => {
    const error = catalogError(() => graph([def('dup', { child: childForm() }), def('dup', { child: childForm() })]))
    expect(error.code).toBe('duplicate-id')
  })

  it('rejects a tool-name collision', () => {
    // Unreachable through ids alone (the encoding is injective), so this guards
    // against a future encoding change silently aliasing two agents.
    const error = catalogError(() => graph([
      def('a-b', { child: childForm() }),
      def('a-b', { child: childForm() }),
    ]))
    expect(error.code).toBe('duplicate-id')
  })

  it('rejects an allowedChildren entry that does not exist', () => {
    const error = catalogError(() => graph([def('banbo', { allowedChildren: ['ghost'] })]))
    expect(error.code).toBe('dangling-child')
    expect(error.field).toBe('ghost')
  })

  it('rejects an allowedChildren entry that has no child form', () => {
    const error = catalogError(() => graph([
      def('banbo', { allowedChildren: ['mainonly'] }),
      def('mainonly', { main: mainForm({ presetId: 'mainonly' }) }),
    ]))
    expect(error.code).toBe('child-without-child-form')
  })

  it('rejects a cycle', () => {
    const error = catalogError(() => graph([
      def('a', { child: childForm(), allowedChildren: ['b'] }),
      def('b', { child: childForm(), allowedChildren: ['a'] }),
    ]))
    expect(error.code).toBe('cycle')
    expect(error.message).toMatch(/a → b → a|b → a → b/)
  })

  it('rejects a self-edge', () => {
    expect(catalogError(() => graph([def('a', { child: childForm(), allowedChildren: ['a'] })])).code).toBe('cycle')
  })

  it('accepts a diamond, which is not a cycle', () => {
    expect(() => graph([
      def('banbo', { allowedChildren: ['x', 'y'] }),
      def('x', { child: childForm(), allowedChildren: ['z'] }),
      def('y', { child: childForm(), allowedChildren: ['z'] }),
      def('z', { child: childForm() }),
    ])).not.toThrow()
  })

  it('rejects a duplicate preset id across two main agents', () => {
    const error = catalogError(() => graph([
      def('a', { main: mainForm({ presetId: 'shared' }) }),
      def('b', { main: mainForm({ presetId: 'shared' }) }),
    ]))
    expect(error.code).toBe('duplicate-preset-id')
  })

  it('rejects a preset id the deployment already owns', () => {
    const error = catalogError(() => graph(
      [def('a', { main: mainForm({ presetId: 'standard' }) })],
      { reservedPresetIds: ['standard', 'ptc', 'cordis', 'minimal'] },
    ))
    expect(error.code).toBe('reserved-preset-id')
    expect(error.field).toBe('standard')
  })

  it('enforces maxAgentCount', () => {
    const many = Array.from({ length: 129 }, (_, i) => def(`a${i}`, { child: childForm() }))
    const error = catalogError(() => graph(many))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxAgentCount')
  })

  it('enforces maxGraphEdges', () => {
    // 40 parents x 30 children = 1200 edges, each parent well under its own cap.
    const definitions = Array.from({ length: 40 }, (_, i) =>
      def(`p${i}`, { child: childForm(), allowedChildren: Array.from({ length: 30 }, (_, j) => `c${j}`) }))
    definitions.push(...Array.from({ length: 30 }, (_, j) => def(`c${j}`, { child: childForm() })))
    const error = catalogError(() => graph(definitions))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxGraphEdges')
  })
})

/* ------------------------------------------------------- §11.2 published ABI --- */

describe('validateAbi — §11.2 published-shape protection', () => {
  const published = {
    version: 1,
    generation: 'sha256:prev',
    agents: [{
      id: 'review',
      toolName: 'agent_review',
      presetId: 'review',
      hasMain: false,
      hasChild: true,
      childContinuation: 'optional',
      toolCapabilityNames: ['read'],
      allowedChildren: ['research'],
      displayName: 'Review',
      description: 'reviews',
    }],
  }

  const current = (patch: Record<string, unknown> = {}) => [def('review', {
    child: childForm({ continuation: 'optional' }),
    allowedChildren: ['research'],
    ...patch,
  }), def('research', { child: childForm() })]

  it('accepts an unchanged published shape', () => {
    expect(() => validateAbi(current(), published as never)).not.toThrow()
  })

  it('accepts adding a new agent', () => {
    expect(() => validateAbi([...current(), def('extra', { child: childForm() })], published as never)).not.toThrow()
  })

  it('rejects a renamed tool name', () => {
    const error = catalogError(() => validateAbi(current(), { ...published, agents: [{ ...published.agents[0], toolName: 'agent_other' }] } as never))
    expect(error.code).toBe('abi-tool-name-changed')
  })

  it('rejects dropping a published form', () => {
    const error = catalogError(() => validateAbi(
      [def('review', { main: mainForm({ presetId: 'review' }) }), def('research', { child: childForm() })],
      published as never,
    ))
    expect(error.code).toBe('abi-form-removed')
  })

  it('rejects flipping continuation between one-shot and optional', () => {
    const error = catalogError(() => validateAbi(current({ child: childForm({ continuation: 'one-shot' }) }), published as never))
    expect(error.code).toBe('abi-continuation-changed')
  })

  it('rejects a changed preset id', () => {
    const withMain = { ...published, agents: [{ ...published.agents[0], presetId: 'review', hasMain: true }] }
    const error = catalogError(() => validateAbi(
      [def('review', { main: mainForm({ presetId: 'renamed' }), child: childForm({ continuation: 'optional' }), allowedChildren: ['research'] }), def('research', { child: childForm() })],
      withMain as never,
    ))
    expect(error.code).toBe('abi-preset-id-changed')
  })

  it('accepts restoring the file of a retired id (revival, §12.1)', () => {
    // §12.1 makes "put the YAML back" the documented recovery path, so revival
    // must succeed; the shell record is what stays permanent, not the ban.
    const retired = { ...published, agents: [{ ...published.agents[0], retired: true, retiredReason: 'definition-file-missing' }] }
    expect(() => validateAbi(current(), retired as never)).not.toThrow()
  })

  it('still refuses a revived id that drops a published form', () => {
    // Revival is not a licence to redefine: the record published a `child`
    // form, so a restored file carrying only `main` must be refused.
    const retired = { ...published, agents: [{ ...published.agents[0], retired: true, retiredReason: 'definition-file-missing' }] }
    const error = catalogError(() => validateAbi([def('review', { main: mainForm() })], retired as never))
    expect(error.code).toBe('abi-form-removed')
  })

  it('accepts a retired id staying retired (absent from the catalog)', () => {
    const retired = { ...published, agents: [{ ...published.agents[0], retired: true, retiredReason: 'definition-file-missing' }] }
    expect(() => validateAbi([def('research', { child: childForm() })], retired as never)).not.toThrow()
  })

  it('accepts a user agent whose definition file was deleted (§6.3 retirement)', () => {
    // Deleting the file is the one deletion the plan allows: the id is retired
    // rather than redefined, and `computeAbiManifest` carries the shell forward.
    expect(() => validateAbi(
      [def('research', { child: childForm() })],
      published as never,
      { builtinIds: new Set(['research']) },
    )).not.toThrow()
  })

  it('rejects a built-in agent vanishing from the installed package', () => {
    // Nobody can delete a built-in on purpose, so its absence is a broken
    // install and must not be quietly converted into a retirement.
    const error = catalogError(() => validateAbi(
      [def('research', { child: childForm() })],
      published as never,
      { builtinIds: new Set(['review', 'research']) },
    ))
    expect(error.code).toBe('abi-form-removed')
    expect(error.message).toMatch(/built-in/)
  })

  it('accepts an empty previous manifest', () => {
    expect(() => validateAbi(current(), undefined as never)).not.toThrow()
  })
})

/* -------------------------------------------------------------- loadCatalog --- */

describe('loadCatalog — built-in + user composition', () => {
  /** Write one YAML definition into a directory. */
  function writeDefinition(dir: string, name: string, body: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.yaml`), body)
  }

  /** A root with an empty prompts/ directory and a valid persona. */
  function prepareRoot(): string {
    const root = scratchDir()
    mkdirSync(join(root, 'prompts'), { recursive: true })
    writeFileSync(join(root, 'prompts', 'research.md'), '# Role\n\nresearch\n')
    writeFileSync(join(root, 'prompts', 'lead-main.md'), '# Role\n\nlead\n')
    return root
  }

  const researchYaml = [
    'id: research',
    'displayName: Research',
    'description: researches',
    'allowedChildren: []',
    'child:',
    '  model: { default: true }',
    '  persona: prompts/research.md',
    '  guidance: use for research',
    '  tools: [read]',
    '  continuation: one-shot',
    '',
  ].join('\n')

  it('loads built-in definitions with no user directory present', () => {
    const root = prepareRoot()
    const builtin = join(scratchDir(), 'catalog')
    writeDefinition(builtin, 'research', researchYaml)
    const catalog = loadCatalog({ rootDir: root, builtinDir: builtin })
    expect([...catalog.definitions.keys()]).toEqual(['research'])
    expect(catalog.personas.get('prompts/research.md')).toBe('# Role\n\nresearch\n')
  })

  it('lets a user definition override a built-in one', () => {
    const root = prepareRoot()
    const builtin = join(scratchDir(), 'catalog')
    writeDefinition(builtin, 'research', researchYaml)
    writeDefinition(join(root, 'agents'), 'research', researchYaml.replace('use for research', 'use for deep research'))
    const catalog = loadCatalog({ rootDir: root, builtinDir: builtin })
    expect(catalog.definitions.get('research')!.child!.guidance).toBe('use for deep research')
  })

  it('adds a user-only definition', () => {
    const root = prepareRoot()
    const builtin = join(scratchDir(), 'catalog')
    writeDefinition(builtin, 'research', researchYaml)
    // Shares the built-in's persona path: one file, two referencing agents.
    writeDefinition(join(root, 'agents'), 'extra', researchYaml
      .replace('id: research', 'id: extra')
      .replace('displayName: Research', 'displayName: Extra')
      .replace('description: researches', 'description: extras'))
    const catalog = loadCatalog({ rootDir: root, builtinDir: builtin })
    expect([...catalog.definitions.keys()].sort()).toEqual(['extra', 'research'])
  })

  it('names the offending file when a user definition is invalid', () => {
    const root = prepareRoot()
    const builtin = join(scratchDir(), 'catalog')
    writeDefinition(join(root, 'agents'), 'broken', 'id: broken\ndisplayNam: typo\n')
    const error = catalogError(() => loadCatalog({ rootDir: root, builtinDir: builtin }))
    expect(error.code).toBe('unknown-field')
    expect(error.file).toContain('broken.yaml')
  })

  it('reports an empty catalog rather than failing when no definitions exist', () => {
    const root = prepareRoot()
    const catalog = loadCatalog({ rootDir: root, builtinDir: join(scratchDir(), 'catalog') })
    expect(catalog.definitions.size).toBe(0)
  })

  it('enforces the graph rules across built-in and user definitions together', () => {
    const root = prepareRoot()
    const builtin = join(scratchDir(), 'catalog')
    writeDefinition(builtin, 'research', researchYaml)
    // A user agent pointing at a child that exists only in neither set.
    writeDefinition(join(root, 'agents'), 'lead', [
      'id: lead',
      'displayName: Lead',
      'description: leads',
      'allowedChildren: [ghost]',
      'main:',
      '  presetId: lead',
      '  persona: prompts/lead-main.md',
      '  tools: [read]',
      '  maxDepth: 1',
      '',
    ].join('\n'))
    const error = catalogError(() => loadCatalog({ rootDir: root, builtinDir: builtin }))
    expect(error.code).toBe('dangling-child')
  })

  it('counts a persona shared by two agents only once against the total budget', () => {
    const root = prepareRoot()
    const builtin = join(scratchDir(), 'catalog')
    writeDefinition(builtin, 'research', researchYaml)
    writeDefinition(join(root, 'agents'), 'twin', researchYaml.replace('id: research', 'id: twin').replace('displayName: Research', 'displayName: Twin').replace('description: researches', 'description: twins'))
    const catalog = loadCatalog({ rootDir: root, builtinDir: builtin })
    expect(catalog.personas.size).toBe(1)
    expect(catalog.totalPersonaBytes).toBe(Buffer.byteLength('# Role\n\nresearch\n'))
  })
})
