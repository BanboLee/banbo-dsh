/**
 * @banbolee/dsh-llm-pi-ai-with-session: a Cordis plugin that registers LLM provider
 * routes whose requests carry the live dsh session id in a configurable HTTP
 * header.
 *
 * The plugin registers explicitly configured session routes. Each route names
 * one source provider profile registered under the `llm-pi-ai` settings
 * namespace, then serves that source through pi-ai's openai-completions wire
 * path with every request additionally identifying its dsh session. Gateway,
 * models, credential, and reasoning defaults are inherited from the source
 * provider rather than restated here.
 *
 * @module @banbolee/dsh-llm-pi-ai-with-session
 */

import { SessionHeaderAdapter } from './adapter.js'

/** Bundle row id this plugin is mounted under (`cordis.patch.yml`). */
export const name = 'llm-pi-ai-with-session'

/** The plugin registers on the harness LLM service; settings is optional. */
export const inject = ['llm']

/** The settings namespace llm-pi-ai owns; the mirror source. */
const LLM_PI_AI_NS = 'llm-pi-ai'

/**
 * Plugin configuration: session header name and route declarations. Every
 * gateway, credential, model, and reasoning knob is inherited from the source
 * llm-pi-ai provider rather than restated here.
 *
 * A plain object implementing the standard-schema interface (no external
 * validator): unknown keys are ignored; defaults fill the omitted fields. A
 * `providers` table may ride through for explicit/local injection (tests or a
 * settings-less composition); it is validated nowhere here.
 */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: '@banbolee/dsh-llm-pi-ai-with-session',
    /**
     * @param {any} value - raw configuration supplied by the Loader, or a test.
     * @returns {{ value: import('./adapter.js').SessionHeaderConfig }} the validated configuration.
     */
    validate(value) {
      const input = value ?? {}
      return {
        value: {
          sessionHeader: input.sessionHeader ?? 'x-session-id',
          routes: Array.isArray(input.routes)
            ? input.routes
              .filter((/** @type {any} */ route) => typeof route?.route === 'string' && typeof route?.source === 'string')
              .map((/** @type {any} */ route) => ({
                route: route.route,
                source: route.source,
                ...typeof route.displayName === 'string' ? { displayName: route.displayName } : {},
              }))
            : [],
          ...input.providers === undefined ? {} : { providers: input.providers },
        },
      }
    },
  },
}

/**
 * Read the mirrored provider table out of the settings forms service.
 *
 * 0.1.7 replaced `SettingsProvider` and `ctx.settings.get(ns)` with
 * `SettingsForms`: `describe()` reports every active profile entry's live
 * value, projected onto the fields that entry declares volatile — which is how
 * llm-pi-ai declares its `providers` dict. A namespace that is not mounted, or
 * that projects no volatile field, mirrors as an empty table.
 * @param {import('@deepseek-ai/dsh-settings').SettingsForms} settings - the settings forms service.
 * @returns {Record<string, import('./model.js').ProviderProfile>} the mirrored provider table, empty when the namespace is absent.
 */
function mirroredProviders(settings) {
  const entry = settings.describe().find(candidate => candidate.ns === LLM_PI_AI_NS)
  const value = entry?.value
  if (value === null || typeof value !== 'object') return {}
  const providers = Reflect.get(value, 'providers')
  return providers !== null && typeof providers === 'object' ? providers : {}
}

/**
 * Install the session routes for one providers source. The settings-backed
 * source is read live (and re-read on every notification), so every
 * per-request fact (timeouts, headers, models) tracks the current settings
 * snapshot; a change to the registration-captured facts (route set, display
 * names, retry policies) re-registers the same adapter in place, so a
 * `retryPolicy` edit takes effect without a restart. An update that cannot be
 * served — a declared source that disappeared, a profile mid-edit — is refused
 * as a whole: the previously accepted snapshot and routes stay live, and the
 * next notification retries.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {import('./adapter.js').SessionHeaderConfig} config - validated plugin configuration.
 * @param {Record<string, import('./model.js').ProviderProfile> | (() => Record<string, import('./model.js').ProviderProfile> | undefined)} providers - static providers table, or a getter returning the latest `llm-pi-ai` settings snapshot.
 * @param {import('@deepseek-ai/cordis').Context} [settingsCtx] - settings-injected context; its presence enables the settings-update listener.
 */
function install(ctx, config, providers, settingsCtx) {
  const routes = config.routes.map(route => route.route)
  if (routes.length === 0) return
  const readProviders = () => (typeof providers === 'function' ? providers() : providers) ?? {}
  let currentProviders = readProviders()
  // Hand the harness context to the adapter so it can resolve the
  // credentials service lazily at request time (it may not be mounted yet
  // while this plugin applies), exactly like the native dsh-llm-pi-ai
  // adapter, before falling back to the environment. The providers getter is
  // this installer's last accepted settings snapshot, never the raw live
  // document, so refused updates cannot create half-live routes.
  const adapter = new SessionHeaderAdapter({ ...config, providers: () => currentProviders, routes: config.routes, ctx })
  /** @type {import('@deepseek-ai/dsh-llm').AdapterRegistrationHandle | undefined} */
  let registration
  /** @type {string | undefined} */
  let registeredFacts
  /**
   * The registration-captured facts of one mirrored table: the route set,
   * whether each declared source exists, its display name, and its retry
   * policy. A change to any of them re-registers the same adapter in place.
   * @param {Record<string, import('./model.js').ProviderProfile>} table - one mirrored table.
   * @returns {Array<Array<unknown>>} comparable facts.
   */
  const factsOf = table => config.routes.map(route => {
    const profile = table[route.source]
    return [
      route.route,
      profile !== undefined,
      route.displayName ?? profile?.displayName ?? route.route,
      profile?.retryPolicy,
    ]
  })
  const ensureRegistration = () => {
    const table = readProviders()
    const serialized = JSON.stringify(factsOf(table))
    if (serialized === registeredFacts) {
      currentProviders = table
      return
    }
    if (registration === undefined && Object.keys(table).length === 0) {
      // Nothing is serviceable yet: an absent or empty table is "not
      // configured", not a conflicting update, so the plugin stays dormant and
      // picks the declared routes up as soon as providers arrive.
      registeredFacts = serialized
      return
    }
    const previousProviders = currentProviders
    currentProviders = table
    try {
      if (registration === undefined) {
        registration = ctx.llm.registerAdapter(routes, adapter)
      } else {
        registration.replace(routes)
      }
    } catch (error) {
      currentProviders = previousProviders
      throw error
    }
    // Only advance once the registry actually holds the new set, so returning
    // to a working configuration always re-applies.
    registeredFacts = serialized
  }
  if (settingsCtx !== undefined) {
    // The settings service announces a changed entry with no dispatch `this`,
    // so a listener on this plugin's own context observes every namespace; only
    // the mirrored one matters here. (`loader/volatile-update` cannot serve as
    // the trigger: cordis-plugin-loader scopes it to the changed plugin's own
    // fiber — `self[Context.filter] = owner => owner.fiber === fiber` — while
    // every settings write ends in `SettingsForms.describe()`, which emits this
    // event.) Registered before the first attempt so a refused initial install
    // recovers as soon as the configuration can be served.
    ctx.on('settings/document-updated', (ns) => {
      if (ns !== LLM_PI_AI_NS) return
      try {
        ensureRegistration()
      } catch (error) {
        ctx.logger.error('llm-pi-ai-with-session: keeping the previously accepted routes and providers after a refused settings update')
        ctx.logger.error(error)
      }
    })
  }
  ensureRegistration()
}

/**
 * Register the explicitly configured session routes. When the plugin config
 * carries an explicit `providers` table it is used directly (local injection);
 * otherwise the table is read live from the `llm-pi-ai` settings namespace —
 * an absent namespace, empty table, or empty route list leaves the plugin
 * dormant with zero routes, never an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {import('./adapter.js').SessionHeaderConfig} config - validated plugin configuration.
 */
export default function apply(ctx, config) {
  if (config.providers !== undefined) {
    install(ctx, config, config.providers)
    return
  }
  ctx.inject(['settings'], (settingsCtx) => {
    const readProviders = () => mirroredProviders(settingsCtx.settings)
    install(ctx, config, readProviders, settingsCtx)
  })
}

apply.inject = inject
apply.Config = Config
