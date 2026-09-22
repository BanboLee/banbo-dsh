import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'

import TYPERT_REMOTE from '@banbolee/dsh-agents/remote'

import { AgentSettingsCard, dictionaries, LOCALE_NAMESPACE, type AgentsSettingsCardFace } from './AgentSettingsCard.js'
import { AgentsSettingsController, decodeAgentSettings } from './controller.js'
import { installClientStyle } from './styles.js'

export { AgentSettingsCard } from './AgentSettingsCard.js'
export { AgentsSettingsController, decodeAgentSettings } from './controller.js'
export type * from './controller.js'

export const inject = ['slots', 'locale', 'remote', 'settingsScope']

type Disposer = () => void | Promise<void>

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

    const response = await ctx.remote.banboAgentsCatalog.list()
    if (!response.ok) {
      throw new Error(`banbo-agents: catalog list failed: ${response.error.message} (${response.error.code})`)
    }

    const scope = ctx.settingsScope.bind({ namespace: 'banbo-agents', decode: decodeAgentSettings })
    const controller = new AgentsSettingsController(scope, response.value)
    rollback.push(() => controller.dispose())

    const removeLocale = ctx.locale.register(LOCALE_NAMESPACE, dictionaries)
    rollback.push(removeLocale)

    const removeSlot = ctx.slots.inject('settings.plugin.item', function* () {
      yield ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'banbo-agents',
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
