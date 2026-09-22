/** Read-only startup catalog exposed to the Web settings card (§12.2). */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
export interface AgentModelView {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
export interface AgentCatalogRow {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly forms: readonly ('main' | 'child')[];
    readonly source: 'built-in' | 'user-file' | 'retired';
    readonly retiredReason?: string;
    readonly defaultEnabled: boolean;
    readonly modelEditable: boolean;
    readonly defaultModel?: AgentModelView;
    readonly allowedChildren: readonly string[];
    readonly toolCapabilities: readonly string[];
    readonly mainBudgetSummary?: Readonly<Record<string, number>>;
}
export interface AgentCatalogView {
    readonly agents: readonly AgentCatalogRow[];
    readonly generation: string;
}
interface AgentDefinition {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly allowedChildren: readonly string[];
    readonly main?: {
        readonly tools: readonly string[];
        readonly maxDepth: number;
        readonly [key: string]: unknown;
    };
    readonly child?: {
        readonly tools: readonly string[];
        readonly model: unknown;
    };
}
interface AbiRecord {
    readonly id: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly hasMain?: boolean;
    readonly hasChild?: boolean;
    readonly retired?: boolean;
    readonly retiredReason?: string;
    readonly toolCapabilities?: readonly string[];
}
interface BanboAgentsState {
    readonly generation: string;
    readonly definitions: ReadonlyMap<string, AgentDefinition>;
    readonly builtinIds: ReadonlySet<string>;
    readonly abi: {
        readonly agents: readonly AbiRecord[];
    };
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        readonly banboAgents: BanboAgentsState;
    }
}
/**
 * Remote-only service projecting the startup-static catalog.
 * @typert service banboAgentsCatalog
 */
export declare class BanboAgentsCatalog extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    list(): Promise<AgentCatalogView>;
}
export default BanboAgentsCatalog;
//# sourceMappingURL=catalog-remote.d.ts.map