/**
 * dsh-llm-pi-ai-with-session: a Cordis plugin that registers an LLM provider
 * route whose requests carry the live dsh session id in a configurable HTTP
 * header.
 *
 * The route reuses pi-ai's openai-completions wire implementation, so the
 * models configured on the route keep working exactly as they would through
 * `llm-pi-ai`, while every request additionally identifies its dsh session.
 * It is a generic session wrapper around the pi-ai LLM path: the gateway,
 * models, credential, and header name are all configuration, with no
 * environment-specific defaults.
 *
 * @module dsh-llm-pi-ai-with-session
 */

import { SessionHeaderAdapter } from './adapter.js'

/** Bundle row id this plugin is mounted under (`cordis.patch.yml`). */
export const name = 'llm-pi-ai-with-session'

/** The plugin registers on the harness LLM service. */
export const inject = ['llm']

/**
 * Plugin configuration: the provider route to register, its gateway, the
 * credential reference, the session header name, and optional model metadata.
 *
 * A plain object implementing the standard-schema interface (no external
 * validator): unknown keys are ignored; defaults fill the omitted fields.
 */
export const Config = {
  '~standard': {
    version: /** @type {1} */ (1),
    vendor: 'dsh-llm-pi-ai-with-session',
    validate(value) {
      const input = value ?? {}
      const baseURL = input.baseURL
      if (typeof baseURL !== 'string' || baseURL.length === 0) {
        return {
          issues: [
            { message: 'dsh-llm-pi-ai-with-session: baseURL is required', path: '/baseURL' },
          ],
        }
      }
      return {
        value: {
          provider: input.provider ?? 'pi-ai-session',
          baseURL,
          apiKeyEnv: input.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
          sessionHeader: input.sessionHeader ?? 'x-session-id',
          models: input.models ?? [],
          reasoning: input.reasoning,
          reasoningEfforts: input.reasoningEfforts,
        },
      }
    },
  },
}

/**
 * Register the session wrapper adapter for the configured provider route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the harness context.
 * @param {object} config - validated plugin configuration.
 */
export default function apply(ctx, config) {
  const adapter = new SessionHeaderAdapter(config)
  ctx.llm.registerAdapter([config.provider], adapter)
}

apply.inject = inject
apply.Config = Config
