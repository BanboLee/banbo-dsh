import { describe, expect, it } from 'vitest'
import { Config } from '../index.js'

/** Validate a raw config object through the plugin's standard-schema interface. */
function parse(value: unknown): unknown {
  const result = Config['~standard'].validate(value)
  if (result.issues !== undefined) throw new Error(String(result.issues))
  return result.value
}

describe('dsh-llm-session-header Config', () => {
  it('defaults the provider route to light-session', () => {
    const config = parse({ baseURL: 'http://gateway.test/v1' }) as { provider?: string }
    expect(config.provider).toBe('light-session')
  })

  it('defaults the session header name to x-session-id', () => {
    const config = parse({ baseURL: 'http://gateway.test/v1' }) as { sessionHeader?: string }
    expect(config.sessionHeader).toBe('x-session-id')
  })

  it('defaults the api key env var to DEEPSEEK_API_KEY', () => {
    const config = parse({ baseURL: 'http://gateway.test/v1' }) as { apiKeyEnv?: string }
    expect(config.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
  })

  it('keeps an explicit provider, session header, and api key env', () => {
    const config = parse({
      provider: 'my-light',
      baseURL: 'http://gateway.test/v1',
      sessionHeader: 'x-dsh-session',
      apiKeyEnv: 'LIGHT_API_KEY',
    }) as { provider?: string; sessionHeader?: string; apiKeyEnv?: string }
    expect(config.provider).toBe('my-light')
    expect(config.sessionHeader).toBe('x-dsh-session')
    expect(config.apiKeyEnv).toBe('LIGHT_API_KEY')
  })

  it('refuses a missing base URL', () => {
    expect(() => parse({})).toThrow()
  })
})
