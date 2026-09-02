/**
 * dsh-llm-pi-ai-with-session: a Cordis plugin that registers LLM provider
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
 * @module dsh-llm-pi-ai-with-session
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
    vendor: 'dsh-llm-pi-ai-with-session',
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
 * Register the explicitly configured session routes. When the plugin config
 * carries an explicit `providers` table it is used directly (local injection);
 * otherwise the table is read from the `llm-pi-ai` settings namespace — an
 * absent namespace, empty table, or empty route list leaves the plugin dormant
 * with zero routes, never an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {object} config - validated plugin configuration.
 */
export default function apply(ctx, config) {
  const mount = (providers) => {
    const routes = config.routes.map(route => route.route)
    if (routes.length === 0) return
    // Hand the harness context to the adapter so it can resolve the
    // credentials service lazily at request time (it may not be mounted yet
    // while this plugin applies), exactly like the native dsh-llm-pi-ai
    // adapter, before falling back to the environment.
    ctx.llm.registerAdapter(routes, new SessionHeaderAdapter({
      ...config,
      providers,
      routes: config.routes,
      ctx,
    }))
  }
  if (config.providers !== undefined) {
    mount(config.providers)
    return
  }
  ctx.inject(['settings'], (settingsCtx) => {
    const piAi = settingsCtx.settings.get('llm-pi-ai')
    mount(piAi?.providers ?? {})
  })
}

apply.inject = inject
apply.Config = Config
