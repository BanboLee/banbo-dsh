/**
 * Settings policy contract — docs/agents-plugin-plan.md §7.
 *
 * The official settings service owns persistence and last-good semantics. This
 * suite only locks the bundle-owned layer: schema shape, startup-catalog owner
 * validation, and effective enabled/model policy. No network or real provider.
 */

import { describe, expect, it } from 'vitest'

import {
  SETTINGS_NAMESPACE,
  SettingsPolicyError,
  createSettingsView,
  effectiveAgentPolicy,
  validateAgentSettings,
} from '../settings-policy.js'

type Definition = {
  id: string
  main?: { presetId: string }
  child?: { model: Record<string, unknown> }
}

const definitions = new Map<string, Definition>([
  ['builtin-both', {
    id: 'builtin-both',
    main: { presetId: 'builtin-both' },
    child: { model: { default: true } },
  }],
  ['builtin-main', { id: 'builtin-main', main: { presetId: 'builtin-main' } }],
  ['user-child', {
    id: 'user-child',
    child: { model: { provider: 'default-provider', model: 'default-model' } },
  }],
])

const catalog = {
  definitions,
  builtinIds: new Set(['builtin-both', 'builtin-main']),
  abi: {
    agents: [
      { id: 'builtin-both' },
      { id: 'builtin-main' },
      { id: 'user-child' },
      { id: 'retired-user', retired: true },
    ],
  },
}

const defaults = { includeDefaults: true, agents: {} }

describe('settings namespace', () => {
  it('uses the stable namespace required by the plan', () => {
    expect(SETTINGS_NAMESPACE).toBe('banbo-agents')
  })
})

describe('validateAgentSettings — owner validation', () => {
  it('accepts the empty resolved settings value', () => {
    expect(() => validateAgentSettings(defaults, catalog)).not.toThrow()
  })

  it('accepts a full concrete child route and the default sentinel', () => {
    expect(() => validateAgentSettings({
      includeDefaults: true,
      agents: {
        'builtin-both': { model: { default: true } },
        'user-child': { model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
      },
    }, catalog)).not.toThrow()
  })

  it('rejects a model override for a main-only definition', () => {
    expect(() => validateAgentSettings({
      includeDefaults: true,
      agents: { 'builtin-main': { model: { default: true } } },
    }, catalog)).toThrow(/main-only|child form/i)
  })

  it('rejects incomplete, empty, or mixed child routes', () => {
    for (const model of [
      { provider: 'p' },
      { provider: '', model: 'm' },
      { default: true, provider: 'p', model: 'm' },
      { provider: 'p', model: 'm', reasoningEffort: '' },
    ]) {
      expect(() => validateAgentSettings({
        includeDefaults: true,
        agents: { 'user-child': { model } },
      }, catalog), JSON.stringify(model)).toThrow(/model|provider|reasoning/i)
    }
  })

  it('rejects an arbitrary unknown id', () => {
    const error = (() => {
      try {
        validateAgentSettings({ includeDefaults: true, agents: { ghost: { enabled: true } } }, catalog)
        return undefined
      } catch (thrown) {
        return thrown as SettingsPolicyError
      }
    })()
    expect(error).toBeInstanceOf(SettingsPolicyError)
    expect(error?.code).toBe('unknown-agent')
    expect(error?.agentId).toBe('ghost')
  })

  it('allows a historical retired id so deleting YAML cannot brick Host startup', () => {
    expect(() => validateAgentSettings({
      includeDefaults: true,
      agents: {
        'retired-user': {
          enabled: true,
          model: { provider: 'stale', model: 'stale' },
        },
      },
    }, catalog)).not.toThrow()
  })
})

describe('effectiveAgentPolicy — current action policy', () => {
  it('enables built-ins and user definitions by default', () => {
    expect(effectiveAgentPolicy(defaults, catalog, 'builtin-both').effectiveEnabled).toBe(true)
    expect(effectiveAgentPolicy(defaults, catalog, 'user-child').effectiveEnabled).toBe(true)
  })

  it('includeDefaults false disables built-ins but not user definitions', () => {
    const settings = { includeDefaults: false, agents: {} }
    expect(effectiveAgentPolicy(settings, catalog, 'builtin-both').effectiveEnabled).toBe(false)
    expect(effectiveAgentPolicy(settings, catalog, 'user-child').effectiveEnabled).toBe(true)
  })

  it('an explicit enabled override wins over includeDefaults', () => {
    const settings = {
      includeDefaults: false,
      agents: {
        'builtin-both': { enabled: true },
        'user-child': { enabled: false },
      },
    }
    expect(effectiveAgentPolicy(settings, catalog, 'builtin-both').effectiveEnabled).toBe(true)
    expect(effectiveAgentPolicy(settings, catalog, 'user-child').effectiveEnabled).toBe(false)
  })

  it('uses the definition child route until settings provides a concrete override', () => {
    expect(effectiveAgentPolicy(defaults, catalog, 'user-child').model).toEqual({
      provider: 'default-provider', model: 'default-model',
    })
    expect(effectiveAgentPolicy({
      includeDefaults: true,
      agents: { 'user-child': { model: { provider: 'override', model: 'fast' } } },
    }, catalog, 'user-child').model).toEqual({ provider: 'override', model: 'fast' })
  })

  it('default true restores the definition route instead of becoming a route itself', () => {
    expect(effectiveAgentPolicy({
      includeDefaults: true,
      agents: { 'user-child': { model: { default: true } } },
    }, catalog, 'user-child').model).toEqual({ provider: 'default-provider', model: 'default-model' })
  })

  it('forces a retired or missing definition disabled and drops stale model settings', () => {
    const settings = {
      includeDefaults: true,
      agents: {
        'retired-user': { enabled: true, model: { provider: 'stale', model: 'stale' } },
      },
    }
    expect(effectiveAgentPolicy(settings, catalog, 'retired-user')).toMatchObject({
      exists: false,
      retired: true,
      effectiveEnabled: false,
      model: undefined,
    })
  })
})

describe('SettingsView — thin live scope wrapper', () => {
  it('reads the scope on every call instead of caching a second settings state', () => {
    let value = defaults
    const view = createSettingsView({ get: () => value }, catalog)
    expect(view.policy('builtin-both').effectiveEnabled).toBe(true)
    value = { includeDefaults: false, agents: {} }
    expect(view.policy('builtin-both').effectiveEnabled).toBe(false)
    expect(view.get()).toBe(value)
  })
})
