import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { AgentModelView } from '@banbolee/dsh-agents/catalog-remote';
import type { AgentsSettingsController } from './controller.js';
export declare const LOCALE_NAMESPACE = "banbo.agents";
export type AgentsLocaleKey = 'title' | 'description' | 'includeDefaults' | 'includeDefaultsHint' | 'enabled' | 'model' | 'provider' | 'modelId' | 'reasoningEffort' | 'inheritModel' | 'save' | 'discard' | 'saving' | 'writeFailed' | 'conflict' | 'retired' | 'retiredMainHint' | 'retiredChildHint' | 'structure' | 'forms' | 'children' | 'tools' | 'budget' | 'empty' | 'effectsHint' | 'restartHint' | 'mainModelHint';
export declare const dictionaries: Record<'zh' | 'en', Record<AgentsLocaleKey, string>>;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'banbo.agents': AgentsLocaleKey;
    }
}
export interface AgentsSettingsCardFace {
    hooks: {
        agentsSettings: Pick<AgentsSettingsController, 'getSnapshot' | 'subscribe'>;
    };
    stageIncludeDefaults(value: boolean): void;
    stageEnabled(agentId: string, value: boolean): void;
    stageModel(agentId: string, value: AgentModelView | undefined): void;
    save(): void;
    discard(): void;
}
export type AgentsSettingsCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<typeof LOCALE_NAMESPACE> & InjectFace<AgentsSettingsCardFace>;
/** Plugin Configuration card for the startup catalog plus official live settings. */
export declare function AgentSettingsCard(props: AgentsSettingsCardProps): import("react").JSX.Element | null;
//# sourceMappingURL=AgentSettingsCard.d.ts.map