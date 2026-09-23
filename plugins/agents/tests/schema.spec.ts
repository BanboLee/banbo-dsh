/**
 * Specification for `plugins/agents/schema.js`.
 *
 * Everything here is deterministic and offline: YAML parsing boundaries
 * (docs/agents-plugin-plan.md §6.1.1), per-definition validation (§4.4), and
 * the resource ceilings (§4.4.1).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CATALOG_LIMITS,
  CatalogError,
  FORBIDDEN_DELEGATION_TOOLS,
  TOOL_CAPABILITIES,
  deriveToolName,
  loadAgentYamlFile,
  parseAgentYaml,
  validateAgentDefinition,
  validateBudget,
} from '../schema.js'

const scratch: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'banbo-schema-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

const FILE = 'agents/probe.yaml'

/** Minimal valid child-only definition. */
const childOnly = {
  id: 'probe',
  displayName: 'Probe',
  description: 'probe agent',
  allowedChildren: [],
  child: {
    model: { default: true },
    persona: 'prompts/probe.md',
    guidance: 'use when probing',
    tools: ['read'],
    continuation: 'one-shot',
  },
}

function catalogError(fn: () => unknown): CatalogError {
  try {
    fn()
  } catch (error) {
    if (error instanceof CatalogError) return error
    throw error
  }
  throw new Error('expected CatalogError, but nothing was thrown')
}

/* ------------------------------------------------- §6.1.1 YAML boundary --- */

describe('parseAgentYaml — §6.1.1 boundary', () => {
  it('accepts a plain JSON-shaped document', () => {
    const doc = parseAgentYaml('id: probe\ndisplayName: Probe\nchild:\n  tools: [read]\n', { file: FILE })
    expect(doc).toEqual({ id: 'probe', displayName: 'Probe', child: { tools: ['read'] } })
  })

  it('gives `<<` a dedicated error naming the key and the file', () => {
    const source = 'base: &b { tools: [read] }\nchild:\n  <<: *b\n'
    const error = catalogError(() => parseAgentYaml(source, { file: FILE }))
    expect(error.code).toBe('unsupported-merge-key')
    expect(error.message).toContain('<<')
    expect(error.file).toBe(FILE)
    expect(error.line).toBeGreaterThan(0)
  })

  it('rejects duplicate keys', () => {
    const error = catalogError(() => parseAgentYaml('id: a\nid: b\n', { file: FILE }))
    expect(error.code).toBe('duplicate-key')
  })

  it('rejects a custom tag instead of silently degrading it to a string', () => {
    // The library itself only WARNS on an unresolved tag and falls back to the
    // raw scalar, so `!!js/function` cannot execute — but a silent no-op is
    // exactly what §6.1.1 exists to prevent. It is promoted to an error.
    const error = catalogError(() => parseAgentYaml('id: !!js/function "() => 1"\n', { file: FILE }))
    expect(error.code).toBe('unsupported-tag')
    expect(error.message).toContain('js/function')
    expect(error.file).toBe(FILE)
    expect(error.line).toBe(1)
  })

  it('rejects a YAML 1.1 explicit tag such as !!timestamp', () => {
    // Left alone this would decode to a Date, which is not losslessly JSON and
    // would poison the ABI manifest downstream.
    const error = catalogError(() => parseAgentYaml('id: !!timestamp 2026-01-01\n', { file: FILE }))
    expect(error.code).toBe('unsupported-tag')
    expect(error.message).toContain('timestamp')
  })

  it('still allows alias value reuse', () => {
    const source = 'common: &t [read, search]\nchild:\n  tools: *t\n'
    const doc = parseAgentYaml(source, { file: FILE }) as { child: { tools: string[] } }
    expect(doc.child.tools).toEqual(['read', 'search'])
  })

  it('bounds nested alias expansion', () => {
    // Each level references the previous 60 times; three levels exceed the
    // 100-alias budget long before the file itself grows large.
    const unit = 'u: &u0 [1, 2, 3]\n'
    const l1 = `a1: &u1 [${Array.from({ length: 60 }, () => '*u0').join(', ')}]\n`
    const l2 = `a2: &u2 [${Array.from({ length: 60 }, () => '*u1').join(', ')}]\n`
    const error = catalogError(() => parseAgentYaml(unit + l1 + l2, { file: FILE }))
    expect(error.code).toBe('yaml-parse')
    expect(error.message).toMatch(/alias/i)
  })

  it('reports the source line for a syntax error', () => {
    const error = catalogError(() => parseAgentYaml('id: probe\n  bad: indent\n', { file: FILE }))
    expect(error.code).toBe('yaml-parse')
    expect(error.file).toBe(FILE)
  })
})

/* ------------------------------------------------- §4.4.1 read ordering --- */

describe('loadAgentYamlFile — size is checked before parsing', () => {
  it('rejects an oversized file without invoking the parser', () => {
    const dir = scratchDir()
    const file = join(dir, 'huge.yaml')
    // Valid YAML syntax, but far past the byte ceiling. If the parser ran
    // first, this would succeed and only then be rejected.
    writeFileSync(file, `id: probe\n#${'x'.repeat(CATALOG_LIMITS.maxYamlBytes)}\n`)
    const error = catalogError(() => loadAgentYamlFile(file))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxYamlBytes')
    expect(error.message).toContain(String(CATALOG_LIMITS.maxYamlBytes))
  })

  it('accepts a file exactly at the ceiling', () => {
    const dir = scratchDir()
    const file = join(dir, 'edge.yaml')
    const body = 'id: probe\n'
    const padding = CATALOG_LIMITS.maxYamlBytes - Buffer.byteLength(body)
    writeFileSync(file, `${body}#${'x'.repeat(padding - 2)}\n`)
    expect(() => loadAgentYamlFile(file)).not.toThrow()
  })

  it('surfaces a missing file as a catalog error', () => {
    const error = catalogError(() => loadAgentYamlFile(join(scratchDir(), 'absent.yaml')))
    expect(error.code).toBe('unreadable-file')
  })
})

/* ------------------------------------------------------- §4.4 definition --- */

describe('validateAgentDefinition — §4.4', () => {
  it('accepts a child-only definition and normalises it', () => {
    const def = validateAgentDefinition(childOnly, { file: FILE })
    expect(def.id).toBe('probe')
    expect(def.child!.continuation).toBe('one-shot')
    expect(def.main).toBeUndefined()
  })

  it('accepts a definition carrying both forms', () => {
    const def = validateAgentDefinition({
      ...childOnly,
      main: { presetId: 'probe', persona: 'prompts/probe-main.md', tools: ['read'], maxDepth: 2 },
    }, { file: FILE })
    expect(def.main!.presetId).toBe('probe')
    expect(def.child).toBeDefined()
  })

  it('requires at least one of main / child', () => {
    const { child: _child, ...noChild } = childOnly
    const error = catalogError(() => validateAgentDefinition(noChild, { file: FILE }))
    expect(error.code).toBe('missing-form')
  })

  it('rejects an id that does not match the tool-name budget', () => {
    for (const id of ['Probe', '1probe', 'pro_be', 'a'.repeat(59)]) {
      const error = catalogError(() => validateAgentDefinition({ ...childOnly, id }, { file: FILE }))
      expect(error.code, `id ${id}`).toBe('bad-id')
    }
    expect(() => validateAgentDefinition({ ...childOnly, id: 'a'.repeat(58) }, { file: FILE })).not.toThrow()
  })

  it('rejects an unknown top-level field with file, line and field name', () => {
    const error = catalogError(() => parseAndValidate('id: probe\ndisplayNam: Probe\n', FILE))
    expect(error.code).toBe('unknown-field')
    expect(error.field).toBe('displayNam')
    expect(error.file).toBe(FILE)
    expect(error.line).toBe(2)
  })

  it('rejects an unknown nested field', () => {
    const error = catalogError(() => parseAndValidate(
      [
        'id: probe',
        'displayName: Probe',
        'description: probe agent',
        'child:',
        '  model: { default: true }',
        '  persona: prompts/p.md',
        '  guidance: g',
        '  tools: [read]',
        '  continuation: one-shot',
        '  extra: 1',
        '',
      ].join('\n'),
      FILE,
    ))
    expect(error.code).toBe('unknown-field')
    expect(error.field).toBe('child.extra')
  })

  it('rejects null as an implicit delete', () => {
    const error = catalogError(() => validateAgentDefinition({ ...childOnly, description: null }, { file: FILE }))
    expect(error.code).toBe('null-not-allowed')
  })

  it('rejects a tool capability outside the closed set', () => {
    const error = catalogError(() => validateAgentDefinition({
      ...childOnly,
      child: { ...childOnly.child, tools: ['read', 'teleport'] },
    }, { file: FILE }))
    expect(error.code).toBe('unknown-tool-capability')
    expect(error.field).toBe('child.tools[1]')
  })

  it('rejects an extraTool that names a forbidden delegation entry point', () => {
    for (const tool of FORBIDDEN_DELEGATION_TOOLS) {
      const error = catalogError(() => validateAgentDefinition({
        ...childOnly,
        child: { ...childOnly.child, extraTools: [tool] },
      }, { file: FILE }))
      expect(error.code, tool).toBe('forbidden-extra-tool')
    }
  })

  it('rejects an extraTool that collides with a reserved or derived name', () => {
    for (const tool of ['run_code', 'delegate_batch', 'agent_probe']) {
      const error = catalogError(() => validateAgentDefinition({
        ...childOnly,
        child: { ...childOnly.child, extraTools: [tool] },
      }, { file: FILE }))
      expect(error.code, tool).toBe('reserved-extra-tool')
    }
  })

  it('requires a complete provider+model pair', () => {
    const withModel = (model: unknown) => ({ ...childOnly, child: { ...childOnly.child, model } })
    expect(catalogError(() => validateAgentDefinition(withModel({ provider: 'p' }), { file: FILE })).code).toBe('bad-model')
    expect(catalogError(() => validateAgentDefinition(withModel({ model: 'm' }), { file: FILE })).code).toBe('bad-model')
    expect(catalogError(() => validateAgentDefinition(withModel({ provider: 'p', model: 'm', reasoningEffort: '' }), { file: FILE })).code).toBe('bad-model')
    expect(() => validateAgentDefinition(withModel({ provider: 'p', model: 'm', reasoningEffort: 'high' }), { file: FILE })).not.toThrow()
  })

  it('rejects an unknown continuation mode', () => {
    const error = catalogError(() => validateAgentDefinition({
      ...childOnly,
      child: { ...childOnly.child, continuation: 'sometimes' },
    }, { file: FILE }))
    expect(error.code).toBe('bad-continuation')
  })

  it('requires a persona reference', () => {
    const { persona: _persona, ...noPersona } = childOnly.child
    const error = catalogError(() => validateAgentDefinition({ ...childOnly, child: noPersona }, { file: FILE }))
    expect(error.code).toBe('missing-field')
    expect(error.field).toBe('child.persona')
  })
})

/* --------------------------------------------------- §4.4 rule 6 budget --- */

describe('validateBudget — §4.4 rule 6', () => {
  it('applies the documented defaults when the budget is absent', () => {
    const def = validateAgentDefinition({ ...childOnly, main: { presetId: 'p', persona: 'prompts/m.md', tools: ['read'], maxDepth: 1 } }, { file: FILE })
    expect(def.main!.budget).toEqual({
      maxConcurrentChildren: 6,
      maxBatchWidth: 4,
      // 30 minutes: a real full-file review exhausted the old 15-minute cap with
      // no output at all, so the run was wasted. See `BUDGET_FIELDS`.
      foregroundDeadlineMs: 1_800_000,
      backgroundDeadlineMs: 1_800_000,
      batchDeadlineMs: 600_000,
      drainGraceMs: 30_000,
    })
  })

  it('accepts an in-range override', () => {
    const resolved = validateBudget({ maxConcurrentChildren: 32, maxBatchWidth: 6 })
    expect(resolved.maxConcurrentChildren).toBe(32)
  })

  it('rejects maxConcurrentChildren outside [1, 32]', () => {
    // The ceiling is guard fidelity: a width budget of 10000 is no guard at all.
    for (const value of [0, -1, 33, 10000, 1.5, Number.NaN]) {
      expect(catalogError(() => validateBudget({ maxConcurrentChildren: value })).code, String(value)).toBe('bad-budget')
    }
  })

  it('rejects maxBatchWidth above the absolute ceiling of 6', () => {
    expect(catalogError(() => validateBudget({ maxBatchWidth: 7 })).code).toBe('bad-budget')
  })

  it('rejects a time budget outside its clamp', () => {
    expect(catalogError(() => validateBudget({ foregroundDeadlineMs: 59_999 })).code).toBe('bad-budget')
    expect(catalogError(() => validateBudget({ backgroundDeadlineMs: 7_200_001 })).code).toBe('bad-budget')
    expect(catalogError(() => validateBudget({ batchDeadlineMs: 0 })).code).toBe('bad-budget')
    expect(catalogError(() => validateBudget({ drainGraceMs: 999 })).code).toBe('bad-budget')
  })

  it('accepts each clamp boundary exactly', () => {
    expect(() => validateBudget({
      foregroundDeadlineMs: 60_000,
      backgroundDeadlineMs: 60_000,
      batchDeadlineMs: 60_000,
      drainGraceMs: 1_000,
    })).not.toThrow()
    expect(() => validateBudget({
      foregroundDeadlineMs: 3_600_000,
      backgroundDeadlineMs: 7_200_000,
      batchDeadlineMs: 1_800_000,
      drainGraceMs: 300_000,
    })).not.toThrow()
  })

  it('rejects an unknown or misspelled budget field instead of using the default', () => {
    // The budget is the width guard: silently keeping the default while the
    // user believes they raised it removes the guard without saying so.
    for (const budget of [{ maxConcurrentChilds: 30 }, { somethingElse: 1 }, { maxBatchWidth: 2, typo: 1 }]) {
      const error = catalogError(() => validateBudget(budget, { file: FILE }))
      expect(error.code, JSON.stringify(budget)).toBe('unknown-field')
    }
    const definitionError = catalogError(() => validateAgentDefinition({
      ...childOnly,
      main: { presetId: 'p', persona: 'prompts/m.md', tools: ['read'], maxDepth: 1, budget: { maxConcurrentChilds: 30 } },
    }, { file: FILE }))
    expect(definitionError.code).toBe('unknown-field')
    expect(definitionError.field).toMatch(/budget\.maxConcurrentChilds/)
  })

  it('rejects a budget that is not a mapping', () => {
    for (const budget of [5, [], 'nope', true]) {
      const error = catalogError(() => validateBudget(budget as never, { file: FILE }))
      expect(error.code, JSON.stringify(budget)).toBe('bad-budget')
    }
  })

  it('rejects maxDepth that is not a non-negative safe integer', () => {
    for (const maxDepth of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = catalogError(() => validateAgentDefinition({
        ...childOnly,
        main: { presetId: 'p', persona: 'prompts/m.md', tools: ['read'], maxDepth },
      }, { file: FILE }))
      expect(error.code, String(maxDepth)).toBe('bad-depth')
    }
  })
})

/* ------------------------------------------------------------ §4.4.1 --- */

describe('CATALOG_LIMITS — §4.4.1', () => {
  it('exposes the documented ceilings', () => {
    expect(CATALOG_LIMITS).toMatchObject({
      maxAgentCount: 128,
      maxYamlBytes: 256 * 1024,
      maxAgentsDirBytes: 4 * 1024 * 1024,
      maxPersonaTotalBytes: 1024 * 1024,
      maxAllowedChildren: 64,
      maxExtraTools: 64,
      maxGraphEdges: 1024,
      maxDisplayNameBytes: 128,
      maxDescriptionBytes: 512,
      maxGuidanceBytes: 2048,
    })
  })

  it('rejects display text over its byte ceiling', () => {
    const error = catalogError(() => validateAgentDefinition({
      ...childOnly,
      displayName: 'é'.repeat(65), // 130 UTF-8 bytes
    }, { file: FILE }))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxDisplayNameBytes')
  })

  it('measures display text in UTF-8 bytes, not code units', () => {
    // 64 CJK characters are 192 bytes: under the code-unit count, over the cap.
    const error = catalogError(() => validateAgentDefinition({ ...childOnly, displayName: '汉'.repeat(64) }, { file: FILE }))
    expect(error.code).toBe('limit-exceeded')
  })

  it('rejects more allowedChildren than the ceiling', () => {
    const error = catalogError(() => validateAgentDefinition({
      ...childOnly,
      allowedChildren: Array.from({ length: CATALOG_LIMITS.maxAllowedChildren + 1 }, (_, i) => `c${i}`),
    }, { file: FILE }))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxAllowedChildren')
  })

  it('rejects more extraTools than the ceiling', () => {
    const error = catalogError(() => validateAgentDefinition({
      ...childOnly,
      child: { ...childOnly.child, extraTools: Array.from({ length: CATALOG_LIMITS.maxExtraTools + 1 }, (_, i) => `third_party_${i}`) },
    }, { file: FILE }))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxExtraTools')
  })

  it('accepts exactly the ceiling for every count-based limit', () => {
    expect(() => validateAgentDefinition({
      ...childOnly,
      allowedChildren: Array.from({ length: CATALOG_LIMITS.maxAllowedChildren }, (_, i) => `c${i}`),
      child: { ...childOnly.child, extraTools: Array.from({ length: CATALOG_LIMITS.maxExtraTools }, (_, i) => `third_party_${i}`) },
    }, { file: FILE })).not.toThrow()
  })
})

/* ------------------------------------------------------------- helpers --- */

describe('deriveToolName', () => {
  it('maps hyphens to underscores and prefixes agent_', () => {
    expect(deriveToolName('my-research')).toBe('agent_my_research')
    expect(deriveToolName('a')).toBe('agent_a')
  })

  it('is injective over the legal id alphabet', () => {
    // Underscores are illegal in an id, so `-` → `_` cannot collide: `a-b` and
    // `ab` map to distinct tool names, and no legal id can spell `a_b`.
    const names = new Set(['a-b', 'ab', 'a-b-c', 'abc'].map(deriveToolName))
    expect(names.size).toBe(4)
    expect(deriveToolName('a-b')).toBe('agent_a_b')
    expect(deriveToolName('ab')).toBe('agent_ab')
  })
})

describe('TOOL_CAPABILITIES / FORBIDDEN_DELEGATION_TOOLS', () => {
  it('lists the closed capability set', () => {
    expect(TOOL_CAPABILITIES).toEqual([
      'read', 'search', 'web', 'exec', 'write', 'edit', 'skill',
      'todo', 'jobs', 'ask-user', 'goal', 'present', 'agent-control',
    ])
  })

  it('is exported as a single shared list', () => {
    // §5.2 requires exactly one FORBIDDEN_DELEGATION_TOOLS list shared by the
    // catalog validator, the preset template and extraTools validation.
    expect([...FORBIDDEN_DELEGATION_TOOLS].sort()).toEqual(['ralph', 'subagent', 'subagent_fork', 'workflow'])
  })
})

/* ------------------------------------------------------- test utilities --- */

/** Parse then validate, the way the loader composes the two steps. */
function parseAndValidate(source: string, file: string): unknown {
  return validateAgentDefinition(parseAgentYaml(source, { file }) as Record<string, unknown>, { file, source })
}
