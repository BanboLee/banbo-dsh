import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'

import TYPERT_REMOTE from '@banbolee/dsh-agents/remote'

import { AgentSettingsCard, dictionaries, LOCALE_NAMESPACE, type AgentsSettingsCardFace } from './AgentSettingsCard.js'
import { AgentsSettingsController, decodeAgentSettings, type AgentSettingsScope } from './controller.js'
import type { AgentCatalogView } from '@banbolee/dsh-agents/catalog-remote'
import { installClientStyle } from './styles.js'

export { AgentSettingsCard } from './AgentSettingsCard.js'
export { AgentsSettingsController, decodeAgentSettings } from './controller.js'
export type * from './controller.js'

// `remote` only — deliberately NOT `remote.banboAgentsCatalog`. Cordis resolves
// `ctx.remote.<ns>` as its own nested service key, but that key is created BY
// THIS PLUGIN's `$mount` call below, so injecting it would make `apply` wait for
// a service `apply` itself mounts: a deadlock. Resolve the namespace explicitly
// with `ctx.get(...)` instead — the same way the Gateway resolves namespaces
// (`dsh-api-gateway/lib/client.js` uses `this.ctx.get(serviceKey)`), because
// `reflect.get` reads the root service store and needs no inject.
//
// `configForms` replaces 0.1.5's `settingsScope` service: the Plugins page and
// every configuration card share one describe mirror, and a card reads its Host
// entry through `ctx.configForms.get(entryId)`.
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** Cordis service key the Gateway publishes one Remote namespace under. */
const CATALOG_NAMESPACE_KEY = 'remote.banboAgentsCatalog'

/** The Host Loader row whose Config this card edits (settings-policy.js). */
const SETTINGS_NAMESPACE = 'banbo-agents'

/** This bundle's package name: the key `plugins.bundle.config` is addressed by. */
const PACKAGE_ID = '@banbolee/dsh-agents'

type Disposer = () => void | Promise<void>

/**
 * Narrow one shared form to the Host-owned section contract.
 *
 * The form carries whatever the profile patch holds and validates it against
 * the row's serialized schema only; `decodeAgentSettings` is the stricter,
 * catalog-independent shape this bundle's Host half accepts. A section that
 * fails it is treated as not-yet-accepted (no value held) rather than rendered
 * from half-decoded data.
 */
function hostSectionForm(form: ConfigForm<unknown>): AgentSettingsScope {
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      if (snapshot.value === undefined) return { ...snapshot, value: undefined }
      const value = decodeAgentSettings(snapshot.value)
      return value === undefined
        ? { ...snapshot, status: 'loading' as const, value: undefined }
        : { ...snapshot, value }
    },
    subscribe: (listener) => form.subscribe(listener),
    mutate: (ops, expectedRevision) => form.mutate(ops, expectedRevision),
  }
}

function controllerFace(controller: AgentsSettingsController): AgentsSettingsCardFace {
  return {
    hooks: { agentsSettings: controller },
    stageIncludeDefaults: (value) => controller.stageIncludeDefaults(value),
    stageEnabled: (agentId, value) => controller.stageEnabled(agentId, value),
    stageModel: (agentId, value) => controller.stageModel(agentId, value),
    save: () => { void controller.save() },
    discard: () => controller.discard(),
  }
}

async function disposeAll(disposers: Disposer[]): Promise<void> {
  let firstFailure: unknown
  for (const dispose of disposers.reverse()) {
    try {
      await dispose()
    } catch (error) {
      firstFailure ??= error
    }
  }
  if (firstFailure !== undefined) throw firstFailure
}

/** Mount the generated Remote and contribute one Plugin Configuration card. */
export async function apply(ctx: ClientContext): Promise<void> {
  const rollback: Disposer[] = []
  try {
    // The plugin owns its own style tag, so a replacement removes it instead of
    // stacking another copy of the stylesheet. Pushed first, therefore disposed
    // last: the card's slot goes away before the styles that paint it.
    rollback.push(installClientStyle())

    const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
    rollback.push(unmount)

    const catalog = ctx.get(CATALOG_NAMESPACE_KEY) as {
      list: () => Promise<
        | { ok: true, value: AgentCatalogView }
        | { ok: false, error: { message: string, code: string } }
      >
    } | undefined
    if (catalog === undefined) {
      throw new Error(
        `banbo-agents: the Gateway did not publish ${CATALOG_NAMESPACE_KEY} after mounting this plugin's Remote; `
        + 'the settings card needs the Host catalog to render',
      )
    }

    const response = await catalog.list()
    if (!response.ok) {
      throw new Error(`banbo-agents: catalog list failed: ${response.error?.message} (${response.error?.code})`)
    }

    // The Host row's Config IS the settings form in 0.1.7 (`SettingsForms` has
    // no `register()`); `get` keys it by the profile entry id, which is this
    // plugin's own row id and the namespace its Host half validates.
    const form = ctx.configForms.get<unknown>(SETTINGS_NAMESPACE)
    const controller = new AgentsSettingsController(hostSectionForm(form), response.value)
    rollback.push(() => controller.dispose())

    const removeLocale = ctx.locale.register(LOCALE_NAMESPACE, dictionaries)
    rollback.push(removeLocale)

    // `plugins.bundle.config` is the Plugins page's OWN seat for one bundle's
    // configuration: a KEYED slot addressed by the bundle's package name, whose
    // contribution the page renders as `view: 'page'` on that bundle's page.
    // The 0.1.5 `settings.plugin.item` seat is gone in 0.1.7, and using it here
    // would leave the card registered against a slot nothing declares.
    const removeSlot = ctx.slots.inject('plugins.bundle.config', function* () {
      yield ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_ID,
        locale: LOCALE_NAMESPACE,
        inject: () => controllerFace(controller),
      }, AgentSettingsCard)
    })
    rollback.push(removeSlot)

    ctx.effect(() => () => disposeAll(rollback), 'banbo-agents.client')
  } catch (error) {
    await disposeAll(rollback)
    throw error
  }
}
