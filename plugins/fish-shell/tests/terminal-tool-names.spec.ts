/**
 * T3 — the `terminalTools` policy is only a gate on the upstream surface if
 * something compares its explicit name enumeration with the tools the BUNDLED
 * `@deepseek-ai/dsh-tool-terminal` really registers (fish-shell-tty-v3 §5.3 T3,
 * §7.2). `terminal-tools.spec.ts` pins the constant against a hand-copied list,
 * which catches internal drift but has no upstream counterpart at all: an
 * upstream seventh tool would ship ungoverned while every existing test stayed
 * green.
 *
 * This suite therefore reads the shipped implementation
 * (`node_modules/@deepseek-ai/dsh-tool-terminal/lib/index.js`, the copy the
 * tarball bundles) and extracts each registered tool name from the REAL
 * registration call — `ctx.tools.register(defineTool({ name: "<literal>", …` —
 * instead of scanning the whole text for `terminal_[a-z_]+`:
 *
 *   - anchoring on the call means a name is read only where the registry
 *     actually receives it, so prose, prompt text, error strings and JSDoc
 *     (`"…terminal_open or terminal_list."`) cannot produce a name;
 *   - the extraction is prefix-agnostic on purpose: a seventh tool registered
 *     as `pty_open` must break this gate too, so filtering to `terminal_*`
 *     would be exactly the blind spot the policy's no-wildcard rule exists for;
 *   - the literal must be followed by `,`/`}` (`(?=\s*[,}])`), so a computed
 *     name (`name: "terminal_" + kind`) is NOT read as `terminal_` — it makes
 *     the registration-site count mismatch below fail instead of silently
 *     reading a truncated name.
 *
 * Every registration site must yield a literal name (`names.length ===
 * registrationSites`), and the two sets must be equal in BOTH directions:
 *
 *   - upstream ⊄ policy → upstream added a tool: a conscious decision (extend
 *     the enumeration + re-review the security model, or explicitly waive it)
 *     is required, which is the release-blocking assertion;
 *   - policy ⊄ upstream → the enumeration names something the installed
 *     implementation does not register, and `tools.restrict({ deny })` rejects
 *     the WHOLE call when any name is unknown, so `deny` would silently never
 *     install (or this extraction stopped seeing a moved registration).
 *
 * A missing dependency is a hard failure, never a skip: the bundled copy is the
 * payload the tarball ships, and a silently skipped contract would report a
 * green policy nobody verified (same stance as `bundled-version.spec.ts`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TERMINAL_TOOL_NAMES } from '../terminal-tools.js'

const BUNDLED_PACKAGE = '@deepseek-ai/dsh-tool-terminal'
/** The bundled dependency's implementation, exactly as it travels in the tarball. */
const IMPLEMENTATION_PATH = fileURLToPath(
  new URL(`../node_modules/${BUNDLED_PACKAGE}/lib/index.js`, import.meta.url),
)

/** Every `ctx.tools.register(...)` call site in the implementation. */
const REGISTRATION_CALL = /ctx\.tools\.register\(/g
/** The `defineTool({ name: "<literal>" … })` those sites register. */
const REGISTRATION_NAME = /ctx\.tools\.register\(\s*defineTool\(\s*\{\s*name:\s*(["'])([^"']+)\1(?=\s*[,}])/g

interface UpstreamSurface {
  /** The tool names the bundled implementation registers, in source order. */
  readonly names: readonly string[]
  /** How many `ctx.tools.register(...)` call sites the scan saw. */
  readonly registrationSites: number
}

/**
 * Read the registered tool names out of the bundled implementation. `matchAll`
 * clones these module-level regexes, so no `lastIndex` state leaks between calls.
 */
function extractUpstreamToolNames(source: string): UpstreamSurface {
  const names: string[] = []
  for (const match of source.matchAll(REGISTRATION_NAME)) {
    const name = match[2]
    if (name === undefined) throw new Error(`the name literal could not be read at offset ${match.index}`)
    names.push(name)
  }
  return { names, registrationSites: [...source.matchAll(REGISTRATION_CALL)].length }
}

/** Fail loud (never skip) when the bundled dependency is not installed. */
function readBundledImplementation(): string {
  if (!existsSync(IMPLEMENTATION_PATH)) {
    throw new Error(
      `${BUNDLED_PACKAGE} is not installed at ${IMPLEMENTATION_PATH}, so this contract test has no upstream `
      + 'surface to gate on. Run `env NODE_ENV=development pnpm install` in the repository root (the bundled '
      + 'dependency is installed into plugins/fish-shell/node_modules) and re-run this suite.',
    )
  }
  return readFileSync(IMPLEMENTATION_PATH, 'utf8')
}

const upstream = extractUpstreamToolNames(readBundledImplementation())
const upstreamNames = new Set(upstream.names)
const policyNames = new Set<string>(TERMINAL_TOOL_NAMES)

describe('T3 — the terminalTools policy covers the bundled upstream tool surface', () => {
  it('understands every registration site in the bundled implementation', () => {
    // A silent zero-match (entry point moved, calls rewritten) must never turn
    // the two comparisons below into vacuous passes.
    expect(upstream.registrationSites, `${BUNDLED_PACKAGE} registers no tool through ctx.tools.register()`)
      .toBeGreaterThan(0)
    expect(
      upstream.names.length,
      `${BUNDLED_PACKAGE} has ${upstream.registrationSites} \`ctx.tools.register(...)\` call site(s) but only `
      + `${upstream.names.length} literal tool name(s) could be read (${upstream.names.join(', ')}). `
      + 'Upstream changed how tools are registered: update the extraction in this spec, then decide explicitly '
      + 'whether the policy enumeration (TERMINAL_TOOL_NAMES) and the L2 security model still cover the surface.',
    ).toBe(upstream.registrationSites)
  })

  it('leaves no upstream tool out of the explicit TERMINAL_TOOL_NAMES enumeration', () => {
    const undecided = upstream.names.filter((name) => !policyNames.has(name))
    expect(
      undecided,
      `upstream ${BUNDLED_PACKAGE} registers ${upstreamNames.size} tools now, and the following name(s) are not in `
      + `TERMINAL_TOOL_NAMES (plugins/fish-shell/terminal-tools.js): ${undecided.join(', ')}. `
      + 'Upstream added a tool — that is a security-model change, not a free pass: update the enumeration and the '
      + 'README support matrix EXPLICITLY (or waive it in writing) and re-review the L2 security model. Until then '
      + '`terminalTools: "deny"` leaves the new tool available to every agent.',
    ).toEqual([])
  })

  it('lists no policy name the bundled implementation does not register', () => {
    const stale = [...policyNames].filter((name) => !upstreamNames.has(name))
    expect(
      stale,
      `TERMINAL_TOOL_NAMES lists ${stale.length} name(s) the bundled ${BUNDLED_PACKAGE} does not register `
      + `(${stale.join(', ')}). Either upstream removed/renamed a tool, or this extraction no longer sees a moved `
      + 'registration site. `tools.restrict({ deny })` rejects the whole call when any name is unknown, so '
      + '`terminalTools: "deny"` would silently never install: fix the enumeration (and the README) or the '
      + 'extraction, then re-review the security model.',
    ).toEqual([])
  })
})
