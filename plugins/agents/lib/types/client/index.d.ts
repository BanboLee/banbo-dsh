import type { Context as ClientContext } from '@deepseek-ai/cordis';
export { AgentSettingsCard } from './AgentSettingsCard.js';
export { AgentsSettingsController, decodeAgentSettings } from './controller.js';
export type * from './controller.js';
export declare const inject: string[];
/** Mount the generated Remote and contribute one Plugin Configuration card. */
export declare function apply(ctx: ClientContext): Promise<void>;
//# sourceMappingURL=index.d.ts.map