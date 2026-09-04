/**
 * Public entrypoint of `dsh-lsp-diagnostics`: a Cordis function plugin that
 * appends a single bounded aggregate LSP diagnostics notice to a successful
 * write/edit/str_replace_editor mutation inside the session workspace.
 *
 * @module dsh-lsp-diagnostics
 */

import { createMutationCollector } from './collector.js'
import { createDiagnosticsCoordinator } from './coordinator.js'
import { DiagnosticsRuntime } from './runtime.js'

/** Bundle row id this plugin is mounted under (`cordis.patch.yml`). */
export const name = 'lsp-diagnostics'

/** The plugin observes mutations and post-executes on the tools pipeline. */
export const inject = ['fs', 'subprocess', 'tools']

const MAX_NODE_TIMER = 2_147_483_647

const TOP_LEVEL_KEYS = new Set([
  'enabled',
  'timeoutMs',
  'settleMs',
  'shutdownTimeoutMs',
  'killGraceMs',
  'maxDocumentBytes',
  'maxMessageBytes',
  'maxStderrBytes',
  'maxDiagnostics',
  'maxResultChars',
  'reportClean',
  'servers',
])

const SERVER_KEYS = new Set(['command', 'args', 'env', 'configuration', 'initializationOptions', 'extensionToLanguage'])

const PROVIDERS = ['typescript', 'go']

/**
 * @typedef {object} ServerConfig
 * @property {string} command - non-empty server executable name.
 * @property {readonly string[]} args - additional argv entries.
 * @property {Record<string, string>} env - string-to-string environment.
 * @property {unknown} configuration - JSON-representable workspace config.
 * @property {unknown} initializationOptions - JSON-representable init options.
 * @property {Record<string, string>} extensionToLanguage - fixed route map.
 */

/**
 * @typedef {object} RawConfig
 * @property {boolean} [enabled]
 * @property {number} [timeoutMs]
 * @property {number} [settleMs]
 * @property {number} [shutdownTimeoutMs]
 * @property {number} [killGraceMs]
 * @property {number} [maxDocumentBytes]
 * @property {number} [maxMessageBytes]
 * @property {number} [maxStderrBytes]
 * @property {number} [maxDiagnostics]
 * @property {number} [maxResultChars]
 * @property {boolean} [reportClean]
 * @property {{ typescript?: unknown, go?: unknown }} [servers]
 */

/**
 * @typedef {object} PluginConfig
 * @property {boolean} enabled
 * @property {number} timeoutMs
 * @property {number} settleMs
 * @property {number} shutdownTimeoutMs
 * @property {number} killGraceMs
 * @property {number} maxDocumentBytes
 * @property {number} maxMessageBytes
 * @property {number} maxStderrBytes
 * @property {number} maxDiagnostics
 * @property {number} maxResultChars
 * @property {boolean} reportClean
 * @property {{ typescript: ServerConfig, go: ServerConfig }} servers
 */

/**
 * Canonical, closed extension route: only these mappings may ever exist.
 * @type {Readonly<Record<string, Readonly<{ provider: string, language: string }>>>}
 */
const CANONICAL_ROUTE = Object.freeze({
  '.ts': Object.freeze({ provider: 'typescript', language: 'typescript' }),
  '.tsx': Object.freeze({ provider: 'typescript', language: 'typescriptreact' }),
  '.go': Object.freeze({ provider: 'go', language: 'go' }),
})

/**
 * @type {Readonly<Record<string, Readonly<{ command: string, args: readonly string[], env: Readonly<Record<string, string>>, configuration: unknown, initializationOptions: unknown, extensionToLanguage: Readonly<Record<string, string>> }>>>}
 */
const DEFAULT_SERVERS = Object.freeze({
  typescript: Object.freeze({
    command: 'typescript-language-server',
    args: Object.freeze(['--stdio']),
    env: Object.freeze({}),
    configuration: Object.freeze({}),
    initializationOptions: null,
    extensionToLanguage: Object.freeze({ '.ts': 'typescript', '.tsx': 'typescriptreact' }),
  }),
  go: Object.freeze({
    command: 'gopls',
    args: Object.freeze([]),
    env: Object.freeze({}),
    configuration: Object.freeze({}),
    initializationOptions: null,
    extensionToLanguage: Object.freeze({ '.go': 'go' }),
  }),
})

const DEFAULTS = Object.freeze({
  enabled: true,
  timeoutMs: 5000,
  settleMs: 200,
  shutdownTimeoutMs: 1000,
  killGraceMs: 500,
  maxDocumentBytes: 2_097_152,
  maxMessageBytes: 4_194_304,
  maxStderrBytes: 16_384,
  maxDiagnostics: 50,
  maxResultChars: 8000,
  reportClean: true,
})

/**
 * @param {string} message - the failure detail.
 * @returns {never}
 */
function fail(message) {
  throw new Error(`dsh-lsp-diagnostics config: ${message}`)
}

/**
 * @param {unknown} value - candidate record.
 * @param {string} path - error path prefix.
 * @returns {Record<string, unknown>}
 */
function assertRecord(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} value - candidate timer/cap value.
 * @param {string} name - config key name.
 * @returns {number}
 */
function assertSafeTimer(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_NODE_TIMER) {
    fail(`${name} must be a positive safe integer <= ${MAX_NODE_TIMER}`)
  }
  return value
}

/**
 * Canonicalize a validated JSON value into a stable plain clone, rejecting
 * anything that is not recursively a standard JSON value: cycles,
 * undefined/function/symbol/bigint, non-finite numbers, and non-plain
 * containers (Map/Set/Date, boxed primitives, class instances, and objects
 * whose prototype is not `Object.prototype` or `null` — including objects
 * with an inherited `toJSON`).
 *
 * The clone is built by reading every own enumerable property exactly once,
 * so later protocol serialization always sees the same plain structure: a
 * stateful getter or `toJSON` can never be re-invoked, produce a second
 * different value, or fail at protocol-write time.
 * @param {unknown} value - the value to canonicalize.
 * @param {string} path - error path prefix.
 * @param {Set<object>} [seen] - container set for cycle detection.
 * @returns {unknown} the canonical plain-JSON clone.
 */
function canonicalizeJson(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must not contain non-finite numbers`)
    return value
  }
  if (typeof value !== 'object') {
    fail(`${path} must not contain ${typeof value}`)
  }
  if (seen.has(value)) fail(`${path} must not contain circular references`)
  seen.add(value)
  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      out[index] = canonicalizeJson(value[index], `${path}[${index}]`, seen)
    }
    seen.delete(value)
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    fail(`${path} must be a plain object, not ${value.constructor?.name ?? 'a non-JSON container'}`)
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(record)) {
    out[key] = canonicalizeJson(record[key], `${path}.${key}`, seen)
  }
  seen.delete(value)
  return out
}

/**
 * Validate a provider's extensionToLanguage map against the canonical route.
 * @param {unknown} map - the extension map.
 * @param {'typescript' | 'go'} provider - the owning provider id.
 * @returns {Record<string, string>}
 */
function assertExtensionToLanguage(map, provider) {
  const record = assertRecord(map, `servers.${provider}.extensionToLanguage`)
  /** @type {Map<string, string>} */
  const routes = new Map()
  for (const [extension, language] of Object.entries(record)) {
    if (extension !== extension.toLowerCase()) {
      fail(`servers.${provider}.extensionToLanguage key ${String(extension)} must be ASCII lowercase`)
    }
    const canonical = CANONICAL_ROUTE[extension]
    if (canonical === undefined) {
      fail(`servers.${provider}.extensionToLanguage key ${String(extension)} is not a supported extension`)
    }
    if (canonical.provider !== provider) {
      fail(`extension ${extension} must be declared by provider ${canonical.provider}`)
    }
    if (typeof language !== 'string' || language.length === 0) {
      fail(`servers.${provider}.extensionToLanguage.${extension} must be a non-empty language id`)
    }
    if (language !== canonical.language) {
      fail(`extension ${extension} must map to language ${canonical.language}`)
    }
    routes.set(extension, language)
  }
  return Object.fromEntries(routes)
}

/**
 * Validate one provider's server config, merging per-field defaults.
 * @param {unknown} value - the raw server config.
 * @param {'typescript' | 'go'} provider - the provider id.
 * @returns {ServerConfig}
 */
function validateServer(value, provider) {
  const record = assertRecord(value, `servers.${provider}`)
  for (const key of Object.keys(record)) {
    if (!SERVER_KEYS.has(key)) fail(`unknown key "${key}" in servers.${provider}`)
  }
  const defaults = /** @type {ServerConfig} */ (DEFAULT_SERVERS[provider])
  const command = record.command === undefined ? defaults.command : record.command
  if (typeof command !== 'string' || command.length === 0) {
    fail(`servers.${provider}.command must be a non-empty string`)
  }
  const args = record.args === undefined ? defaults.args : record.args
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    fail(`servers.${provider}.args must be a string array`)
  }
  const env = assertRecord(record.env === undefined ? defaults.env : record.env, `servers.${provider}.env`)
  for (const [key, entry] of Object.entries(env)) {
    if (typeof entry !== 'string') fail(`servers.${provider}.env.${key} must be a string`)
  }
  const envRecord = /** @type {Record<string, string>} */ (Object.fromEntries(
    Object.entries(env).map(([key, entry]) => [key, String(entry)]),
  ))
  // `configuration` and `initializationOptions` are standard JSON values;
  // explicit `null` is a valid JSON value and must be preserved, never
  // defaulted. Only a truly omitted field (no own enumerable property) falls
  // back to the default; an own property whose value is `undefined` is not a
  // JSON value and fails loud. Every accepted value is canonicalized once into
  // a stable plain clone so protocol serialization is deterministic.
  const hasConfiguration = Object.prototype.hasOwnProperty.call(record, 'configuration')
  const configuration = hasConfiguration
    ? canonicalizeJson(record.configuration, `servers.${provider}.configuration`)
    : canonicalizeJson(defaults.configuration, `servers.${provider}.configuration`)
  const hasInitializationOptions = Object.prototype.hasOwnProperty.call(record, 'initializationOptions')
  const initializationOptions = hasInitializationOptions
    ? canonicalizeJson(record.initializationOptions, `servers.${provider}.initializationOptions`)
    : canonicalizeJson(defaults.initializationOptions, `servers.${provider}.initializationOptions`)
  const extensionToLanguage = assertExtensionToLanguage(
    record.extensionToLanguage === undefined ? defaults.extensionToLanguage : record.extensionToLanguage,
    provider,
  )
  return { command, args: [...args], env: envRecord, configuration, initializationOptions, extensionToLanguage }
}

/**
 * Build the default server config for a provider.
 * @param {'typescript' | 'go'} provider - the provider id.
 * @returns {ServerConfig}
 */
function cloneDefaultServer(provider) {
  const defaults = /** @type {ServerConfig} */ (DEFAULT_SERVERS[provider])
  return {
    command: defaults.command,
    args: [...defaults.args],
    env: { ...defaults.env },
    configuration: defaults.configuration,
    initializationOptions: defaults.initializationOptions,
    extensionToLanguage: { ...defaults.extensionToLanguage },
  }
}

/**
 * Validate the servers block and enforce the complete closed extension route.
 * @param {unknown} value - the raw servers config.
 * @returns {{ typescript: ServerConfig, go: ServerConfig }}
 */
function validateServers(value) {
  let typescript
  let go
  if (value === undefined) {
    typescript = cloneDefaultServer('typescript')
    go = cloneDefaultServer('go')
  } else {
    const record = assertRecord(value, 'servers')
    const providers = Object.keys(record)
    if (providers.length !== PROVIDERS.length || !PROVIDERS.every((provider) => providers.includes(provider))) {
      fail(`servers must declare exactly the providers ${PROVIDERS.join(', ')}`)
    }
    typescript = validateServer(record.typescript, 'typescript')
    go = validateServer(record.go, 'go')
  }
  // The closed route must be complete: exactly .ts/.tsx/.go across providers.
  const covered = new Set([...Object.keys(typescript.extensionToLanguage), ...Object.keys(go.extensionToLanguage)])
  const canonical = Object.keys(CANONICAL_ROUTE)
  if (covered.size !== canonical.length || !canonical.every((extension) => covered.has(extension))) {
    fail(`extension route must cover exactly ${canonical.join(', ')}`)
  }
  return { typescript, go }
}

/**
 * Plugin configuration schema: strict, fail-loud validation with fixed
 * defaults. Unknown keys, invalid JSON values, out-of-range timers/caps,
 * `settleMs >= timeoutMs`, and any deviation from the closed extension route
 * all reject at load time.
 */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: 'dsh-lsp-diagnostics',
    /**
     * @param {unknown} value - raw user config.
     * @returns {{ value: PluginConfig }} the validated config.
     */
    validate(value) {
      // Explicit `null` is never treated as omission: a null config is
      // rejected by assertRecord, and every typed field distinguishes an
      // omitted key (fall back to the default) from an explicit `null`
      // (rejected by its type check). `configuration`/`initializationOptions`
      // are the only fields where `null` is a valid JSON value and survives.
      const input = value === undefined ? {} : value
      const record = assertRecord(input, 'config')
      for (const key of Object.keys(record)) {
        if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown config key "${key}"`)
      }
      /** @type {RawConfig} */
      const raw = record
      const enabled = raw.enabled === undefined ? DEFAULTS.enabled : raw.enabled
      if (typeof enabled !== 'boolean') fail('enabled must be a boolean')
      const timeoutMs = assertSafeTimer(raw.timeoutMs === undefined ? DEFAULTS.timeoutMs : raw.timeoutMs, 'timeoutMs')
      const settleMs = assertSafeTimer(raw.settleMs === undefined ? DEFAULTS.settleMs : raw.settleMs, 'settleMs')
      if (settleMs >= timeoutMs) fail('settleMs must be < timeoutMs')
      const shutdownTimeoutMs = assertSafeTimer(
        raw.shutdownTimeoutMs === undefined ? DEFAULTS.shutdownTimeoutMs : raw.shutdownTimeoutMs,
        'shutdownTimeoutMs',
      )
      const killGraceMs = assertSafeTimer(raw.killGraceMs === undefined ? DEFAULTS.killGraceMs : raw.killGraceMs, 'killGraceMs')
      const maxDocumentBytes = assertSafeTimer(
        raw.maxDocumentBytes === undefined ? DEFAULTS.maxDocumentBytes : raw.maxDocumentBytes,
        'maxDocumentBytes',
      )
      const maxMessageBytes = assertSafeTimer(
        raw.maxMessageBytes === undefined ? DEFAULTS.maxMessageBytes : raw.maxMessageBytes,
        'maxMessageBytes',
      )
      const maxStderrBytes = assertSafeTimer(
        raw.maxStderrBytes === undefined ? DEFAULTS.maxStderrBytes : raw.maxStderrBytes,
        'maxStderrBytes',
      )
      const maxDiagnostics = assertSafeTimer(
        raw.maxDiagnostics === undefined ? DEFAULTS.maxDiagnostics : raw.maxDiagnostics,
        'maxDiagnostics',
      )
      const maxResultChars = assertSafeTimer(
        raw.maxResultChars === undefined ? DEFAULTS.maxResultChars : raw.maxResultChars,
        'maxResultChars',
      )
      const reportClean = raw.reportClean === undefined ? DEFAULTS.reportClean : raw.reportClean
      if (typeof reportClean !== 'boolean') fail('reportClean must be a boolean')
      const servers = validateServers(raw.servers)
      return {
        value: {
          enabled,
          timeoutMs,
          settleMs,
          shutdownTimeoutMs,
          killGraceMs,
          maxDocumentBytes,
          maxMessageBytes,
          maxStderrBytes,
          maxDiagnostics,
          maxResultChars,
          reportClean,
          servers,
        },
      }
    },
  },
}

/**
 * Apply the plugin. `enabled === false` short-circuits with zero collector/
 * runtime/coordinator, zero listeners/effects, and zero subprocesses.
 *
 * When enabled, assembles the mutation collector, the bounded diagnostics
 * runtime, and the post-execute coordinator, registers exactly two listeners
 * (`fs/observed` and `tools/post-execute`) whose disposers are held
 * explicitly, and registers exactly one cleanup effect running the strict
 * plan order: stop admission → offPost → offObserved → abort coordinator
 * operations → await all active augment promises → await all retired
 * late-final-stat I/O → `runtime.dispose()`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {PluginConfig} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  if (config.enabled === false) return
  const collector = createMutationCollector()
  // The public services are consumed through the plugin's loose structural
  // seams: `ctx.fs`/`ctx.subprocess` are the harness services and are not
  // statically visible on the cordis Context surface here.
  const services = /** @type {{ fs: unknown, subprocess: unknown }} */ (/** @type {unknown} */ (ctx))
  const runtime = new DiagnosticsRuntime({
    fs: /** @type {import('./runtime.js').FsSeam} */ (services.fs),
    subprocess: /** @type {import('./runtime.js').SubprocessSeam} */ (services.subprocess),
    config,
  })
  const coordinator = createDiagnosticsCoordinator({
    collector,
    runtime,
    config,
    fs: /** @type {import('./coordinator.js').FsSeam} */ (services.fs),
  })
  const offObserved = ctx.on('fs/observed', (target, observation, actor) => {
    collector.observe(actor, target, observation)
  })
  const onPostExecute = /** @type {(name: string, listener: unknown) => () => boolean} */ (ctx.on)
  const offPost = onPostExecute('tools/post-execute', coordinator.listener)
  ctx.effect(() => async () => {
    coordinator.stopAdmission()
    const errors = []
    for (const off of [offPost, offObserved]) {
      try {
        await Promise.resolve(off())
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      coordinator.abortActiveOperations()
    } catch (error) {
      errors.push(error)
    }
    try {
      await coordinator.awaitActiveOperations()
    } catch (error) {
      errors.push(error)
    }
    try {
      await coordinator.awaitRetiredIo()
    } catch (error) {
      errors.push(error)
    }
    try {
      await runtime.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors)
  }, 'dsh-lsp-diagnostics listeners, operations, retired I/O, and runtime teardown')
}
