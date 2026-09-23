/**
 * Specification for `plugins/agents/path-policy.js` and the `writeScope` field
 * it enforces — docs/agents-plugin-plan.md §5.2, §16.12.
 *
 * The policy confines a definition's `write` / `edit` tools to one directory
 * below the session workspace. These cases pin the exact allow/deny boundary,
 * the fail-closed behaviour on anything unprovable, the symlink defence, and
 * the schema validation that rejects a scope before it can ever be mounted.
 * Everything is offline and deterministic: a real temp workspace, no agent.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

import { loadCatalog, mergeDefinition } from '../catalog.js'
import { writeChildIdentity } from '../identity.js'
import mainRuntime, { activateMainAgent } from '../main-runtime.js'
import { WRITE_TOOLS, writeScopeGuardReason } from '../path-policy.js'
import { CatalogError, parseAgentYaml, validateAgentDefinition } from '../schema.js'
import { CAPABILITY_TOOLS } from '../tool-surface.js'

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/**
 * One real temp directory, canonicalised through `realpath`.
 *
 * The canonicalisation is required, not cosmetic: `os.tmpdir()` on macOS is
 * `/var/folders/...`, itself a symlink to `/private/var/folders/...`, and the
 * guard compares real paths.
 */
function scratchDir(prefix = 'banbo-write-scope-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  scratch.push(dir)
  return dir
}

/** Whether this machine can create directory symlinks at all. */
function symlinksUsable(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'banbo-symlink-probe-'))
  try {
    symlinkSync(root, join(root, 'probe'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const SYMLINKS = symlinksUsable()

/** The scope every case below declares, in its canonical relative form. */
const SCOPE = Object.freeze({ writeScope: '.banbo-dsh/plans' })

/** The frozen execution shape the guard receives, reduced to what it reads. */
function execution(workspace: string | undefined, name: string, filePath: unknown) {
  return {
    name,
    arguments: { file_path: filePath },
    ...(workspace === undefined ? {} : { agent: { session: { header: { cwd: workspace } } } }),
  }
}

/** One definition wrapper for the schema cases. */
function definitionWith(patch: Record<string, unknown>) {
  return {
    id: 'probe',
    displayName: 'Probe',
    description: 'probe agent',
    allowedChildren: [],
    main: {
      presetId: 'probe',
      persona: 'prompts/probe.md',
      tools: ['read', 'write', 'edit'],
      maxDepth: 0,
      ...patch,
    },
  }
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

/* ------------------------------------------------------------- allow side --- */

describe('writeScopeGuardReason — allowed writes', () => {
  it('allows a plan file directly inside the scope', () => {
    const workspace = scratchDir()
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/plan.md') as never))
      .toBeUndefined()
  })

  it('allows a nested subdirectory that does not exist yet', () => {
    // `dsh-fs-local` creates missing parents itself, so a deep target must be
    // allowed on the strength of its nearest EXISTING ancestor.
    const workspace = scratchDir()
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/2026/q1/plan.md') as never))
      .toBeUndefined()
  })

  it('allows the scope directory itself and a `./`-prefixed spelling of it', () => {
    const workspace = scratchDir()
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'edit', '.banbo-dsh/plans') as never)).toBeUndefined()
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'edit', './.banbo-dsh/plans/plan.md') as never))
      .toBeUndefined()
  })

  it('allows `edit` exactly like `write`', () => {
    const workspace = scratchDir()
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'edit', '.banbo-dsh/plans/plan.md') as never))
      .toBeUndefined()
  })

  it('treats only `write` and `edit` as scoped tools', () => {
    expect(WRITE_TOOLS).toEqual(['write', 'edit'])
    const workspace = scratchDir()
    for (const name of ['read', 'read_image', 'grep', 'glob', 'exec', 'bash', 'fish', 'present', 'write_file']) {
      expect(writeScopeGuardReason(SCOPE, execution(workspace, name, '/etc/passwd') as never), name).toBeUndefined()
      expect(writeScopeGuardReason(SCOPE, execution(workspace, name, '../escape.md') as never), name).toBeUndefined()
    }
  })

  it('leaves a definition without a writeScope unrestricted', () => {
    const workspace = scratchDir()
    for (const filePath of ['/etc/passwd', '../outside.md', 'src/index.ts', '.banbo-dsh/plans/plan.md']) {
      expect(writeScopeGuardReason({}, execution(workspace, 'write', filePath) as never), filePath).toBeUndefined()
    }
    expect(writeScopeGuardReason(undefined, execution(workspace, 'write', '/etc/passwd') as never)).toBeUndefined()
  })
})

/* -------------------------------------------------------------- deny side --- */

describe('writeScopeGuardReason — denied writes', () => {
  it('denies a sibling path that merely shares the scope prefix', () => {
    const workspace = scratchDir()
    const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans-evil/plan.md') as never)
    expect(reason).toMatch(/banbo-agents: /)
    expect(reason).toContain('.banbo-dsh/plans')
  })

  it('denies the workspace root, an unrelated directory, and a parent directory', () => {
    const workspace = scratchDir()
    for (const filePath of ['plan.md', 'src/index.ts', '.banbo-dsh/notes.md', '.banbo-dsh/plans/../notes.md']) {
      expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', filePath) as never), filePath)
        .toMatch(/banbo-agents: .*refused/)
    }
  })

  it('denies every upward escape', () => {
    const workspace = scratchDir()
    for (const filePath of ['../outside.md', '../../etc/passwd', 'a/../../outside.md', '..']) {
      const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'edit', filePath) as never)
      expect(reason, filePath).toMatch(/escapes the session workspace|outside the write scope/)
    }
  })

  it('denies a path that leaves the workspace and comes back into the scope', () => {
    // `../<workspace-name>/.banbo-dsh/plans/plan.md` RESOLVES inside the scope,
    // so lexical containment alone would allow it. Rule 3 rejects any normalised
    // path that starts with `..`, which is what makes this case a denial —
    // otherwise the check would be pure defence in depth and unobservable.
    const workspace = scratchDir()
    const filePath = `../${workspace.split('/').pop()}/.banbo-dsh/plans/plan.md`
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', filePath) as never))
      .toMatch(/escapes the session workspace/)
  })

  it('denies an absolute path, POSIX or Windows', () => {
    const workspace = scratchDir()
    for (const filePath of ['/etc/passwd', '/tmp/plan.md', 'C:\\Windows\\plan.md', '\\\\server\\share\\plan.md']) {
      expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', filePath) as never), filePath)
        .toMatch(/absolute path|not a plain relative path/)
    }
  })

  it('denies a backslash or NUL path that no other rule catches', () => {
    // `.banbo-dsh/plans/a\b.md` is a legal POSIX FILENAME inside the scope: it is
    // not absolute (`win32.isAbsolute` is false without a drive or a UNC prefix)
    // and it normalises to itself, so the backslash rule is the only one that can
    // reject it. Same for the NUL spelling. Without this case the rule is
    // unobservable — the other backslash cases above are all absolute and would
    // be denied with the rule deleted.
    const workspace = scratchDir()
    for (const filePath of ['.banbo-dsh/plans/a\\b.md', '.banbo-dsh/plans/a\0b.md']) {
      const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'write', filePath) as never)
      expect(reason, JSON.stringify(filePath)).toContain('which is not a plain relative path')
      expect(reason).toMatch(/^banbo-agents: /)
    }
  })

  it('bounds the echoed paths so a pathological value cannot blow up the message', () => {
    const workspace = scratchDir()
    // Out of scope, so the denial echoes the path: 5000 characters must not all
    // reach the transcript.
    const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'write', `${'x'.repeat(5000)}/plan.md`) as never)
    expect(reason).toMatch(/outside the write scope/)
    expect(reason).toContain('…')
    expect(reason!.length).toBeLessThan(500)
    expect(reason).not.toContain('x'.repeat(201))
    // The bound is on the ECHO only: the path is still judged in full, so it is
    // denied rather than allowed by truncation. The scope echo is bounded too.
    const longScope = { writeScope: `plans/${'s'.repeat(4000)}` }
    const scoped = writeScopeGuardReason(longScope, execution(workspace, 'write', 'src/a.ts') as never)
    expect(scoped).toMatch(/outside the write scope/)
    expect(scoped!.length).toBeLessThan(500)
  })

  it('denies a missing, empty, or non-string file_path', () => {
    const workspace = scratchDir()
    for (const filePath of [undefined, '', 42, null, { path: 'x' }, ['.banbo-dsh/plans/plan.md']]) {
      expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', filePath) as never), String(filePath))
        .toMatch(/file_path is missing or is not a non-empty string/)
    }
  })

  it('denies when the session has no workspace to resolve against', () => {
    for (const workspace of [undefined, '', 7]) {
      expect(writeScopeGuardReason(SCOPE, execution(workspace as never, 'write', '.banbo-dsh/plans/plan.md') as never))
        .toMatch(/no workspace directory/)
    }
  })

  it('names the allowed directory in every denial, in one sentence', () => {
    const workspace = scratchDir()
    const reasons = [
      writeScopeGuardReason(SCOPE, execution(workspace, 'write', '/etc/passwd') as never),
      writeScopeGuardReason(SCOPE, execution(workspace, 'write', '../x.md') as never),
      writeScopeGuardReason(SCOPE, execution(workspace, 'write', 'src/a.ts') as never),
      writeScopeGuardReason(SCOPE, execution(workspace, 'write', undefined) as never),
      writeScopeGuardReason(SCOPE, execution(undefined, 'write', 'a.md') as never),
    ]
    for (const reason of reasons) {
      expect(reason).toMatch(/^banbo-agents: /)
      expect(reason).toContain('".banbo-dsh/plans"')
      expect(reason).not.toMatch(/\.$/)
    }
  })
})

/* --------------------------------------------------------------- symlinks --- */

describe('writeScopeGuardReason — symlink defence', () => {
  it.skipIf(!SYMLINKS)('denies a symlink inside the scope that points outside it', () => {
    const workspace = scratchDir()
    const outside = scratchDir('banbo-write-scope-outside-')
    mkdirSync(join(workspace, '.banbo-dsh', 'plans'), { recursive: true })
    symlinkSync(outside, join(workspace, '.banbo-dsh', 'plans', 'link'), 'dir')

    const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/link/plan.md') as never)
    expect(reason).toMatch(/banbo-agents: /)
    expect(reason).toMatch(/symlink/)
    // The nested case: a symlinked ancestor below a path that does not exist yet.
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/link/deep/plan.md') as never))
      .toMatch(/symlink/)
  })

  it.skipIf(!SYMLINKS)('allows a symlink that stays inside the scope', () => {
    // The defence must be containment, not a blanket refusal of symlinks.
    const workspace = scratchDir()
    mkdirSync(join(workspace, '.banbo-dsh', 'plans', 'real'), { recursive: true })
    symlinkSync(join(workspace, '.banbo-dsh', 'plans', 'real'), join(workspace, '.banbo-dsh', 'plans', 'link'), 'dir')
    expect(writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/link/plan.md') as never))
      .toBeUndefined()
  })

  it.skipIf(!SYMLINKS)('denies a scope ROOT that resolves outside the workspace', () => {
    const workspace = scratchDir()
    const outside = scratchDir('banbo-write-scope-outside-')
    // `ws/.banbo-dsh` is itself a symlink out of the workspace. Checking only
    // that the TARGET sits inside the scope's real path would accept this and
    // silently widen the policy to the whole link target, so the scope root's
    // own real path must also stay inside the workspace.
    symlinkSync(outside, join(workspace, '.banbo-dsh'), 'dir')
    const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/plan.md') as never)
    expect(reason).toMatch(/write scope "\.banbo-dsh\/plans" itself resolves outside/)
  })

  it.skipIf(!SYMLINKS)('denies when the real path cannot be resolved at all', () => {
    // The `catch` around the realpath block is the last fail-closed branch: an
    // error that is neither ENOENT nor ENOTDIR denies instead of propagating.
    // A self-referential symlink makes `realpathSync` raise ELOOP on every
    // platform, deterministically, without root — unlike EACCES, which would
    // need a privileged directory to be unreadable.
    const workspace = scratchDir()
    mkdirSync(join(workspace, '.banbo-dsh', 'plans'), { recursive: true })
    symlinkSync('loop', join(workspace, '.banbo-dsh', 'plans', 'loop'), 'dir')
    const reason = writeScopeGuardReason(SCOPE, execution(workspace, 'write', '.banbo-dsh/plans/loop/plan.md') as never)
    expect(reason).toContain('whose real path could not be resolved')
    expect(reason).toMatch(/^banbo-agents: /)
    expect(reason).toContain('only write under')
  })
})

/* ----------------------------------------------------------------- schema --- */

describe('writeScope schema validation', () => {
  it('accepts a plain relative directory on both forms and canonicalises it', () => {
    const main = validateAgentDefinition(definitionWith({ writeScope: './.banbo-dsh/plans/' }) as never)
    expect(main.main?.writeScope).toBe('.banbo-dsh/plans')

    const child = validateAgentDefinition({
      id: 'probe',
      displayName: 'Probe',
      description: 'probe agent',
      allowedChildren: [],
      child: {
        model: { default: true },
        persona: 'prompts/probe.md',
        guidance: 'use when probing',
        tools: ['read', 'write', 'edit'],
        writeScope: 'plans/2026',
        continuation: 'one-shot',
      },
    } as never)
    expect(child.child?.writeScope).toBe('plans/2026')
  })

  it('omits the field entirely when it is absent, so writes stay unrestricted', () => {
    const definition = validateAgentDefinition(definitionWith({}) as never)
    expect('writeScope' in (definition.main ?? {})).toBe(false)
  })

  it('rejects an absolute writeScope', () => {
    for (const writeScope of ['/etc', '/.banbo-dsh/plans', 'C:\\plans', '\\\\server\\share']) {
      const error = catalogError(() => validateAgentDefinition(definitionWith({ writeScope }) as never))
      expect(error.code, writeScope).toBe('bad-write-scope')
      expect(error.field).toBe('main.writeScope')
    }
  })

  it('rejects a writeScope that escapes through ..', () => {
    for (const writeScope of ['..', '../plans', 'a/../../plans', '.banbo-dsh/../../etc']) {
      const error = catalogError(() => validateAgentDefinition(definitionWith({ writeScope }) as never))
      expect(error.code, writeScope).toBe('bad-write-scope')
    }
  })

  it('rejects an empty or non-string writeScope', () => {
    for (const writeScope of ['', 7, true, ['plans'], { path: 'plans' }]) {
      const error = catalogError(() => validateAgentDefinition(definitionWith({ writeScope }) as never))
      expect(error.code, String(writeScope)).toBe('missing-field')
      expect(error.message).toContain('must be a non-empty string')
    }
  })

  it('rejects values that are not a plain relative path', () => {
    for (const writeScope of ['.', './', 'a/..', 'plans\\2026', 'plan\0s']) {
      const error = catalogError(() => validateAgentDefinition(definitionWith({ writeScope }) as never))
      expect(error.code, writeScope).toBe('bad-write-scope')
    }
  })

  it('reports the child field path and still rejects unknown keys', () => {
    const childDefinition = (patch: Record<string, unknown>) => ({
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
        ...patch,
      },
    })
    const error = catalogError(() => validateAgentDefinition(childDefinition({ writeScope: '../out' }) as never))
    expect(error.code).toBe('bad-write-scope')
    expect(error.field).toBe('child.writeScope')

    // A misspelling is still a hard error, not a silent no-op (§6.1.1).
    const unknown = catalogError(() => validateAgentDefinition(childDefinition({ writeScopes: 'plans' }) as never))
    expect(unknown.code).toBe('unknown-field')
  })
})

/* -------------------------------------------------- shell precondition --- */

/**
 * `path-policy.js` only ever sees `write` / `edit` TOOL CALLS, so a form that
 * carries both a `writeScope` and a shell is not a style problem — the scope is
 * void. The schema refuses that combination outright, on the RESOLVED surface,
 * because the scope and the shell can arrive from different layers.
 */
describe('writeScope × shell — the load-bearing precondition (§5.2, §16.12)', () => {
  /** A main form carrying the scope plus whatever the case adds. */
  function scopedMain(patch: Record<string, unknown>) {
    return definitionWith({ writeScope: '.banbo-dsh/plans', ...patch })
  }

  it('rejects a main form that declares both a writeScope and the exec capability', () => {
    const error = catalogError(() => validateAgentDefinition(scopedMain({ tools: ['read', 'exec', 'write', 'edit'] }) as never))
    expect(error.code).toBe('write-scope-with-shell')
    expect(error.field).toBe('main.tools')
    expect(error.message).toMatch(/^banbo-agents: /)
    // Names both halves of the offending combination and says why it is refused.
    expect(error.message).toContain('main.writeScope')
    expect(error.message).toContain('main.tools')
    expect(error.message).toContain('"exec"')
    expect(error.message).toContain('shell')
    expect(error.message).not.toMatch(/\.$/)
  })

  it('rejects the child form too, naming the child fields', () => {
    const error = catalogError(() => validateAgentDefinition({
      id: 'probe',
      displayName: 'Probe',
      description: 'probe agent',
      allowedChildren: [],
      child: {
        model: { default: true },
        persona: 'prompts/probe.md',
        guidance: 'use when probing',
        tools: ['read', 'exec', 'write', 'edit'],
        writeScope: 'plans',
        continuation: 'one-shot',
      },
    } as never))
    expect(error.code).toBe('write-scope-with-shell')
    expect(error.field).toBe('child.tools')
    expect(error.message).toContain('child.writeScope')
  })

  it('rejects every shell the `exec` capability can grant, even smuggled through extraTools', () => {
    // `tools` is a closed capability set, so `exec` is the only shell reachable
    // through it. `extraTools` is NOT closed: `compileAllowlist` grants a
    // registered runtime tool name verbatim, so `bash` here would hand the form
    // a real shell while the guard only ever sees `write` / `edit`.
    const shells = CAPABILITY_TOOLS.exec!.prefer!
    expect(shells).toEqual(['fish', 'bash', 'pwsh'])
    for (const shell of shells) {
      const error = catalogError(() => validateAgentDefinition(scopedMain({ extraTools: [shell] }) as never))
      expect(error.code, shell).toBe('write-scope-with-shell')
      expect(error.field).toBe('main.extraTools')
      expect(error.message).toContain('main.extraTools')
      expect(error.message).toContain(JSON.stringify(shell))
    }
  })

  it('still rejects a concrete shell name in `tools`, because that list is closed', () => {
    // This is WHY the case above is the `extraTools` one: a shell cannot be
    // named directly in `tools`, so the capability list needs only `exec`.
    const error = catalogError(() => validateAgentDefinition(scopedMain({ tools: ['read', 'bash'] }) as never))
    expect(error.code).toBe('unknown-tool-capability')
  })

  it('accepts a scoped form whose resolved surface grants no shell', () => {
    const definition = validateAgentDefinition(scopedMain({
      tools: ['read', 'search', 'web', 'write', 'edit', 'skill', 'todo', 'jobs', 'ask-user', 'goal', 'present', 'agent-control'],
      extraTools: ['codegraph_explore'],
    }) as never)
    expect(definition.main?.writeScope).toBe('.banbo-dsh/plans')
    expect(definition.main?.tools).toContain('write')
  })

  it('leaves a shell without a writeScope alone, because there is no policy to void', () => {
    const definition = validateAgentDefinition(definitionWith({ tools: ['read', 'exec', 'write', 'edit'] }) as never)
    expect('writeScope' in (definition.main ?? {})).toBe(false)
  })
})

/* ------------------------------------------------------- real catalog --- */

describe('writeScope × shell — the shipped catalog and its user layer', () => {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const builtinDir = join(pluginRoot, 'catalog')

  /** A user data root; `yaml` becomes `agents/planner.yaml` when given. */
  function userRoot(yaml?: string): string {
    const root = scratchDir('banbo-write-scope-catalog-')
    if (yaml !== undefined) {
      mkdirSync(join(root, 'agents'), { recursive: true })
      writeFileSync(join(root, 'agents', 'planner.yaml'), yaml)
    }
    return root
  }

  it('still loads the shipped Planner with its scope, which is the whole point of the rule', () => {
    const catalog = loadCatalog({ rootDir: userRoot(), builtinDir })
    const planner = catalog.definitions.get('planner')!
    expect(planner.main?.writeScope).toBe('.banbo-dsh/plans')
    expect(planner.child?.writeScope).toBe('.banbo-dsh/plans')
    expect(planner.main?.tools).not.toContain('exec')
    expect(planner.child?.tools).not.toContain('exec')
  })

  /** The reviewer's exact override: it restates `tools` and inherits the scope. */
  const plannerOverrideWithExec = [
    'id: planner',
    'displayName: Planner',
    'description: planner that wants a shell',
    'allowedChildren: []',
    'main:',
    '  presetId: planner',
    '  persona: prompts/planner-main.md',
    '  tools: [read, exec, write, edit]',
    '  maxDepth: 1',
    '',
  ].join('\n')

  it('rejects a user override that adds exec while the built-in keeps the scope', () => {
    // On its own the override is perfectly legal — it declares no scope, so it
    // voids nothing. Only the MERGE with the built-in `writeScope` is illegal,
    // which is exactly the shape that used to pass silently.
    expect(() => validateAgentDefinition(parseAgentYaml(plannerOverrideWithExec, { file: 'planner.yaml' }) as never))
      .not.toThrow()

    const error = catalogError(() => loadCatalog({ rootDir: userRoot(plannerOverrideWithExec), builtinDir }))
    expect(error.code).toBe('write-scope-with-shell')
    expect(error.field).toBe('main.tools')
    expect(error.message).toContain('main.writeScope')
    expect(error.message).toContain('"exec"')
    // A CatalogError naming the user's own file, not an unhandled throw.
    expect(error.file).toContain('planner.yaml')
  })

  it('rejects the same override on the child form', () => {
    const yaml = [
      'id: planner',
      'displayName: Planner',
      'description: planner child that wants a shell',
      'allowedChildren: []',
      'child:',
      '  model: { default: true }',
      '  persona: prompts/planner-child.md',
      '  guidance: 当任务需要先拆解成计划时使用；不要使用它直接做大规模代码修改。',
      '  tools: [read, exec, write, edit]',
      '  continuation: optional',
      '',
    ].join('\n')
    const error = catalogError(() => loadCatalog({ rootDir: userRoot(yaml), builtinDir }))
    expect(error.code).toBe('write-scope-with-shell')
    expect(error.field).toBe('child.tools')
    expect(error.message).toContain('child.writeScope')
    expect(error.file).toContain('planner.yaml')
  })

  it('allows a merge that drops the scope while adding a shell', () => {
    // No scope, no policy, nothing to void. An explicit `undefined` is the
    // merge's delete (YAML cannot express it: `null` is rejected and omission
    // inherits), so this is the one user-side way out — and it stays legal.
    const base = {
      id: 'probe',
      displayName: 'Probe',
      description: 'probe agent',
      allowedChildren: [],
      main: {
        presetId: 'probe',
        persona: 'prompts/probe.md',
        tools: ['read', 'write', 'edit'],
        writeScope: '.banbo-dsh/plans',
        maxDepth: 0,
      },
    }
    const override = { main: { ...base.main, tools: ['read', 'exec', 'write', 'edit'], writeScope: undefined } }
    const merged = mergeDefinition(base as never, override as never)
    expect(merged.main === undefined || 'writeScope' in merged.main).toBe(false)
    expect(merged.main.tools).toContain('exec')
  })

  it('cannot strip the scope through YAML, so a user file cannot dodge the rule that way', () => {
    // `null` is not an implicit delete (§6.3): a user layer can neither remove
    // the built-in `writeScope` nor blank it, so the only way to put a shell on
    // this id is to author a different id — which carries no scope to void.
    const yaml = plannerOverrideWithExec.replace(
      '  tools: [read, exec, write, edit]',
      '  writeScope: null\n  tools: [read, exec, write, edit]',
    )
    const error = catalogError(() => loadCatalog({ rootDir: userRoot(yaml), builtinDir }))
    expect(error.code).toBe('null-not-allowed')
    expect(error.field).toBe('main.writeScope')
  })
})

/* ---------------------------------------------------------------- wiring --- */

describe('main-runtime wiring — the mounted definition is what is enforced', () => {
  /** One registered tool body; the guard decides whether it ever runs. */
  function toolDefinition(name: string) {
    return {
      name,
      description: `${name} test tool`,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text' as const, text: 'ok' }],
      },
      execute: async () => ({}),
    }
  }

  /**
   * Activate one main Agent through the real `ToolRuntime`/`SystemPrompt`
   * registries, exactly as the `agent/created` listener does in production.
   */
  async function harness(writeScope: string | undefined, cwd: string) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'global persona' })
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    const host = await ctx.plugin({ name: 'write-scope-wiring-host', inject: ['tools', 'systemPrompt'], apply() {} })
    for (const name of ['read', 'read_image', 'write', 'edit']) host.ctx.tools.register(toolDefinition(name) as never)

    const definition = {
      id: 'planner',
      displayName: 'Planner',
      description: 'planner',
      allowedChildren: [],
      main: {
        presetId: 'planner',
        persona: 'prompts/planner-main.md',
        tools: ['read', 'write', 'edit'],
        ...(writeScope === undefined ? {} : { writeScope }),
        maxDepth: 0,
      },
    }
    const agent: { id: string, options: Record<string, unknown>, session: { header: { agentPreset: string, cwd: string }, snapshotEvents: () => unknown[] }, ctx: Context } = {
      id: 'session-1',
      options: {},
      session: { header: { agentPreset: 'planner', cwd }, snapshotEvents: () => [] },
      ctx: undefined as never,
    }
    const scoped = createScope(host.ctx, agent)
    agent.ctx = scoped.ctx

    const service = {
      generation: 'gen-write-scope',
      definitions: new Map([['planner', definition]]),
      personas: new Map([['prompts/planner-main.md', '# Planner']]),
      abi: { agents: [] },
      settings: {
        policy: () => ({ agentId: 'planner', definition, exists: true, retired: false, effectiveEnabled: true }),
      },
    }
    activateMainAgent({
      agent: agent as never,
      service: service as never,
      configuredAgentId: 'planner',
      composedPreset: 'planner',
    })
    return { ctx, agent }
  }

  /** Execute one tool call through the registry and return its result. */
  function call(agent: { ctx: { tools: { execute: (input: ToolExecutionInput) => Promise<ToolExecutionResult> } } }, name: string, filePath: string) {
    return agent.ctx.tools.execute({
      callId: `call-${name}-${filePath}`,
      name,
      arguments: { file_path: filePath },
      agent,
      signal: new AbortController().signal,
    } as ToolExecutionInput)
  }

  it('denies an out-of-scope write and allows an in-scope one for the mounted definition', async () => {
    const workspace = scratchDir()
    const { agent } = await harness('.banbo-dsh/plans', workspace)

    await expect(call(agent, 'write', '.banbo-dsh/plans/plan.md')).resolves
      .toMatchObject({ isError: false })
    await expect(call(agent, 'edit', '.banbo-dsh/plans/plan.md')).resolves
      .toMatchObject({ isError: false })
    await expect(call(agent, 'write', 'src/index.ts')).resolves
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('banbo-agents:') } })
    await expect(call(agent, 'edit', '../escape.md')).resolves
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('only write under ".banbo-dsh/plans"') } })
    // A different tool is never affected by the guard.
    await expect(call(agent, 'read', 'src/index.ts')).resolves
      .toMatchObject({ isError: false })
  })

  it('leaves the same surface unrestricted when the mounted definition has no writeScope', async () => {
    const workspace = scratchDir()
    const { agent } = await harness(undefined, workspace)
    for (const [name, filePath] of [['write', 'src/index.ts'], ['edit', '/etc/passwd'], ['write', '../escape.md']] as const) {
      await expect(call(agent, 'write', filePath), `${name} ${filePath}`).resolves.toMatchObject({ isError: false })
    }
  })

  /* ----------------------------------------------------- resumed children --- */

  /**
   * The harness disposes an idle continuable activation and rebuilds the child
   * from its persisted descriptor on the next `send_message`. That rebuild
   * re-applies only the persona and the tool filter, so a guard installed when
   * the delegation created the child is GONE — leaving a durable child holding
   * `write`/`edit` with no scope. `main-runtime`'s `agent/created` listener is
   * the hook that closes this, and it identifies the child from the sidecar the
   * delegation runtime wrote (a child's session header carries only the CALLER's
   * preset, so §11.1.1 forbids inferring its definition from it).
   */
  async function resumeHarness(options: { scope?: string, sidecar?: boolean, agentId?: string } = {}) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'global persona' })
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    const host = await ctx.plugin({ name: 'resume-host', inject: ['tools', 'systemPrompt'], apply() {} })
    for (const name of ['read', 'write', 'edit']) host.ctx.tools.register(toolDefinition(name) as never)

    const childId = 'child-resumed-1'
    const rootDir = scratchDir('banbo-resume-root-')
    if (options.sidecar !== false) {
      writeChildIdentity(rootDir, childId, {
        version: 1,
        agentId: options.agentId ?? 'planner',
        mainAgentId: 'planner',
        presetId: 'planner',
        rootSessionId: 'root-session-1',
        generation: 'gen-resume',
      })
    }

    const definition = {
      id: 'planner',
      displayName: 'Planner',
      description: 'planner',
      allowedChildren: [],
      child: {
        persona: 'prompts/planner-child.md',
        tools: ['read', 'write', 'edit'],
        continuation: 'optional' as const,
        ...(options.scope === undefined ? {} : { writeScope: options.scope }),
      },
    }
    const service = {
      generation: 'gen-resume',
      rootDir,
      definitions: new Map([['planner', definition]]),
      personas: new Map([['prompts/planner-child.md', '# Planner child']]),
      abi: { agents: [] },
      settings: { policy: () => ({ agentId: 'planner', definition, exists: true, retired: false, effectiveEnabled: true }) },
    }

    // Capture the listener the preset entry registers, then fire it the way the
    // registry does for a resumed subagent.
    let listener: ((payload: { agent: unknown }) => void) | undefined
    const listenerCtx = {
      banboAgents: service,
      agentPresets: { composedPreset: () => 'planner' },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      on: (event: string, callback: never) => { if (event === 'agent/created') listener = callback },
    }
    mainRuntime(listenerCtx as never, { agentId: 'planner' })

    const workspace = scratchDir()
    const agent: {
      id: string
      options: Record<string, unknown>
      session: { header: { agentPreset: string, origin: string, cwd: string }, snapshotEvents: () => unknown[] }
      ctx: Context
    } = {
      id: childId,
      options: {},
      session: { header: { agentPreset: 'planner', origin: 'subagent', cwd: workspace }, snapshotEvents: () => [] },
      ctx: undefined as never,
    }
    const scoped = createScope(host.ctx, agent as never)
    agent.ctx = scoped.ctx
    listener?.({ agent })
    return { agent, workspace }
  }

  it('denies an out-of-scope write on the resumed child and allows an in-scope one', async () => {
    const { agent } = await resumeHarness({ scope: '.banbo-dsh/plans' })
    await expect(call(agent, 'write', '.banbo-dsh/plans/plan.md')).resolves.toMatchObject({ isError: false })
    await expect(call(agent, 'write', 'src/index.ts')).resolves
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('only write under ".banbo-dsh/plans"') } })
  })

  it('installs nothing for a child with no sidecar, which is how a one-shot child looks', async () => {
    const { agent } = await resumeHarness({ scope: '.banbo-dsh/plans', sidecar: false })
    await expect(call(agent, 'write', 'src/index.ts')).resolves.toMatchObject({ isError: false })
  })

  it('installs nothing when the identified definition declares no scope', async () => {
    const { agent } = await resumeHarness({})
    await expect(call(agent, 'write', 'src/index.ts')).resolves.toMatchObject({ isError: false })
  })

  it('never makes a child un-resumable when its sidecar names an unknown agent', async () => {
    const { agent } = await resumeHarness({ scope: '.banbo-dsh/plans', agentId: 'deleted-agent' })
    await expect(call(agent, 'write', 'src/index.ts')).resolves.toMatchObject({ isError: false })
  })
})
