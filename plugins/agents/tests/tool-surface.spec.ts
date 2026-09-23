/**
 * Specification for `plugins/agents/tool-surface.js` — the capability → runtime
 * tool-name compiler (docs/agents-plugin-plan.md §5.2).
 *
 * A definition grants capabilities (`read`, `exec`, `agent-control`); the live
 * harness registers concrete tools (`read`, `bash`, `send_message`). This module
 * is the only place that translation happens, and it is deliberately strict in
 * one direction: a capability that cannot be satisfied by the live registry is
 * an error, never a silently narrower tool surface (§5.2: "缺失就回滚，不静默忽略").
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import { TOOL_CAPABILITIES } from '../schema.js'
import {
  CAPABILITY_TOOLS,
  FORBIDDEN_RUNTIME_TOOLS,
  ToolSurfaceError,
  assertToolSurface,
  compileAllowlist,
  resolveCapability,
} from '../tool-surface.js'

/** The names the standard composition actually registers on POSIX. */
const STANDARD = new Set([
  'read', 'read_image', 'write', 'edit', 'grep', 'glob', 'bash',
  'web_search', 'web_fetch',
  'skill', 'todo_write', 'job_list', 'job_output', 'job_kill',
  'ask_user_question', 'create_goal', 'get_goal', 'update_goal', 'present',
  'list_agents', 'send_message', 'interrupt_agent',
  // Third-party tools reachable only through an explicit `extraTools` entry.
  'lsp_diagnostics', 'mcp__codegraph__explore',
])

/* ------------------------------------------------------ table integrity --- */

describe('CAPABILITY_TOOLS — one entry per declared capability', () => {
  it('covers exactly the capabilities the schema accepts, in the same order', () => {
    expect(Object.keys(CAPABILITY_TOOLS)).toEqual([...TOOL_CAPABILITIES])
  })

  it('names no forbidden delegation entry point', () => {
    for (const [capability, surface] of Object.entries(CAPABILITY_TOOLS)) {
      for (const name of [...(surface.all ?? []), ...(surface.prefer ?? []), ...(surface.optional ?? [])]) {
        expect(FORBIDDEN_RUNTIME_TOOLS, `${capability} → ${name}`).not.toContain(name)
      }
    }
  })
})

/* ---------------------------------------------------------- resolution --- */

describe('resolveCapability', () => {
  it('resolves a plain capability to every name it owns', () => {
    expect(resolveCapability('search', STANDARD).sort()).toEqual(['glob', 'grep'])
  })

  it('keeps the names the registry really has and drops the platform-absent ones', () => {
    // `pwsh` is disabled by the composition on POSIX and `bash` on Windows, so
    // `exec` must resolve on either platform without a platform check here.
    const posix = new Set(['read', 'bash'])
    expect(resolveCapability('exec', posix)).toEqual(['bash'])
    const windows = new Set(['read', 'pwsh'])
    expect(resolveCapability('exec', windows)).toEqual(['pwsh'])
  })

  it('resolves exec to the shell the target profile actually registers', () => {
    // §5.2: fish first. dsh-tui disables the official `tool-bash`/`tool-pwsh`
    // rows and mounts the fish-shell tool instead, so a bash-only preference
    // made the whole main Agent fail to assemble there.
    expect(resolveCapability('exec', new Set(['fish']))).toEqual(['fish'])
    expect(resolveCapability('exec', new Set(['fish', 'bash', 'pwsh']))).toEqual(['fish'])
    expect(resolveCapability('exec', new Set(['bash', 'pwsh']))).toEqual(['bash'])
    expect(resolveCapability('exec', new Set(['pwsh']))).toEqual(['pwsh'])
  })

  it('grants exactly ONE shell even when the profile registers several', () => {
    // The preference is a choice, not a union: a profile that happens to have
    // both shells must not widen the surface.
    expect(resolveCapability('exec', new Set(['fish', 'bash']))).toHaveLength(1)
  })

  it('includes an optional name only when the registry has it', () => {
    expect(resolveCapability('read', STANDARD)).toContain('read_image')
    expect(resolveCapability('read', new Set(['read']))).toEqual(['read'])
  })

  it('fails loudly when a required name is absent', () => {
    const error = (() => {
      try {
        resolveCapability('web', new Set(['read']))
        return undefined
      } catch (thrown) {
        return thrown as ToolSurfaceError
      }
    })()
    expect(error).toBeInstanceOf(ToolSurfaceError)
    expect(error?.capability).toBe('web')
    expect(error?.missing).toEqual(['web_search', 'web_fetch'])
  })

  it('fails when a capability has no usable alternative at all', () => {
    expect(() => resolveCapability('exec', new Set(['read']))).toThrow(/exec/)
  })

  it('rejects a capability that is not in the table', () => {
    expect(() => resolveCapability('sudo', STANDARD)).toThrow(/unknown capability/i)
  })
})

/* ----------------------------------------------------------- allowlist --- */

describe('compileAllowlist', () => {
  it('unions the capabilities, keeps declaration order and de-duplicates', () => {
    expect(compileAllowlist({ capabilities: ['read', 'search', 'read'], registered: STANDARD }))
      .toEqual(['read', 'read_image', 'grep', 'glob'])
  })

  it('appends extraTools verbatim after the capability surface', () => {
    const allow = compileAllowlist({
      capabilities: ['read'],
      extraTools: ['lsp_diagnostics', 'mcp__codegraph__explore'],
      registered: STANDARD,
    })
    expect(allow).toEqual(['read', 'read_image', 'lsp_diagnostics', 'mcp__codegraph__explore'])
  })

  /* --------------------------------------------------------- ambient --- */

  /**
   * §5.2 — a form that already holds a shell inherits the tools this plugin
   * cannot classify, so installing a plugin is enough to make its tools usable.
   * The rule is derived from `exec` on purpose: a form with a shell can already
   * read, write and run anything, so an extra unclassifiable tool adds no new
   * class of risk to it, while the allowlist would only hide tools the user
   * deliberately installed.
   */
  const AMBIENT = new Set([
    ...STANDARD,
    'lsp_diagnostics',
    'mcp__codegraph__explore',
    'agent_review',
    'delegate_batch',
  ])
  const OWN = new Set(['agent_review', 'delegate_batch'])

  it('grants third-party tools to a form that has a shell', () => {
    const allow = compileAllowlist({
      capabilities: ['read', 'exec'],
      registered: AMBIENT,
      ownTools: OWN,
    })
    expect(allow).toContain('lsp_diagnostics')
    expect(allow).toContain('mcp__codegraph__explore')
    // Exactly one shell, chosen by `exec.prefer` — which one depends on what
    // this fixture registers, so assert the property rather than the name.
    expect(allow.filter((name) => ['fish', 'bash', 'pwsh'].includes(name))).toHaveLength(1)
  })

  it('grants nothing ambient to a form without a shell', () => {
    // `explorer` and `research` are the only genuinely tool-limited forms, and
    // `planner` carries a `writeScope` whose whole soundness rests on having no
    // shell. None of them may inherit a tool whose effects nobody can describe.
    const allow = compileAllowlist({ capabilities: ['read', 'search'], registered: AMBIENT, ownTools: OWN })
    expect(allow).toEqual(['read', 'read_image', 'grep', 'glob'])
  })

  it('never grants this bundle\'s own delegation tools as ambient', () => {
    // They are not in the capability vocabulary, but they are granted per-child
    // by the delegation runtime. Handing `agent_review` to a form that is not
    // authorised to call it would show it a tool that can only ever fail.
    const allow = compileAllowlist({ capabilities: ['read', 'exec'], registered: AMBIENT, ownTools: OWN })
    expect(allow).not.toContain('agent_review')
    expect(allow).not.toContain('delegate_batch')
  })

  it('never grants a forbidden runtime tool, even to a form with a shell', () => {
    const allow = compileAllowlist({
      capabilities: ['read', 'exec'],
      registered: new Set([...AMBIENT, 'run_code', 'subagent', 'workflow']),
      ownTools: OWN,
    })
    for (const forbidden of ['run_code', 'subagent', 'workflow']) {
      expect(allow, `${forbidden} must stay ungrantable`).not.toContain(forbidden)
    }
  })

  it('grants no ambient tool when the bundle cannot identify its own surface', () => {
    // Fail closed: without `ownTools` the bundle cannot tell its delegation
    // tools from third-party ones, and hiding a third-party tool is the lesser
    // error. A service built without the slot behaves exactly like this.
    for (const ownTools of [undefined, null, [], 'nope']) {
      const allow = compileAllowlist({
        capabilities: ['read', 'exec'],
        registered: AMBIENT,
        ownTools: ownTools as never,
      })
      expect(allow, `ownTools=${String(ownTools)}`).not.toContain('lsp_diagnostics')
      expect(allow).not.toContain('agent_review')
    }
  })

  it('still grants an ambient tool that was ALSO named explicitly', () => {
    const allow = compileAllowlist({
      capabilities: ['read'],
      extraTools: ['lsp_diagnostics'],
      registered: AMBIENT,
      ownTools: OWN,
    })
    expect(allow.filter((name) => name === 'lsp_diagnostics')).toHaveLength(1)
  })

  it('refuses an extraTool that is not a real runtime name', () => {
    // §5.2: only exact runtime names; no globs, no prefixes, no silent drops.
    expect(() => compileAllowlist({ capabilities: [], extraTools: ['mcp__*'], registered: STANDARD }))
      .toThrow(/not a registered tool/i)
  })

  it('refuses an extraTool that is a forbidden general-purpose delegation entry point', () => {
    const withSubagent = new Set([...STANDARD, 'subagent'])
    expect(() => compileAllowlist({ capabilities: [], extraTools: ['subagent'], registered: withSubagent }))
      .toThrow(/forbidden/i)
  })

  it('never emits a forbidden name even when a capability table would allow it', () => {
    for (const capability of Object.keys(CAPABILITY_TOOLS)) {
      const allow = compileAllowlist({ capabilities: [capability], registered: STANDARD })
      for (const name of allow) expect(FORBIDDEN_RUNTIME_TOOLS).not.toContain(name)
    }
  })
})

/* ------------------------------------------------------- visible check --- */

describe('assertToolSurface — the post-install self-check (§9.3)', () => {
  it('passes when the visible set is exactly the allowlist', () => {
    expect(() => assertToolSurface({ visible: ['read', 'grep'], allow: ['read', 'grep'] })).not.toThrow()
  })

  it('names the tools that stayed visible although they were restricted away', () => {
    const error = (() => {
      try {
        assertToolSurface({ visible: ['read', 'bash'], allow: ['read'] })
        return undefined
      } catch (thrown) {
        return thrown as ToolSurfaceError
      }
    })()
    expect(error?.unexpected).toEqual(['bash'])
  })

  it('names the allowed tools that never became visible', () => {
    const error = (() => {
      try {
        assertToolSurface({ visible: ['read'], allow: ['read', 'grep'] })
        return undefined
      } catch (thrown) {
        return thrown as ToolSurfaceError
      }
    })()
    expect(error?.missing).toEqual(['grep'])
  })
})

/* ------------------------------------------- cross-bundle shell contract --- */

describe('exec agrees with the shell this repository actually ships', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

  /** The loader rows `plugins/fish-shell/cordis.patch.yml` declares. */
  function fishShellPatchRows(): Array<{ id?: string, disabled?: unknown, insert?: Array<{ id?: string }> }> {
    const text = readFileSync(join(repoRoot, 'plugins', 'fish-shell', 'cordis.patch.yml'), 'utf8')
    const document = parseDocument(text, { schema: 'core', customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: (value: string) => ({ __jsExpr: value }),
    }] })
    if (document.errors.length > 0) throw document.errors[0]
    return document.toJS() as never
  }

  it('keeps `fish` first, because our own sibling bundle replaces the bash tool with it', () => {
    // THE R2 GATE. `@banbolee/dsh-fish-shell` disables the official `tool-bash`
    // row and registers its shell under the name `fish` (tool.js registers
    // `{ name: 'fish' }`). The official `dsh-web-app` and `dsh-tui` bundles
    // disable `tool-bash` AND `tool-pwsh` as well, so in every profile this
    // repository targets, `fish` is the ONLY shell that exists. A capability
    // table that only accepted bash/pwsh therefore made the banbo main agent
    // impossible to create — `failed to create agent: capability "exec" needs
    // one of bash, pwsh, none of which this composition registers`.
    const rows = fishShellPatchRows()
    const disabledIds = rows.filter((row) => row.disabled === true && row.id !== undefined).map((row) => row.id)
    expect(disabledIds, 'the fish-shell bundle must keep replacing the bash tool').toContain('tool-bash')
    const insertedIds = rows.flatMap((row) => row.insert ?? []).map((row) => row.id)
    expect(insertedIds, 'the fish-shell bundle must keep mounting its tool row').toContain('tool-fish')

    const prefer = CAPABILITY_TOOLS.exec.prefer ?? []
    expect(prefer[0], 'fish must win: it is the shell this repository actually provides').toBe('fish')
    expect(prefer).toContain('bash')
    expect(prefer).toContain('pwsh')
  })
})
