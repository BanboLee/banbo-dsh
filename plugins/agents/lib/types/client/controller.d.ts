import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { AgentCatalogRow, AgentCatalogView, AgentModelView } from '@banbolee/dsh-agents/catalog-remote';
export interface AgentSettingsOverride {
    readonly enabled?: boolean;
    readonly model?: AgentModelView | {
        readonly default: true;
    };
}
export interface AgentSettingsSection {
    readonly includeDefaults: boolean;
    readonly agents: Readonly<Record<string, AgentSettingsOverride>>;
}
export type AgentSettingsScope = SettingsScope<AgentSettingsSection>;
export interface AgentSettingsRow extends AgentCatalogRow {
    readonly enabled: boolean;
    readonly enabledEditable: boolean;
    readonly model?: AgentModelView;
}
export interface AgentsSettingsSnapshot {
    readonly available: boolean;
    readonly writable: boolean;
    readonly includeDefaults: boolean;
    readonly rows: readonly AgentSettingsRow[];
    readonly generation: string;
    readonly dirty: boolean;
    readonly saving: boolean;
    readonly failed: boolean;
    readonly conflicted: boolean;
}
/** Narrow the official settings mirror to the Host-owned section contract. */
export declare function decodeAgentSettings(value: unknown): AgentSettingsSection | undefined;
/** Staged, revision-fenced editor joining static catalog rows with live settings. */
export declare class AgentsSettingsController {
    private readonly scope;
    private readonly catalog;
    private readonly listeners;
    private readonly staged;
    private readonly unsubscribe;
    private draftRevision;
    private saving;
    private failed;
    private conflicted;
    private disposed;
    private saveGeneration;
    private snapshot;
    constructor(scope: AgentSettingsScope, catalog: AgentCatalogView);
    getSnapshot: () => AgentsSettingsSnapshot;
    subscribe: (listener: () => void) => (() => void);
    dispose(): void;
    stageIncludeDefaults(value: boolean): void;
    stageEnabled(agentId: string, value: boolean): void;
    stageModel(agentId: string, value: AgentModelView | undefined): void;
    discard(): void;
    save(): Promise<void>;
    private requireRow;
    private stage;
    private clearDraft;
    private effectiveSection;
    private project;
    private publish;
    private landed;
}
//# sourceMappingURL=controller.d.ts.map