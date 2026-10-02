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
 * Fallback: ONLY when the registry is not mounted at all (`ctx.get('shellEnv')`
 * is `undefined` — a custom composition outside `dsh-base`) are the same three
 * facts read from their public owners instead: `resolveDshHome()` and
 * `ctx.get('profileContext')`, which are the registry's own sources — so the
 * values are byte-identical unless a profile configures `dshHome` on its
 * `shell-env` row, which only the registry path can see. When the service IS
 * mounted, a throwing `collect()` PROPAGATES instead: the one-shot shell path
 * collects fail-loud too, and swallowing that error would silently resolve a
 * DIFFERENT home (the ambient `DSH_HOME`) than the one the registry recorded —
 * the exact failure this module exists to remove.
 *
 * The config surface is the official one in behaviour, not only in shape: the
 * `apply` below runs the official `resolveConfig`/`validateConfig` semantics
 * (replicated as {@link resolveTerminalConfig} / {@link validateTerminalConfig},
 * because the official package does not export them), so an empty
 * `shellPath`/`shellArgs` gets the dialect defaults and an invalid duration is
 * rejected rather than accepted. A parity test drives the official `apply` and
 * this one with the same inputs and compares the effective config and the
 * validation outcome.
 *
 * Upstream note: this subclass is only here because the official row exposes
 * no `env` config field. If `@deepseek-ai/dsh-terminal-bash` ever grows one
 * (or accepts an environment overlay from the registry itself), the patch row
 * can go back to the official package and this module can be deleted — together
 * with the `NESTED_DSH_ENTRY` contract in
 * `tests/docs-shape-fish-shell.spec.ts`, which names this module.
 *
 * @module @banbolee/dsh-fish-shell/terminal
 */

import { BashTerminalBackend, Config } from '@deepseek-ai/dsh-terminal-bash'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

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

/** Bash dialect default executable — the official `DEFAULT_BASH_SHELL`. */
const DEFAULT_BASH_SHELL = '/bin/bash'
/** Bash dialect default arguments (interactive, profile-free) — the official `DEFAULT_BASH_ARGS`. */
const DEFAULT_BASH_ARGS = ['--noprofile', '--norc', '-i']
/** Pwsh dialect default arguments — the official `DEFAULT_PWSH_ARGS`. */
const DEFAULT_PWSH_ARGS = ['-NoLogo', '-NoProfile']

/**
 * The official `resolveConfig`, replicated from
 * `@deepseek-ai/dsh-terminal-bash@0.2.0-rc.1` (`lib/index.js:27-35`; the
 * official package does not export it). An unset or EMPTY
 * `shellPath`/`shellArgs` selects the dialect's defaults — schemastery
 * materializes an absent optional array as `[]` — while a non-empty explicit
 * value always wins. This module re-exports the official schema, so both
 * `apply`s must materialize the same effective config; the parity test drives
 * the official `apply` and this one side by side. Keep in sync with the
 * official source: a change there changes this row's config contract.
 * @param {import('@deepseek-ai/dsh-terminal-bash').TerminalLocalConfig} config - the schemastery-resolved plugin configuration.
 * @returns {ConstructorParameters<typeof BashTerminalBackend>[1]} the fully resolved configuration.
 */
export function resolveTerminalConfig(config) {
  const shellDialect = config.shellDialect ?? 'bash'
  return /** @type {ConstructorParameters<typeof BashTerminalBackend>[1]} */ ({
    ...config,
    shellDialect,
    shellPath: config.shellPath !== undefined && config.shellPath.length > 0
      ? config.shellPath
      : shellDialect === 'pwsh' ? resolvePwshPath() : DEFAULT_BASH_SHELL,
    shellArgs: config.shellArgs !== undefined && config.shellArgs.length > 0
      ? config.shellArgs
      : shellDialect === 'pwsh' ? DEFAULT_PWSH_ARGS : DEFAULT_BASH_ARGS,
  })
}

/**
 * The official `validateConfig`, replicated from
 * `@deepseek-ai/dsh-terminal-bash@0.2.0-rc.1` (`lib/index.js:62-74`; not
 * exported) with the official error text verbatim — including the
 * `terminal-bash:` prefix, which is deliberate: the row's config surface IS the
 * official schema, and parity with the official validator (messages compared
 * byte for byte) is a tested contract. Every numeric field is a positive safe
 * integer except `promptTailGraceMs`, whose zero is the documented "no
 * extension" value and which is therefore checked on its own. Keep in sync with
 * the official source.
 * @param {ConstructorParameters<typeof BashTerminalBackend>[1]} config - the resolved configuration.
 * @returns {void} throws on a value the backend cannot run with.
 */
export function validateTerminalConfig(config) {
  if (config.backendType.length === 0) throw new Error('terminal-bash: backendType must be non-empty')
  if (config.shellPath.length === 0) throw new Error('terminal-bash: shellPath must be non-empty')
  for (const [name, value] of Object.entries(config)) {
    if (name === 'promptTailGraceMs') continue
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`terminal-bash: ${name} must be a positive safe integer`)
    }
  }
  if (typeof config.promptTailGraceMs === 'number' && (!Number.isSafeInteger(config.promptTailGraceMs) || config.promptTailGraceMs < 0)) {
    throw new Error('terminal-bash: promptTailGraceMs must be a non-negative safe integer')
  }
  if (config.maxReadBytes > config.scrollbackMaxBytes) throw new Error('terminal-bash: maxReadBytes must not exceed scrollbackMaxBytes')
  if (config.handoffGraceMs < config.pollIntervalMs) throw new Error('terminal-bash: handoffGraceMs must be at least pollIntervalMs so one readiness poll runs inside the grace window')
  if (config.promptTailGraceMs !== 0 && config.promptTailGraceMs < config.pollIntervalMs) throw new Error('terminal-bash: promptTailGraceMs must be zero or at least pollIntervalMs so a nonzero tolerance contains one readiness poll')
}

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
 * does, and that one stays the PTY overlay's own value). A throwing `collect`
 * is NOT swallowed: once the registry is mounted it is the only source that can
 * see a configured `dshHome`, and quietly falling back would resolve a
 * different home — exactly the drift this module removes. It fails loud here
 * for the same reason the one-shot path (`dsh-tool-bash`) does.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the backend's plugin context.
 * @returns {Record<string, string>} the home facts the registry owns; `{}` only when the service is not mounted.
 */
function registryHomeContract(ctx) {
  /** @type {import('@deepseek-ai/dsh-shell-env').ShellEnvRegistry | undefined} */
  const registry = ctx.get('shellEnv')
  if (registry === undefined) return {}
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
}

/**
 * The harness home contract for one PTY child: `DSH_HOME` always, plus the
 * profile facts when this context can name them. Values come from the
 * `ctx.shellEnv` registry (the one-shot shell tools' own source); the public
 * `dsh-home-paths` / `profileContext` fallback is used ONLY when that service is
 * not mounted, and a `collect` error is propagated rather than swallowed — see
 * the module doc for both rules.
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
  // direct assembly) on the same defaults. The two explicit steps after it are
  // the official `apply`'s own: dialect defaulting, then validation.
  const resolved = resolveTerminalConfig(Config(config))
  validateTerminalConfig(resolved)
  ctx.terminals.registerBackend(new HarnessHomeTerminalBackend(ctx, resolved))
}
