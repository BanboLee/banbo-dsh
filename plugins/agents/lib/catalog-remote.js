/** Read-only startup catalog exposed to the Web settings card (§12.2). */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
/**
 * Remote-only service projecting the startup-static catalog.
 * @typert service banboAgentsCatalog
 */
let BanboAgentsCatalog = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _list_decorators;
    return class BanboAgentsCatalog extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _list_decorators = [Remote('list')];
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['banboAgents'];
        constructor(ctx) {
            super(ctx, 'banboAgentsCatalog');
            __runInitializers(this, _instanceExtraInitializers);
        }
        async list() {
            const state = this.ctx.banboAgents;
            const rows = new Map();
            for (const definition of state.definitions.values()) {
                const forms = [];
                if (definition.main !== undefined)
                    forms.push('main');
                if (definition.child !== undefined)
                    forms.push('child');
                const model = definition.child === undefined ? undefined : concreteModel(definition.child.model);
                const capabilities = new Set([
                    ...(definition.main?.tools ?? []),
                    ...(definition.child?.tools ?? []),
                ]);
                rows.set(definition.id, {
                    id: definition.id,
                    displayName: definition.displayName,
                    description: definition.description,
                    forms,
                    source: state.builtinIds.has(definition.id) ? 'built-in' : 'user-file',
                    defaultEnabled: true,
                    modelEditable: definition.child !== undefined,
                    ...(model === undefined ? {} : { defaultModel: model }),
                    allowedChildren: [...definition.allowedChildren],
                    toolCapabilities: [...capabilities],
                    ...(definition.main === undefined ? {} : {
                        mainBudgetSummary: numericBudget(definition.main),
                    }),
                });
            }
            for (const record of state.abi.agents) {
                if (rows.has(record.id) || record.retired !== true)
                    continue;
                const forms = [];
                if (record.hasMain === true)
                    forms.push('main');
                if (record.hasChild === true)
                    forms.push('child');
                rows.set(record.id, {
                    id: record.id,
                    displayName: record.displayName ?? record.id,
                    description: record.description ?? '',
                    forms,
                    source: 'retired',
                    ...(record.retiredReason === undefined ? {} : { retiredReason: record.retiredReason }),
                    defaultEnabled: false,
                    modelEditable: false,
                    allowedChildren: [],
                    toolCapabilities: [...(record.toolCapabilities ?? [])],
                });
            }
            return {
                agents: [...rows.values()].sort((left, right) => left.id.localeCompare(right.id)),
                generation: state.generation,
            };
        }
    };
})();
export { BanboAgentsCatalog };
/** Keep only the supported concrete child-model shape; default stays absent. */
function concreteModel(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const model = value;
    if (model.default === true)
        return undefined;
    if (typeof model.provider !== 'string' || typeof model.model !== 'string')
        return undefined;
    return {
        provider: model.provider,
        model: model.model,
        ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
    };
}
/**
 * Project the main agent's numeric budget without leaking unrelated config.
 *
 * The delegation budgets live in the nested `main.budget` object, so scanning
 * `main` shallowly reported only `maxDepth`: the card's "main-agent budget" row
 * displayed a depth cap while hiding every concurrency and deadline value the
 * user needs in order to reason about the guard (§12.1).
 */
function numericBudget(main) {
    const result = {};
    const collect = (source) => {
        if (typeof source !== 'object' || source === null || Array.isArray(source))
            return;
        for (const [key, value] of Object.entries(source)) {
            if (typeof value === 'number' && Number.isFinite(value))
                result[key] = value;
        }
    };
    collect(main);
    collect(main.budget);
    return Object.freeze(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))));
}
export default BanboAgentsCatalog;
//# sourceMappingURL=catalog-remote.js.map