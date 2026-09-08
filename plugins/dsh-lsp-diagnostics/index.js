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
import { createDiagnosticsTool } from './tool.js'

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

/** @typedef {'typescript' | 'go' | 'clangd' | 'rust' | 'python'} ProviderId */

/** @type {readonly ProviderId[]} */
const PROVIDERS = Object.freeze(['typescript', 'go', 'clangd', 'rust', 'python'])
/** @type {readonly ProviderId[]} */
const DEFAULT_ENABLED_PROVIDERS = Object.freeze(['typescript', 'go'])

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
 * @property {{ typescript?: unknown, go?: unknown, clangd?: unknown, rust?: unknown, python?: unknown }} [servers]
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
 * @property {Partial<Record<ProviderId, ServerConfig>>} servers
 */

/**
 * Canonical, closed extension route: only these mappings may ever exist.
 * @type {Readonly<Record<string, Readonly<{ provider: ProviderId, language: string }>>>}
 */
const CANONICAL_ROUTE = Object.freeze({
  '.ts': Object.freeze({ provider: 'typescript', language: 'typescript' }),
  '.tsx': Object.freeze({ provider: 'typescript', language: 'typescriptreact' }),
  '.go': Object.freeze({ provider: 'go', language: 'go' }),
  '.c': Object.freeze({ provider: 'clangd', language: 'c' }),
  '.cc': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.cpp': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.cxx': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.h': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.hh': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.hpp': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.hxx': Object.freeze({ provider: 'clangd', language: 'cpp' }),
  '.rs': Object.freeze({ provider: 'rust', language: 'rust' }),
  '.py': Object.freeze({ provider: 'python', language: 'python' }),
  '.pyi': Object.freeze({ provider: 'python', language: 'python' }),
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
  clangd: Object.freeze({
    command: 'clangd',
    args: Object.freeze([]),
    env: Object.freeze({}),
    configuration: Object.freeze({}),
    initializationOptions: null,
    extensionToLanguage: Object.freeze({
      '.c': 'c',
      '.cc': 'cpp',
      '.cpp': 'cpp',
      '.cxx': 'cpp',
      '.h': 'cpp',
      '.hh': 'cpp',
      '.hpp': 'cpp',
      '.hxx': 'cpp',
    }),
  }),
  rust: Object.freeze({
    command: 'rust-analyzer',
    args: Object.freeze([]),
    env: Object.freeze({}),
    configuration: Object.freeze({}),
    initializationOptions: null,
    extensionToLanguage: Object.freeze({ '.rs': 'rust' }),
  }),
  python: Object.freeze({
    command: 'pyright-langserver',
    args: Object.freeze(['--stdio']),
    env: Object.freeze({}),
    configuration: Object.freeze({}),
    initializationOptions: null,
    extensionToLanguage: Object.freeze({ '.py': 'python', '.pyi': 'python' }),
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
 * @param {ProviderId} provider - the owning provider id.
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
  const defaults = DEFAULT_SERVERS[provider]
  if (defaults === undefined) fail(`provider ${provider} has no catalog defaults`)
  const expected = defaults.extensionToLanguage
  const expectedExtensions = Object.keys(expected)
  if (
    routes.size !== expectedExtensions.length
    || !expectedExtensions.every((extension) => routes.get(extension) === expected[extension])
  ) {
    fail(`servers.${provider}.extensionToLanguage must equal the canonical provider mapping`)
  }
  return Object.fromEntries(routes)
}

/**
 * Validate one provider's server config, merging per-field defaults.
 * An own property explicitly set to `undefined` is NOT omission: the declared
 * strict type check must run on the actual value and fail loud, exactly like
 * an explicit `null`. Only a truly omitted key (no own enumerable property)
 * falls back to the per-field default.
 * @param {unknown} value - the raw server config.
 * @param {ProviderId} provider - the provider id.
 * @returns {ServerConfig}
 */
function validateServer(value, provider) {
  const record = assertRecord(value, `servers.${provider}`)
  for (const key of Object.keys(record)) {
    if (!SERVER_KEYS.has(key)) fail(`unknown key "${key}" in servers.${provider}`)
  }
  const defaults = /** @type {ServerConfig} */ (DEFAULT_SERVERS[provider])
  /** @param {string} key @returns {boolean} */
  const own = (key) => Object.prototype.hasOwnProperty.call(record, key)
  const command = own('command') ? record.command : defaults.command
  if (typeof command !== 'string' || command.length === 0) {
    fail(`servers.${provider}.command must be a non-empty string`)
  }
  const args = own('args') ? record.args : defaults.args
  // `Array.prototype.some` skips holes, so a sparse array must be rejected
  // explicitly. Each accepted argv value is then reused from this validated
  // snapshot: getter-backed arrays must not be read a second time after the
  // type check and drift into an unvalidated runtime argv entry.
  if (!Array.isArray(args)) {
    fail(`servers.${provider}.args must be a string array`)
  }
  /** @type {string[]} */
  const argsRecord = []
  for (let index = 0; index < args.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(args, index)) {
      fail(`servers.${provider}.args must be a string array without holes`)
    }
    const entry = args[index]
    if (typeof entry !== 'string') {
      fail(`servers.${provider}.args must be a string array without holes`)
    }
    argsRecord.push(entry)
  }
  const env = assertRecord(own('env') ? record.env : defaults.env, `servers.${provider}.env`)
  const envEntries = Object.entries(env)
  for (const [key, entry] of envEntries) {
    if (typeof entry !== 'string') fail(`servers.${provider}.env.${key} must be a string`)
  }
  const envRecord = /** @type {Record<string, string>} */ (Object.fromEntries(envEntries))
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
    own('extensionToLanguage') ? record.extensionToLanguage : defaults.extensionToLanguage,
    provider,
  )
  return { command, args: argsRecord, env: envRecord, configuration, initializationOptions, extensionToLanguage }
}

/**
 * Build the default server config for a provider.
 * @param {ProviderId} provider - the provider id.
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
 * Validate the closed servers catalog. Default-enabled providers are always
 * present; a supplied provider object overlays only that provider's defaults,
 * and an optional provider is activated only when its known key is supplied.
 * An explicit `servers: undefined` (own property) must fail loud, so this
 * function never treats `undefined` as omission; the caller clones the
 * defaults only when the key is truly absent.
 * @param {unknown} value - the raw servers config.
 * @returns {Partial<Record<ProviderId, ServerConfig>>}
 */
function validateServers(value) {
  const record = assertRecord(value, 'servers')
  for (const provider of Object.keys(record)) {
    if (!PROVIDERS.includes(/** @type {ProviderId} */ (provider))) {
      fail(`unknown provider "${provider}" in servers`)
    }
  }
  /** @type {Partial<Record<ProviderId, ServerConfig>>} */
  const servers = {}
  for (const provider of PROVIDERS) {
    const supplied = Object.prototype.hasOwnProperty.call(record, provider)
    if (!supplied && !DEFAULT_ENABLED_PROVIDERS.includes(provider)) continue
    servers[provider] = supplied ? validateServer(record[provider], provider) : cloneDefaultServer(provider)
  }
  return servers
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
      /** @param {string} key @returns {boolean} */
      const own = (key) => Object.prototype.hasOwnProperty.call(record, key)
      const enabled = own('enabled') ? raw.enabled : DEFAULTS.enabled
      if (typeof enabled !== 'boolean') fail('enabled must be a boolean')
      const timeoutMs = assertSafeTimer(own('timeoutMs') ? raw.timeoutMs : DEFAULTS.timeoutMs, 'timeoutMs')
      const settleMs = assertSafeTimer(own('settleMs') ? raw.settleMs : DEFAULTS.settleMs, 'settleMs')
      if (settleMs >= timeoutMs) fail('settleMs must be < timeoutMs')
      const shutdownTimeoutMs = assertSafeTimer(
        own('shutdownTimeoutMs') ? raw.shutdownTimeoutMs : DEFAULTS.shutdownTimeoutMs,
        'shutdownTimeoutMs',
      )
      const killGraceMs = assertSafeTimer(own('killGraceMs') ? raw.killGraceMs : DEFAULTS.killGraceMs, 'killGraceMs')
      const maxDocumentBytes = assertSafeTimer(
        own('maxDocumentBytes') ? raw.maxDocumentBytes : DEFAULTS.maxDocumentBytes,
        'maxDocumentBytes',
      )
      const maxMessageBytes = assertSafeTimer(
        own('maxMessageBytes') ? raw.maxMessageBytes : DEFAULTS.maxMessageBytes,
        'maxMessageBytes',
      )
      const maxStderrBytes = assertSafeTimer(
        own('maxStderrBytes') ? raw.maxStderrBytes : DEFAULTS.maxStderrBytes,
        'maxStderrBytes',
      )
      const maxDiagnostics = assertSafeTimer(
        own('maxDiagnostics') ? raw.maxDiagnostics : DEFAULTS.maxDiagnostics,
        'maxDiagnostics',
      )
      const maxResultChars = assertSafeTimer(
        own('maxResultChars') ? raw.maxResultChars : DEFAULTS.maxResultChars,
        'maxResultChars',
      )
      const reportClean = own('reportClean') ? raw.reportClean : DEFAULTS.reportClean
      if (typeof reportClean !== 'boolean') fail('reportClean must be a boolean')
      const servers = own('servers')
        ? validateServers(raw.servers)
        : validateServers({})
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
 * When enabled, assembles one mutation collector, one diagnostics runtime, the
 * post-execute coordinator, and one direct tool owner sharing that runtime.
 * It registers the tool plus exactly two listeners (`fs/observed` and
 * `tools/post-execute`), holds every exact disposer, and registers one cleanup
 * effect: stop direct/coordinator admission → off tool/post/observed → abort
 * both owners → await both owners → await retired I/O → `runtime.dispose()`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {PluginConfig} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  if (config.enabled === false) return
  const collector = createMutationCollector()
  // The public services are consumed through the plugin's loose structural
  // seams: `ctx.fs`/`ctx.subprocess`/`ctx.tools` are harness services and are
  // not statically visible on the cordis Context surface here.
  const services = /** @type {{ fs: unknown, subprocess: unknown, tools: { register(definition: unknown): () => unknown } }} */ (/** @type {unknown} */ (ctx))
  const fs = /** @type {import('./tool.js').FsSeam} */ (services.fs)
  const runtime = new DiagnosticsRuntime({
    fs: /** @type {import('./runtime.js').FsSeam} */ (fs),
    subprocess: /** @type {import('./runtime.js').SubprocessSeam} */ (services.subprocess),
    config,
  })
  const coordinator = createDiagnosticsCoordinator({
    collector,
    runtime,
    config,
    fs: /** @type {import('./coordinator.js').FsSeam} */ (fs),
  })
  const toolOwner = createDiagnosticsTool({ fs, runtime, config })
  const offTool = services.tools.register(toolOwner.definition)
  const offObserved = ctx.on('fs/observed', (target, observation, actor) => {
    if (collector.observe(actor, target, observation) === true) toolOwner.observeMutation(target)
  })
  const onPostExecute = /** @type {(name: string, listener: unknown) => () => boolean} */ (ctx.on)
  const offPost = onPostExecute('tools/post-execute', coordinator.listener)
  ctx.effect(() => async () => {
    const errors = []
    for (const stop of [toolOwner.stopAdmission, coordinator.stopAdmission]) {
      try {
        stop()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const off of [offTool, offPost, offObserved]) {
      try {
        await Promise.resolve(off())
      } catch (error) {
        errors.push(error)
      }
    }
    for (const abort of [coordinator.abortActiveOperations, toolOwner.abortActiveOperations]) {
      try {
        abort()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const awaitActive of [coordinator.awaitActiveOperations, toolOwner.awaitActiveOperations]) {
      try {
        await awaitActive()
      } catch (error) {
        errors.push(error)
      }
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
  }, 'dsh-lsp-diagnostics tool, listeners, operations, retired I/O, and runtime teardown')
}
