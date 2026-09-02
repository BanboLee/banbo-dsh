/**
 * dsh-llm-pi-ai-with-session: a Cordis plugin that registers LLM provider
 * routes whose requests carry the live dsh session id in a configurable HTTP
 * header.
 *
 * The plugin mirrors every provider profile registered under the `llm-pi-ai`
 * settings namespace: each source provider becomes a route named
 * `<provider><suffix>` (default `-session`) served by the same openai-
 * completions wire path, with every request additionally identifying its dsh
 * session. Gateway, models, credential, and reasoning defaults are inherited
 * from the mirrored provider rather than restated here.
 *
 * @module dsh-llm-pi-ai-with-session
 */

import { SessionHeaderAdapter } from './adapter.js'

/** Bundle row id this plugin is mounted under (`cordis.patch.yml`). */
export const name = 'llm-pi-ai-with-session'

/** The plugin registers on the harness LLM service; settings is optional. */
export const inject = ['llm']

/**
 * Plugin configuration: only the session header name. Every other knob —
 * gateway, credential, models, reasoning, and the route suffix — is inherited
 * from the mirrored llm-pi-ai provider rather than restated here: each source
 * provider becomes a route named `<provider>-session`.
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
          ...input.providers === undefined ? {} : { providers: input.providers },
        },
      }
    },
  },
}

/**
 * Register one session-wrapper adapter owning one `-session` route per source
 * provider. When the plugin config carries an explicit `providers` table it is
 * mirrored directly (local injection); otherwise the table is read from the
 * `llm-pi-ai` settings namespace — an absent namespace or empty table leaves
 * the plugin dormant with zero routes, never an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {object} config - validated plugin configuration.
 */
export default function apply(ctx, config) {
  const mount = (providers) => {
    const routes = Object.keys(providers).map(name => `${name}-session`)
    if (routes.length === 0) return
    // Hand the harness context to the adapter so it can resolve the
    // credentials service lazily at request time (it may not be mounted yet
    // while this plugin applies), exactly like the native dsh-llm-pi-ai
    // adapter, before falling back to the environment.
    ctx.llm.registerAdapter(routes, new SessionHeaderAdapter({
      ...config,
      providers,
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
