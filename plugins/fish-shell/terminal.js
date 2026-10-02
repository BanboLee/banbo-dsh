/**
 * L2 interactive PTY backend: the official `@deepseek-ai/dsh-terminal-bash`
 * `BashTerminalBackend` with ONE addition — the harness home contract
 * (`DSH_HOME`, and `DSH_PROFILE` / `DSH_PROFILE_DIR` when the context carries
 * them) in the PTY child environment.
 *
 * Why it exists: an interactive session's child environment is the backend's
 * own overlay (`TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `DSH_SHELL`,
 * `DSH_SESSION_ID`, `DSH_PTY_SESSION_ID`) layered on `scrubbedParentEnv()`,
 * which drops EVERY inherited `DSH_*` name. The one-shot `fish` tool instead
 * runs with the trusted snapshot of the `ctx.shellEnv` registry, merged after
 * that same scrub. The two surfaces therefore disagreed about the harness
 * home: a `dsh` nested inside an interactive session resolved `~/.dsh` (an
 * older home with older plugin state) while the one-shot tool resolved the
 * real harness home. This module puts both surfaces on the same home facts.
 *
 * How the injection stays on public seams: the base class builds the overlay
 * with its module-private `childEnvironment()` and hands the finished terminal
 * spec to its `spawnTerminal` CONSTRUCTOR parameter. This subclass passes a
 * wrapper for that parameter (the official default is
 * `(spec) => ctx.subprocess.spawnTerminal(spec)`), and the spec's `env` field
 * is documented as "explicit environment layered after the provider's ambient
 * scrub" — exactly where a deliberately forwarded `DSH_*` fact belongs. No
 * official module internal, no private field and no monkey-patch is involved:
 * argv confinement, the sandbox-mode fence, `session.initialize()` readiness,
 * the `-C` fish prompt setup, the session factory and the config surface
 * (`Config` is re-exported verbatim, so `backendType` keeps its `shell`
 * default) are all the base class's own code.
 *
 * Where the values come from: the SAME registry the one-shot shell tools use —
 * `ctx.shellEnv.collect()`, whose snapshot `dsh-bash-local` merges into a
 * one-shot execution — so the two cannot drift. The three home facts are
 * execution-independent by construction: `collect` reads `execution.agent`
 * only to add `DSH_SESSION_ID`, and the profile facts come from the context.
 * The snapshot is therefore taken at spawn time with an empty execution, and
 * the session facts stay the PTY overlay's own official values: this module
 * never rewrites `DSH_SHELL` / `DSH_SESSION_ID` / `DSH_PTY_SESSION_ID`.
 *
 * `DSH_SESSION_ID` / `DSH_PTY_SESSION_ID` are deliberately KEPT on a newly
 * opened shell. Evidence: they are the official PTY facts, produced by
 * `dsh-terminal-bash` (`spec.owner.id` / `spec.sessionId`) and by
 * `dsh-api-terminal-controller` (`agent.id`) for the GUI terminal panel, and
 * grep over the installed harness finds no reader of either name (only those
 * two producers and the registry's reserved-key list). Removing them would be
 * a deviation with no evidence behind it. What would change that: an in-tree
 * consumer that reads the CURRENT session's identity out of these variables
 * (e.g. a plugin resolving its caller from `$DSH_SESSION_ID`), or a nested-boot
 * failure traced to the inherited value.
 *
 * Fallback: when the registry is not mounted (`ctx.get('shellEnv')` is
 * `undefined` — a custom composition outside `dsh-base`), the same three facts
 * are read from their public owners instead — `resolveDshHome()` and
 * `ctx.get('profileContext')`, which are the registry's own sources — so the
 * values are byte-identical unless a profile configures `dshHome` on its
 * `shell-env` row, which only the registry path can see. A contributor whose
 * `resolve()` throws on the spawn-time (partial) execution is handled the same
 * way: the home facts do not depend on that contribution, and a third-party
 * contributor must not be able to take every PTY spawn down.
 *
 * Upstream note: this subclass is only here because the official row exposes
 * no `env` config field. If `@deepseek-ai/dsh-terminal-bash` ever grows one
 * (or accepts an environment overlay from the registry itself), the patch row
 * can go back to the official package and this module can be deleted.
 *
 * @module @banbolee/dsh-fish-shell/terminal
 */

import { BashTerminalBackend, Config } from '@deepseek-ai/dsh-terminal-bash'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * The official backend's config schema, re-exported verbatim so cordis
 * resolves this row with exactly the official defaults (`backendType: 'shell'`
 * included) and the row keeps the official config surface. Also imported
 * above, where `apply` uses it to materialize those defaults for a direct,
 * loader-free call.
 */
export { Config }

/** Cordis plugin name (the bundle patch decides the row id and mount point). */
export const name = 'terminal-home'
/**
 * Required services: verbatim the official backend's list. The inherited
 * `spawn()` needs all four; declaring the same list keeps activation identical
 * to the official row.
 */
export const inject = [
  'terminals',
  'sandboxPolicy',
  'sessionProjections',
  'subprocess',
]

/** Environment variable holding the profile facts the registry snapshots. */
const DSH_PROFILE_KEY = 'DSH_PROFILE'
/** Environment variable holding the profile directory the registry snapshots. */
const DSH_PROFILE_DIR_KEY = 'DSH_PROFILE_DIR'
/** The home contract this module forwards, in the order it is documented. */
const HOME_CONTRACT_KEYS = /** @type {const} */ ([DSH_HOME_ENV, DSH_PROFILE_KEY, DSH_PROFILE_DIR_KEY])

/**
 * The public profile facts `ctx.get('profileContext')` carries. Deliberately
 * structural: the service belongs to the launcher, so this module reads the
 * two fields it forwards instead of importing its owner's types.
 * @typedef {{ name?: string, dir?: string } | undefined} ProfileFacts
 */

/**
 * The registry's snapshot of the home contract, when the registry is mounted.
 *
 * `collect` is called with an empty execution on purpose: of the three keys
 * this module forwards, none depends on the execution (only `DSH_SESSION_ID`
 * does, and that one stays the PTY overlay's own value). A contributor that
 * needs a fuller execution must not break the PTY spawn, so a throwing
 * `collect` degrades to the public-facts fallback in
 * {@link harnessHomeEnvironment} instead of failing the spawn.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the backend's plugin context.
 * @returns {Record<string, string>} the home facts the registry owns, when available.
 */
function registryHomeContract(ctx) {
  /** @type {import('@deepseek-ai/dsh-shell-env').ShellEnvRegistry | undefined} */
  const registry = ctx.get('shellEnv')
  if (registry === undefined) return {}
  try {
    const snapshot = registry.collect(
      /** @type {import('@deepseek-ai/dsh-tools').ToolExecution} */ ({}),
    )
    /** @type {Record<string, string>} */
    const facts = {}
    for (const key of HOME_CONTRACT_KEYS) {
      const value = snapshot[key]
      if (value !== undefined) facts[key] = value
    }
    return facts
  } catch {
    return {}
  }
}

/**
 * The harness home contract for one PTY child: `DSH_HOME` always, plus the
 * profile facts when this context can name them. Values come from the
 * `ctx.shellEnv` registry (the one-shot shell tools' own source) with the
 * public `dsh-home-paths` / `profileContext` sources as the fallback — see the
 * module doc for when each path is taken and why they agree.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the backend's plugin context.
 * @returns {Record<string, string>} the environment overlay to merge into the child environment.
 */
export function harnessHomeEnvironment(ctx) {
  const fromRegistry = registryHomeContract(ctx)
  /** @type {ProfileFacts} */
  const profile = ctx.get('profileContext')
  /** @type {Record<string, string>} */
  const environment = { [DSH_HOME_ENV]: fromRegistry[DSH_HOME_ENV] ?? resolveDshHome() }
  const profileName = fromRegistry[DSH_PROFILE_KEY] ?? profile?.name
  const profileDir = fromRegistry[DSH_PROFILE_DIR_KEY] ?? profile?.dir
  if (profileName !== undefined) environment[DSH_PROFILE_KEY] = profileName
  if (profileDir !== undefined) environment[DSH_PROFILE_DIR_KEY] = profileDir
  return environment
}

/**
 * One terminal spawn spec with the home contract merged into its environment:
 * the same request object, one layer further down than the base class's own
 * overlay (the provider applies `spec.env` after its ambient scrub).
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalSpawnSpec} spec - the terminal request the base class built.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the backend's plugin context.
 * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalSpawnSpec} the same request with the home facts added.
 */
export function withHarnessHome(spec, ctx) {
  return { ...spec, env: { ...spec.env, ...harnessHomeEnvironment(ctx) } }
}

/**
 * The official local PTY backend with the harness home contract in its child
 * environment. `spawn()` is NOT overridden: argv confinement, the sandbox-mode
 * fence, readiness through `session.initialize()` and the `-C` prompt setup
 * are the base class's own.
 */
export class HarnessHomeTerminalBackend extends BashTerminalBackend {
  /**
   * Wrap the base class's `spawnTerminal` seam so every terminal request it
   * builds carries the home contract. The seam is deliberately not a
   * constructor parameter: the row must not be able to lose the contract.
   * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
   * @param {ConstructorParameters<typeof BashTerminalBackend>[1]} config - the resolved official backend configuration.
   * @param {ConstructorParameters<typeof BashTerminalBackend>[3]} [createSession] - the base class's session-factory seam, for tests; omitted in production, where the base default builds the `LocalPtySession`.
   */
  constructor(ctx, config, createSession) {
    super(ctx, config, (spec) => ctx.subprocess.spawnTerminal(withHarnessHome(spec, ctx)), createSession)
  }
}

/**
 * Register the home-carrying local PTY backend under the configured type
 * (`shell` unless the row overrides it).
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {import('@deepseek-ai/dsh-terminal-bash').TerminalLocalConfig} [config] - optional backend configuration.
 */
export function apply(ctx, config = {}) {
  // The exported `Config` is the official schema, so cordis has already
  // resolved this object; resolving again keeps a direct `apply()` call (tests,
  // direct assembly) on the same defaults the official backend materializes.
  const resolved = /** @type {ConstructorParameters<typeof BashTerminalBackend>[1]} */ (
    /** @type {unknown} */ (Config(config))
  )
  ctx.terminals.registerBackend(new HarnessHomeTerminalBackend(ctx, resolved))
}
