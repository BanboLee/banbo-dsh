/**
 * Official-settings integration policy — docs/agents-plugin-plan.md §7.
 *
 * Persistence, revisions and last-good behavior stay in `dsh-settings`. This
 * module owns only the namespace schema, catalog-aware validation and the live
 * effective policy read by MainRuntime/DelegationRuntime.
 */

import z from '@deepseek-ai/schemastery'

/** Stable official settings namespace. */
export const SETTINGS_NAMESPACE = 'banbo-agents'

/** Composition base registered with the official settings provider. */
export const SETTINGS_BASE = Object.freeze({ includeDefaults: true, agents: Object.freeze({}) })

/**
 * Deliberately loose model shape: schemastery checks JSON/object boundaries;
 * {@link validateAgentSettings} checks the catalog-dependent union.
 */
export const AgentSettingsSchema = z.object({
  includeDefaults: z.boolean().default(true),
  agents: z.dict(z.object({
    enabled: z.boolean(),
    model: z.any(),
  })).default({}),
})

/** Catalog-aware settings failure. */
export class SettingsPolicyError extends Error {
  /** @type {string} */
  code
  /** @type {string | undefined} */
  agentId
  /** @type {string | undefined} */
  field

  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'SettingsPolicyError'
    this.code = code
    Object.assign(this, detail)
  }
}

const fail = (code, message, detail) => {
  throw new SettingsPolicyError(code, message, detail)
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Find a durable ABI record, including an irreversible retired shell. */
function abiRecord(catalog, agentId) {
  return catalog.abi?.agents?.find((record) => record?.id === agentId)
}

/** Validate the child-route union shared by definitions and settings. */
function validateModel(model, agentId) {
  if (!isRecord(model)) {
    fail('bad-model', `agent "${agentId}" model must be an object`, { agentId, field: `agents.${agentId}.model` })
  }
  if (model.default === true) {
    if (model.provider !== undefined || model.model !== undefined || model.reasoningEffort !== undefined) {
      fail('bad-model', `agent "${agentId}" model cannot mix default: true with provider, model, or reasoningEffort`, {
        agentId,
        field: `agents.${agentId}.model`,
      })
    }
    return
  }
  if (model.default !== undefined) {
    fail('bad-model', `agent "${agentId}" model.default must be exactly true when present`, {
      agentId,
      field: `agents.${agentId}.model.default`,
    })
  }
  if (typeof model.provider !== 'string' || model.provider === '') {
    fail('bad-model', `agent "${agentId}" model must give a non-empty provider alongside model`, {
      agentId,
      field: `agents.${agentId}.model.provider`,
    })
  }
  if (typeof model.model !== 'string' || model.model === '') {
    fail('bad-model', `agent "${agentId}" model must give a non-empty model alongside provider`, {
      agentId,
      field: `agents.${agentId}.model.model`,
    })
  }
  if (model.reasoningEffort !== undefined && (typeof model.reasoningEffort !== 'string' || model.reasoningEffort === '')) {
    fail('bad-model', `agent "${agentId}" model.reasoningEffort must be a non-empty string`, {
      agentId,
      field: `agents.${agentId}.model.reasoningEffort`,
    })
  }
}

/**
 * Owner validation bound to one startup catalog.
 *
 * Historical ABI ids are accepted so deleting user YAML cannot make a stale
 * settings section brick the next Host startup. Their values are ignored by
 * {@link effectiveAgentPolicy}; arbitrary never-published ids still fail loud.
 */
export function validateAgentSettings(value, catalog) {
  if (!isRecord(value)) fail('bad-settings', 'banbo-agents settings must be an object')
  if (typeof value.includeDefaults !== 'boolean') {
    fail('bad-settings', 'includeDefaults must be a boolean', { field: 'includeDefaults' })
  }
  if (!isRecord(value.agents)) fail('bad-settings', 'agents must be an object', { field: 'agents' })

  for (const [agentId, override] of Object.entries(value.agents)) {
    if (!isRecord(override)) {
      fail('bad-agent-settings', `settings for agent "${agentId}" must be an object`, { agentId, field: `agents.${agentId}` })
    }
    const definition = catalog.definitions.get(agentId)
    const published = abiRecord(catalog, agentId)
    if (definition === undefined) {
      if (published !== undefined) continue
      fail('unknown-agent', `settings name unknown agent "${agentId}"; add its YAML definition and restart first`, {
        agentId,
        field: `agents.${agentId}`,
      })
    }
    if (override.enabled !== undefined && typeof override.enabled !== 'boolean') {
      fail('bad-enabled', `agent "${agentId}" enabled must be a boolean`, { agentId, field: `agents.${agentId}.enabled` })
    }
    if (override.model === undefined) continue
    if (definition.child === undefined) {
      fail('model-on-main-only', `agent "${agentId}" is main-only and has no child form; its main model uses the official Session model selector`, {
        agentId,
        field: `agents.${agentId}.model`,
      })
    }
    validateModel(override.model, agentId)
  }
}

/**
 * Resolve the policy for one subsequent action under the current settings.
 * Structural catalog data is startup-fixed; enabled/model settings are read for
 * every call. Generation is intentionally absent from authorization.
 */
export function effectiveAgentPolicy(settings, catalog, agentId) {
  const definition = catalog.definitions.get(agentId)
  const published = abiRecord(catalog, agentId)
  const retired = published?.retired === true || (published !== undefined && definition === undefined)
  if (definition === undefined) {
    return Object.freeze({
      agentId,
      definition: undefined,
      exists: false,
      retired,
      effectiveEnabled: false,
      model: undefined,
    })
  }

  const override = settings.agents?.[agentId]
  const builtin = catalog.builtinIds?.has(agentId) === true
  const defaultEnabled = builtin ? (settings.includeDefaults ?? true) : true
  const effectiveEnabled = override?.enabled ?? defaultEnabled
  const configuredModel = override?.model
  const model = definition.child === undefined
    ? undefined
    : configuredModel === undefined || configuredModel.default === true
      ? definition.child.model
      : configuredModel

  return Object.freeze({
    agentId,
    definition,
    exists: true,
    retired: false,
    effectiveEnabled,
    model: model === undefined ? undefined : structuredClone(model),
  })
}

/**
 * Thin read-only wrapper over the official SettingsScope. It intentionally owns
 * no cache: external file reloads and revision writes affect the next action.
 */
export function createSettingsView(scope, catalog) {
  return Object.freeze({
    get: () => scope.get(),
    policy: (agentId) => effectiveAgentPolicy(scope.get(), catalog, agentId),
  })
}
