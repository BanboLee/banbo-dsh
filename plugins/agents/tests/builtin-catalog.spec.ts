/**
 * Integration check for the package's own built-in catalog.
 *
 * The unit suites validate the loader against synthetic fixtures. This one runs
 * it against the files that actually ship, so a typo in `catalog/*.yaml` or a
 * persona that drifts from the §5.3 skeleton fails here rather than at a user's
 * first startup.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { loadCatalog } from '../catalog.js'
import { TOOL_CAPABILITIES } from '../schema.js'
import { CAPABILITY_TOOLS } from '../tool-surface.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtinDir = join(pluginRoot, 'catalog')

const scratch: string[] = []
function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'banbo-builtin-'))
  scratch.push(root)
  mkdirSync(join(root, 'prompts'), { recursive: true })
  return root
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** Load the shipped catalog against an empty user layer. */
function loadBuiltin() {
  return loadCatalog({ rootDir: emptyRoot(), builtinDir })
}

/** Body text of one `# Heading` section, trimmed, up to the next top-level heading. */
function sectionBody(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return ''
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith('# ')) break
    body.push(lines[index]!)
  }
  return body.join('\n').trim()
}

/** §5.3 fixes these headings and their order so persona lint is mechanical. */
const REQUIRED_HEADINGS = [  '# Role',
  '# Responsibilities',
  '# Non-goals',
  '# Tool Policy',
  '# Delegation Policy',
  '# Collaboration Protocol',
  '# Output Contract',
  '# Failure Policy',
]

describe('built-in catalog loads', () => {
  it('ships exactly the seven documented agents', () => {
    const { definitions } = loadBuiltin()
    expect([...definitions.keys()].sort()).toEqual([
      'banbo', 'executor', 'explorer', 'implement', 'planner', 'research', 'review',
    ])
  })

  it('composes without a user agents/ directory at all', () => {
    // A fresh install has no `$DSH_HOME/banbo-agents/agents/`; that must be an
    // empty layer rather than an error.
    expect(() => loadBuiltin()).not.toThrow()
  })

  it('matches the §5.1 authorisation matrix', () => {
    const { definitions } = loadBuiltin()
    const edges = Object.fromEntries(
      [...definitions.values()].map((definition) => [definition.id, [...definition.allowedChildren].sort()]),
    )
    expect(edges).toEqual({
      banbo: ['executor', 'explorer', 'implement', 'planner', 'research', 'review'],
      planner: ['explorer', 'research', 'review'],
      executor: ['explorer', 'implement', 'research', 'review'],
      implement: ['explorer', 'research'],
      review: ['explorer', 'research'],
      research: [],
      explorer: [],
    })
  })

  it('matches the §5.1 forms, depth caps and continuation modes', () => {
    const { definitions } = loadBuiltin()
    const shape = Object.fromEntries([...definitions.values()].map((definition) => [definition.id, {
      main: definition.main === undefined ? undefined : definition.main.maxDepth,
      child: definition.child === undefined ? undefined : definition.child.continuation,
    }]))
    expect(shape).toEqual({
      banbo: { main: 2, child: undefined },
      planner: { main: 1, child: 'optional' },
      executor: { main: undefined, child: 'optional' },
      implement: { main: undefined, child: 'optional' },
      review: { main: undefined, child: 'optional' },
      research: { main: undefined, child: 'one-shot' },
      explorer: { main: undefined, child: 'one-shot' },
    })
  })

  it('gives every main form a distinct preset id equal to its agent id', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.main === undefined) continue
      expect(definition.main.presetId, definition.id).toBe(definition.id)
    }
  })

  it('keeps `goal` and `present` off every child form (§5.2)', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.child === undefined) continue
      expect(definition.child.tools, definition.id).not.toContain('goal')
      expect(definition.child.tools, definition.id).not.toContain('present')
    }
  })

  it('keeps shell, write and agent-control away from the one-shot agents (§5.2)', () => {
    const { definitions } = loadBuiltin()
    for (const id of ['research', 'explorer']) {
      const tools = definitions.get(id)!.child!.tools
      expect(tools, id).not.toContain('exec')
      expect(tools, id).not.toContain('write')
      expect(tools, id).not.toContain('edit')
      expect(tools, id).not.toContain('agent-control')
    }
  })

  it('uses only capabilities from the closed set', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      for (const form of [definition.main, definition.child]) {
        for (const capability of form?.tools ?? []) {
          expect(TOOL_CAPABILITIES, `${definition.id}: ${capability}`).toContain(capability)
        }
      }
    }
  })

  it('loads every referenced persona', () => {
    const { personas } = loadBuiltin()
    expect([...personas.keys()].sort()).toEqual([
      'prompts/banbo-main.md',
      'prompts/executor-child.md',
      'prompts/explorer-child.md',
      'prompts/implement-child.md',
      'prompts/planner-child.md',
      'prompts/planner-main.md',
      'prompts/research-child.md',
      'prompts/review-child.md',
    ])
  })

  it('gives every child explicit when-to-use and when-not-to-use guidance', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.child === undefined) continue
      expect(definition.child.guidance, `${definition.id} when-to-use`).toMatch(/当.+时使用/)
      expect(definition.child.guidance, `${definition.id} when-not-to-use`).toContain('不要使用')
    }
  })
})

describe('built-in personas follow the §5.3 skeleton', () => {
  const personaFiles = [
    'banbo-main.md',
    'planner-main.md',
    'planner-child.md',
    'executor-child.md',
    'implement-child.md',
    'review-child.md',
    'research-child.md',
    'explorer-child.md',
  ]

  it('carries every required heading exactly once with a non-empty section', () => {
    for (const name of personaFiles) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      const positions = REQUIRED_HEADINGS.map((heading) => {
        const matches = [...text.matchAll(new RegExp(`^${heading}$`, 'gm'))]
        expect(matches.length, `${name} must carry "${heading}" exactly once`).toBe(1)
        return matches[0]!.index
      })
      positions.forEach((start, index) => {
        const end = index + 1 < positions.length ? positions[index + 1]! : text.length
        const body = text.slice(start + REQUIRED_HEADINGS[index]!.length, end).trim()
        expect(body.length, `${name} section "${REQUIRED_HEADINGS[index]}" must not be empty`).toBeGreaterThan(0)
      })
    }
  })

  it('mentions only runtime tools its capability set actually grants', () => {
    const { definitions, personas } = loadBuiltin()
    // Distinctive names only: the shared English verbs (`read`, `write`, `edit`,
    // `skill`, `goal`, `present`) would match ordinary prose, so the curated
    // list in the sibling test keeps covering those.
    const ambiguous = new Set(['read', 'write', 'edit', 'skill', 'goal', 'present'])
    const runtimeNames = new Set<string>()
    for (const surface of Object.values(CAPABILITY_TOOLS)) {
      for (const group of [surface.all, surface.prefer, surface.optional]) {
        for (const tool of group ?? []) if (!ambiguous.has(tool)) runtimeNames.add(tool)
      }
    }
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const visible = new Set<string>()
        for (const capability of profile.tools) {
          const surface = CAPABILITY_TOOLS[capability]!
          for (const group of [surface.all, surface.prefer, surface.optional]) {
            for (const tool of group ?? []) visible.add(tool)
          }
        }
        const text = personas.get(profile.persona)!
        for (const tool of runtimeNames) {
          if (visible.has(tool)) continue
          expect(new RegExp(`\\b${tool}\\b`).test(text), `${definition.id}.${form} persona mentions ungranted tool "${tool}"`).toBe(false)
        }
      }
    }
  })

  it('names no agent_* tool outside its own allowed children', () => {
    const { definitions, personas } = loadBuiltin()
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const allowed = new Set(definition.allowedChildren.map((child) => `agent_${child}`))
        const text = personas.get(profile.persona)!
        for (const match of text.matchAll(/\bagent_[A-Za-z0-9_]+/g)) {
          expect(allowed.has(match[0]), `${definition.id}.${form} names unknown/unauthorized tool ${match[0]}`).toBe(true)
        }
      }
    }
  })

  it('carries every required heading in the fixed order', () => {
    for (const name of personaFiles) {
      // Prefix a newline so `# Role` as the very first line is matched by the
      // same `\n<heading>\n` pattern as every other heading.
      const text = `\n${readFileSync(join(pluginRoot, 'prompts', name), 'utf8')}`
      const seen = REQUIRED_HEADINGS.map((heading) => text.indexOf(`\n${heading}\n`))
      expect(seen.every((index) => index >= 0), `${name} is missing a required heading`).toBe(true)
      const ordered = [...seen].sort((left, right) => left - right)
      expect(seen, `${name} has headings out of order`).toEqual(ordered)
    }
  })

  it('never promises a capability the tool layer does not have (§5.3)', () => {
    const forbidden = [
      /独立\s*sandbox/,
      /read-only 文件系统/,
      /可靠地?硬杀/,
      /settlement notice 一定已被父模型消费/,
      /主 Agent 可由本插件指定模型/,
      /禁用 Agent 会立即从 picker 消失/,
      /deadline 会硬杀同进程代码/,
    ]
    for (const name of personaFiles) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false)
      }
    }
  })

  it('gives the one-shot agents no continuation vocabulary (§5.3)', () => {
    for (const name of ['research-child.md', 'explorer-child.md']) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      for (const tool of ['send_message', 'list_agents', 'interrupt_agent']) {
        expect(text.includes(tool), `${name} mentions ${tool}`).toBe(false)
      }
    }
  })

  it('does not name a tool an agent cannot see (§5.3)', () => {
    const { definitions, personas } = loadBuiltin()
    const named = ['read', 'search', 'web', 'exec', 'write', 'edit', 'skill', 'todo', 'jobs', 'ask-user', 'goal', 'present']
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const text = personas.get(profile.persona)!
        for (const tool of named) {
          if (profile.tools.includes(tool)) continue
          // Word-boundary match so `read` inside `read-only` is not a hit.
          expect(new RegExp(`\\b${tool}\\b`).test(text), `${definition.id}.${form} persona mentions invisible tool "${tool}"`).toBe(false)
        }
      }
    }
  })

  it('documents agent-control only where visible, including all three operations', () => {
    const { definitions, personas } = loadBuiltin()
    const controlTools = ['list_agents', 'send_message', 'interrupt_agent']
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const text = personas.get(profile.persona)!
        for (const tool of controlTools) {
          expect(text.includes(tool), `${definition.id}.${form} ${tool} visibility`)
            .toBe(profile.tools.includes('agent-control'))
        }
      }
    }
  })

  it('gives every main persona the complete team protocol (§5.3)', () => {
    const { definitions, personas } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.main === undefined) continue
      const text = personas.get(definition.main.persona)!
      for (const term of ['list_agents', 'send_message', 'continuable', 'delegate_batch', 'one-shot', 'deadline', 'childId']) {
        expect(text.includes(term), `${definition.id}.main is missing ${term}`).toBe(true)
      }
      expect(text).toMatch(/并发.{0,12}(超限|额度)/s)
      expect(text).toMatch(/(cancel_requested|cleanup_deferred).{0,30}(不|不能).{0,10}(完成|completed)/s)
    }
  })

  it('keeps the shared child collaboration sentence byte-identical', () => {
    // Each continuable child persona opens `# Collaboration Protocol` with an
    // agent-specific lead-in, then repeats one shared mechanics sentence. The
    // duplication is deliberate (every persona stays self-contained and
    // independently overridable), so this test is what keeps it from drifting:
    // editing one file without the others fails here rather than silently
    // teaching one agent a different protocol.
    const continuableChildren = ['planner-child.md', 'executor-child.md', 'implement-child.md', 'review-child.md']
    const marker = '用 `list_agents`'

    const tails = continuableChildren.map((name) => {
      const section = sectionBody(readFileSync(join(pluginRoot, 'prompts', name), 'utf8'), '# Collaboration Protocol')
      const at = section.indexOf(marker)
      expect(at, `${name} must carry the shared mechanics sentence`).toBeGreaterThanOrEqual(0)
      return section.slice(at)
    })

    expect(new Set(tails).size, `the shared sentence drifted:\n${tails.join('\n---\n')}`).toBe(1)
    const shared = tails[0]!
    for (const tool of ['list_agents', 'send_message', 'interrupt_agent']) {
      expect(shared, `shared sentence must name ${tool}`).toContain(tool)
    }
    expect(shared).toContain('不把它当作硬杀')
  })

  it('includes one short evidence-bearing output example per persona', () => {
    for (const name of personaFiles) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      expect(text, `${name} output example`).toMatch(/示例：.{1,160}(依据|文件|来源|命令|风险|未找到)/s)
    }
  })

  it('mentions only allowed named children and never generic creation tools', () => {
    const { definitions, personas } = loadBuiltin()
    const allIds = [...definitions.keys()]
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const text = personas.get(profile.persona)!
        for (const id of allIds) {
          if (id === definition.id || definition.allowedChildren.includes(id)) continue
          expect(text.includes(`agent_${id}`), `${definition.id}.${form} names unauthorized child ${id}`).toBe(false)
        }
        for (const tool of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
          expect(new RegExp(`\\b${tool}\\b`).test(text), `${definition.id}.${form} names forbidden ${tool}`).toBe(false)
        }
      }
    }
  })
})
