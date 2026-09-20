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
    validate(value) {
      const input = value ?? {}
      return {
        value: {
          sessionHeader: input.sessionHeader ?? 'x-session-id',
          routes: Array.isArray(input.routes)
            ? input.routes
              .filter(route => typeof route?.route === 'string' && typeof route?.source === 'string')
              .map(route => ({
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
 * Install the session routes for one providers source. The settings-backed
 * source is a live getter, so every per-request fact (timeouts, headers,
 * models) tracks the current settings snapshot; a change to the
 * registration-captured facts (route set, display names, retry policies)
 * re-registers the same adapter in place, so a `retryPolicy` edit in
 * settings.yaml takes effect without a restart.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {object} config - validated plugin configuration.
 * @param {object | (() => object)} providers - static providers table, or a
 * getter returning the latest `llm-pi-ai` settings snapshot.
 * @param {object} [settingsCtx] - settings-injected context; its presence
 * enables the `settings/updated` re-registration listener.
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
  let registration
  let registeredFacts
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
  ensureRegistration()
  if (settingsCtx !== undefined) {
    ctx.on('settings/updated', (ns) => {
      if (ns !== 'llm-pi-ai') return
      try {
        ensureRegistration()
      } catch (error) {
        ctx.logger.error('llm-pi-ai-with-session: keeping the previously accepted routes and providers after a refused settings update')
        ctx.logger.error(error)
      }
    })
  }
}

/**
 * Register the explicitly configured session routes. When the plugin config
 * carries an explicit `providers` table it is used directly (local injection);
 * otherwise the table is read live from the `llm-pi-ai` settings namespace —
 * an absent namespace, empty table, or empty route list leaves the plugin
 * dormant with zero routes, never an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {object} config - validated plugin configuration.
 */
export default function apply(ctx, config) {
  if (config.providers !== undefined) {
    install(ctx, config, config.providers)
    return
  }
  ctx.inject(['settings'], (settingsCtx) => {
    const readProviders = () => settingsCtx.settings.get('llm-pi-ai')?.providers ?? {}
    install(ctx, config, readProviders, settingsCtx)
  })
}

apply.inject = inject
apply.Config = Config
