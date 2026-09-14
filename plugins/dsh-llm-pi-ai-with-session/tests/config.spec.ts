import { describe, expect, it } from 'vitest'
import { Config } from '../index.js'

/** Validate a raw config object through the plugin's standard-schema interface. */
function parse(value: unknown): unknown {
  const result = Config['~standard'].validate(value)
  if (result.issues !== undefined) throw new Error(String(result.issues))
  return result.value
}

describe('@banbolee/dsh-llm-pi-ai-with-session Config', () => {
  it('defaults the session header name to x-session-id', () => {
    const config = parse({}) as { sessionHeader?: string }
    expect(config.sessionHeader).toBe('x-session-id')
  })

  it('keeps an explicit session header', () => {
    const config = parse({ sessionHeader: 'x-dsh-session' }) as { sessionHeader?: string }
    expect(config.sessionHeader).toBe('x-dsh-session')
  })

  it('passes through a providers table without validation', () => {
    const config = parse({
      providers: {
        light: { apiKeyEnv: 'LIGHT_API_KEY', baseURL: 'http://gateway.test/v1' },
      },
    }) as { providers?: Record<string, unknown> }
    expect(config.providers?.light).toEqual({ apiKeyEnv: 'LIGHT_API_KEY', baseURL: 'http://gateway.test/v1' })
  })

  it('keeps explicit route declarations', () => {
    const config = parse({
      routes: [
        { route: 'gateway-session', source: 'gateway', displayName: 'Gateway Session' },
      ],
    }) as { routes?: Array<{ route?: string; source?: string; displayName?: string }> }
    expect(config.routes).toEqual([
      { route: 'gateway-session', source: 'gateway', displayName: 'Gateway Session' },
    ])
  })

  it('carries no gateway, credential, model, suffix, or reasoning config — all inherited from the source llm-pi-ai provider', () => {
    const config = parse({}) as Record<string, unknown>
    expect(config).not.toHaveProperty('baseURL')
    expect(config).not.toHaveProperty('provider')
    expect(config).not.toHaveProperty('apiKeyEnv')
    expect(config).not.toHaveProperty('models')
    expect(config).not.toHaveProperty('suffix')
    expect(config).not.toHaveProperty('reasoning')
    expect(config).not.toHaveProperty('reasoningEfforts')
  })

  it('drops suffix/reasoning/reasoningEfforts even when a caller passes them', () => {
    const config = parse({
      suffix: '-mirror',
      reasoning: 'high',
      reasoningEfforts: ['off', 'high'],
    }) as Record<string, unknown>
    expect(config).not.toHaveProperty('suffix')
    expect(config).not.toHaveProperty('reasoning')
    expect(config).not.toHaveProperty('reasoningEfforts')
  })
})
