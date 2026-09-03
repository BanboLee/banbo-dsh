# dsh-lsp-diagnostics V1 写后自动 LSP 诊断 — 实施计划（修订版）

## TL;DR（面向批准者与执行者）

本计划只在 `banbo-dsh` 新增 Host 平面 bundle 插件 `plugins/dsh-lsp-diagnostics`，实现：Agent 在其 session workspace 内通过 DSH 官方 `write`、`edit`、`str_replace_editor` 的 mutating 命令成功写入 `.ts`、`.tsx`、`.go` 后，工具仍按原结果成功返回，并在下一次模型推理前收到一条持久化的 LSP diagnostics plugin notice。

闭环只使用 `0.1.1-rc.2` 公共 seam：

1. `fs/observed` 同步记录实际落盘的 `FsTarget`、`FsVersion` 与递增 generation；
2. `tools/post-execute` 使用真实三参 `(exec, _result, next)` waterfall listener，先且仅一次 `await next()`，再在一个不可延长的总 deadline 内完成诊断；
3. `additionalContexts` 使用 `createUserMessage` 注入 `source.kind === 'plugin'`、`form === 'notice'` 的消息；
4. Agent loop 在全部 `tool/result` 之后提交这些消息，并在下一次请求前持久化为 `user/message`；
5. PTC 的真实 `run_code` 子调用通过官方 `exec.deferContext` 路径把嵌套写入产生的 context 转发给外层结果。

插件不修改 `deepseek-harness`，不扩展 `ctx.lsp`，不 import `@deepseek-ai/*/src/*`，不 monkey-patch 官方对象。语言服务器进程按 `(providerId, canonicalWorkspace.targetKey)` 复用；workspace、cwd 与 URI 全部通过 `ctx.fs` 公共 API 派生，不能从 `displayPath` 或 host `process.cwd()` 猜测。

**审批门：本修订计划必须先由直接人类明确批准。批准后只允许先提交本计划文件；该计划提交的 SHA 才是 `base-0`。在 `base-0` 存在前，不得创建或修改任何实现代码、测试、manifest、lockfile 或其他文档。**

**未来所有实现子代理、集成/验收修复子代理必须显式使用 `provider: deepseek`、`model: deepseek-v4-flash`；恰好五个最终验收 reviewer（F1-F5）必须使用与主协调者相同的 `gpt-5.6-sol` 模型，不得使用 `deepseek-v4-flash`。**

---

## Scope

### A. V1 承诺

- 支持 Agent session 具有非空 `session.header.cwd`，且目标文件位于该 workspace 内的写入。
- 支持官方工具注册名：
  - `write`；
  - `edit`；
  - `str_replace_editor` 的 `create`、`str_replace`、`insert`；`view` 必须忽略。
- 支持扩展名：
  - `.ts` → provider `typescript`、language id `typescript`；
  - `.tsx` → provider `typescript`、language id `typescriptreact`；
  - `.go` → provider `go`、language id `go`。
- extension route 是封闭集合且固定语义：只能出现且必须恰好出现一次 `.ts → typescript/typescript`、`.tsx → typescript/typescriptreact`、`.go → go/go`；任何其他 extension key、缺项、重复 normalized key 或改写 language id 均在 load 时 fail loud。运行时其他扩展名静默忽略：不启动 server、不产生 clean、不产生 unavailable notice。
- workspace eligibility 只有一种语义：无/空 `session.header.cwd`、cwd 无法 canonicalize 为 directory、或 `ctx.fs.contains(canonicalWorkspace, target) !== true` 都是 **ineligible 并静默忽略**；它们绝不渲染 `workspace unavailable`/`outside workspace`。只有已通过 eligibility 的目标才可能产生 diagnostics、clean 或 plugin-owned unavailable。
- 每次诊断先以 target `stat.size` 预检，再使用公共 `ctx.fs.readBytes(target, signal, maxDocumentBytes)` 做有界读取与严格 UTF-8 解码；`maxDocumentBytes` 是发送给 LSP 的 UTF-8 byte 硬上限，不允许先无界 `readText` 再计数。已知 `size > maxDocumentBytes` 或 unknown-size bounded read 抛出 `FsError` 且 `code === 'FS_TOO_LARGE'` 时封闭映射为 `document too large`；其他 read error 映射为 `diagnostics unavailable`，不得依赖 backend 返回 `bytes.length > maxDocumentBytes` 的不可能分支。发送 `didOpen` 后只接收当前 canonical URI 与本次 document version 匹配的 `publishDiagnostics`，在 quiet window 后发送 `didClose`。
- 只有匹配 URI/版本且通过 V1 consumed-field 严格 schema 的显式空 `diagnostics: []` 才是 clean；未收到、跨 URI、旧版本、协议失败或超时均不是 clean。
- `publishDiagnostics` params 严格验证 URI/version/diagnostics correlation；每个 Diagnostic 只严格验证并消费 `range`、`severity`、`code`、`source`、`message`，Position 是 0-based UTF-16。标准可选字段 `tags`、`relatedInformation`、`codeDescription`、`data` 及 Diagnostic 的未知扩展字段允许出现并安全忽略，不进入 normalized schema/renderer；被消费字段类型非法仍是 fatal protocol failure。输出统一为单行安全文本、1-based start-end 坐标，server 换行/控制字符不得改变 notice 行结构。
- 一个工具执行的所有文件只生成至多一条 aggregate plugin notice。每个目标通过 extension/workspace eligibility 后，coordinator 立即以 renderer 的同一 control sanitizer 把 `displayPath` 计算且冻结为单行 `renderPath`，并取得 `canonicalUri`；诊断调度与 renderer 最终 section 排序使用唯一 `TOTAL_FILE_ORDER = (renderPath, String(targetKey), canonicalUri)`，三列均按 Unicode code-point lexical order 比较。该 comparator 逐 code point 比较数值、首个不同者较小优先、共同前缀后较短者优先；禁止 `localeCompare`、UTF-16 code-unit 默认 sort、raw `displayPath` 或二元 fallback。最终输出顺序是诊断调度顺序过滤掉不渲染/被全局 count cap 清空的文件后的稳定子序列，除此没有第二个 oracle。每文件诊断按规范化后的 `(start.line, start.character, severityRank, source, code, message, end.line, end.character)` 升序。
- `maxDiagnostics` 是该 aggregate 中全部文件合计的硬上限；count cap 后没有保留诊断行的 diagnostics 文件整个 section 省略，绝不留下空 section；clean/unavailable section 不消耗该 count。`maxResultChars` 是先按完整 grammar 构造 canonical aggregate（唯一总标题、所有 section、条件式全局尾注），仅在超限时再以固定 marker 替换被删后缀所受的 Unicode code-point 硬上限；不得先截 section/尾注再决定 marker。
- fail-open 只承诺 **plugin-owned post-processing failure**：在下游 `await next()` 已成功返回 decision 后，诊断 error、server 缺失/崩溃、协议错误、读取错误或超时不得改变原 decision/result，也绝不返回 `kind: 'block'`。`await next()` 必须位于 plugin catch 外；下游异常原样 reject。caller abort 是否终止工具由 ToolRuntime/下游决定，插件不吞掉、改写或承诺把它变成成功。
- 最新性同时使用写后 `FsVersion` 与 target generation。generation 从独立的 per-target monotonic counter 分配且在一个 plugin lifetime 内从不复用；retire active marker 不回退 counter，计数耗尽时 fail-safe 使旧候选全部 stale而不发布。诊断期间发生后续官方 mutation、final stat 未在 deadline gate 关闭前 settled、或 final stat 版本不一致时，静默丢弃该旧结果；deadline gate 关闭后迟到 promise 永远不能恢复发布资格。
- `enabled=false` 在 `apply` 最前返回：零 collector/runtime/coordinator、零 listener/effect、零 subprocess。
- coordinator 同时拥有 active augment operation registry/controller 与 `retiredIo` late-final-stat registry：每个已成功 `await next()` 的整个 augment promise 在任何 workspace I/O 前登记，operation signal 覆盖 `resolve/stat/readBytes/final-stat`，同步 `contains` 前后检查 abort；deadline-first 在返回工具 decision 前把每个尚未 settled 的 final-stat promise 同步转入 `retiredIo`，给其附上 rejection observer/幂等 `finally` 删除，绝不 await 它、绝不允许其迟到发布。每个 operation 的无条件 `finally` 都清除 deadline timer并解除 caller/cleanup signal listener。卸载/HMR 的单一 async cleanup 严格执行 stop admission → `offPost` → `offObserved` → abort coordinator operations → await 全部 active augment promises → await 全部 `retiredIo` → `runtime.dispose()`。listener 已进入但尚未 runtime admission 的 operation 也必须被取消并等待；cleanup resolve 后不得继续 workspace I/O、runtime admission或发布，且不得残留 operation timer/signal listener。
- 每个 session 的 teardown 唯一顺序为 `shutdown` request → `exit` notification/自然关闭等待 → 仅仍存活时 `handle.terminate()` → await `handle.done` + `waitForExit()` → `processLifetimeController.abort()`；`terminate()` 是唯一 hard-stop，任何 deadline/caller/dispose abort 都只能触发并复用该事务，lifetime controller 只在进程树退出后 abort。

### B. V1 明确不做

- 不覆盖 shell 重定向、`sed -i`、脚本、formatter、生成器、外部编辑器等绕过 `ctx.fs`/`fs/observed` 的写入。
- 不诊断 agentless tool execution、无/空 session cwd、cwd 无法 canonicalize 为 directory、workspace 外目标；这些均在 eligibility 阶段静默忽略且不会产生 unavailable notice，属于“Agent 在其 workspace 内写入”的 V1 边界。
- 不做 filesystem watcher，不做跨 workspace 自动项目根探测，不从 `tsconfig.json`/`go.mod` 向上扫描；session cwd 是 V1 明确的 workspace root。
- 不安装或下载真实 `typescript-language-server`/`gopls`。缺失时 fail-open；测试只使用仓库 fixture。
- 不增加官方 `ctx.lsp` 的第五种 operation，不注册官方 LSP provider，不读取官方 LSP 私有状态。
- 不修改/fork `deepseek-harness`，不 import 其 `src/*` 私有路径，不复制私有实现文件；只依据公共包与公共服务。
- 不适配 `0.1.2-*`。实现与测试 dependency 固定为 `0.1.1-rc.2`；peer range 必须在 `0.1.2-0` 前截止。

### C. 严格变更范围

实现阶段只允许以下 tracked 路径：

#### 新插件包

- `plugins/dsh-lsp-diagnostics/package.json`
- `plugins/dsh-lsp-diagnostics/cordis.patch.yml`
- `plugins/dsh-lsp-diagnostics/tsconfig.json`
- `plugins/dsh-lsp-diagnostics/index.js`
- `plugins/dsh-lsp-diagnostics/collector.js`
- `plugins/dsh-lsp-diagnostics/framing.js`
- `plugins/dsh-lsp-diagnostics/runtime.js`
- `plugins/dsh-lsp-diagnostics/render.js`
- `plugins/dsh-lsp-diagnostics/coordinator.js`
- `plugins/dsh-lsp-diagnostics/README.md`
- `plugins/dsh-lsp-diagnostics/tests/helpers.ts`
- `plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts`
- `plugins/dsh-lsp-diagnostics/tests/fixture.spec.ts`
- `plugins/dsh-lsp-diagnostics/tests/collector.spec.ts`
- `plugins/dsh-lsp-diagnostics/tests/framing.spec.ts`
- `plugins/dsh-lsp-diagnostics/tests/runtime.spec.ts`
- `plugins/dsh-lsp-diagnostics/tests/render.spec.ts`
- `plugins/dsh-lsp-diagnostics/tests/coordinator.spec.ts`

#### 仓库级 fixture、组合测试与安装表面

- `tests/fixtures/fake-lsp-server.mjs`
- `tests/package-shape.spec.ts`
- `tests/docs-shape-lsp-diagnostics.spec.ts`
- `tests/composition/lsp-diagnostics-profile.ts`
- `tests/composition/lsp-diagnostics.spec.ts`
- `scripts/sync-lsp-diagnostics-to-profile.sh`
- `README.md`
- `pnpm-lock.yaml`
- 本计划：`docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`；Todo 0 提交完整批准版，此后每个 Todo 只允许把自己的顶层复选框从 `[ ]` 改为 `[x]`，不得改写其他计划内容。该勾选必须与对应 Todo 的实现/验证变更放在同一个提交中。

禁止修改：

- `/data00/home/lixingxin/project/deepseek-harness/**`；
- `plugins/rtk/**`、`plugins/codegraph-mcp/**`、`plugins/fish-shell/**`、`plugins/dsh-llm-pi-ai-with-session/**`；
- `package.json`、`pnpm-workspace.yaml`、`vitest.config.ts`；
- `tests/verify-plan-hygiene.mjs`、`tests/verify-task-evidence.mjs`、现有 composition/e2e helpers；
- 上述清单以外的代码、测试、manifest、lockfile 或文档。

`.omo/evidence/dsh-lsp-diagnostics-v1/**` 是实现协调者与实现/修复代理的 git-ignored 执行证据，不属于 tracked 交付。验收 reviewer 不得创建、修改或删除其中任何文件。交付 scope 同时要求：coordinator 在每次 subagent 启动前写可审计 routing manifest；Todo6 早期 owner 缺陷只能走固定回修集合；Final Reject 的 tracked 缺陷走 fixer，纯 coordinator-owned log/evidence/response格式或采集问题走 zero-commit coordinator-only repair；任一 repair 后原五 reviewer 全量重审。

### D. 已核实的公共 seam

- `FsTarget.displayPath` 仅供 UI/model 显示，可能是相对路径或远程 URI；稳定身份是 `targetKey`（`packages/fs/fs/src/types.ts:57-67`）。
- workspace canonicalization 的官方模式是 `ctx.fs.resolve → stat(directory) → processPath/fileUrl`（`packages/lsp/lsp-stdio/src/host.ts:32-58`）。
- `ctx.fs.processPath(target)` 提供 subprocess execution-world path；`ctx.fs.fileUrl(target)` 提供 LSP URI。不得使用 Node `pathToFileURL(displayPath)`。
- 官方 mutation tool 用 `exec.agent.session.header.cwd` 解析相对路径（`packages/fs/tool-fs/src/session-cwd.ts:22-44`），写成功后同步 emit `fs/observed`。
- `tools/post-execute` 是真实三参 waterfall：listener 接口签名精确为 `(exec, _result, next)`，必须先且仅一次 `await next()`；`_result` 是已 dispatch 的原始 result，本插件不消费但不得省略该形参。
- `FileSystem.resolve/stat/readBytes` 接受 operation signal，`contains` 是同步无 signal seam；coordinator 必须在 `contains` 前后检查同一 signal。`readBytes(..., maxBytes)` 的公共保证是返回完整且 `length <= maxBytes`，已知或读取中发现超限均抛 `FsError` 且 `code === 'FS_TOO_LARGE'`，故不得以返回 oversized bytes 作为产品分支。
- `SubprocessSpawnSpec` 无默认值，必须显式给出 `argv`、`cwd`、`stdio`、`graceMs`，以及可选 `signal`/`env`（`packages/subprocess/subprocess/src/types.ts:69-104`）。
- `SubprocessHandle.terminate()` 是进程树级 TERM→KILL；`waitForExit()` 等待整棵树退出（同文件 `:158-194`）。
- 官方 LSP provider 对 canonical workspace 做队列化、single-flight instance 创建、transport failure eviction 与 awaited teardown（`lsp-stdio/src/index.ts:216-367`）；本插件按这些公共可观察约束自持 diagnostics runtime。
- Loader 会先做 `exports.default ?? exports`（`vendor/loader/src/index.ts:191-198`）；Cordis 从传入 plugin object 读取 `inject`/`Config`（`vendor/cordis/src/registry.ts:316-330`）。因此本插件必须采用 named namespace function-plugin export 且不提供 default export。
- Cordis effect 可以返回 async disposer；官方 LSP provider在 disposer 内 await 全部 provider teardown（`lsp-stdio/src/index.ts:171-184`）。

---

## Interface contracts（实现者不再自行做架构决策）

### 1. 包与版本

`plugins/dsh-lsp-diagnostics/package.json` 必须满足：

```jsonc
{
  "name": "dsh-lsp-diagnostics",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": [
    "index.js", "collector.js", "framing.js", "runtime.js", "render.js",
    "coordinator.js", "cordis.patch.yml", "README.md"
  ],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1 <5.0.0-0",
    "@deepseek-ai/dsh-fs": ">=0.1.1-rc.2 <0.1.2-0",
    "@deepseek-ai/dsh-llm": ">=0.1.1-rc.2 <0.1.2-0",
    "@deepseek-ai/dsh-subprocess": ">=0.1.1-rc.2 <0.1.2-0",
    "@deepseek-ai/dsh-tools": ">=0.1.1-rc.2 <0.1.2-0"
  }
}
```

所有 `@deepseek-ai/dsh-*` devDependencies（包括组合测试使用的 fs-local、subprocess-local、tools、tool-fs、tool-str-replace-editor、code-runtime、code-runtime-worker-thread、llm、session、agent、agent-loop、system-prompt）必须写为精确字符串 `0.1.1-rc.2`；`@deepseek-ai/cordis` devDependency 固定 `4.0.1`。`tests/package-shape.spec.ts` 同时断言 manifest selector 与 `pnpm-lock.yaml` 中这些直接 dependency 的 resolved version；不得以 baseline 已有的其他 transitive prerelease 代替直接依赖断言。

`cordis.patch.yml` 只注册：

```yaml
- insert:
    - id: lsp-diagnostics
      name: dsh-lsp-diagnostics
```

### 2. 配置与验证

`Config['~standard'].validate()` 解析并在插件 load 时验证：

- `enabled` default `true`；
- `timeoutMs` default `5000`：一次 post-execute 中全部受支持文件从 coordinator 开始诊断到最终 freshness stat/aggregate commit 的单一、不可延长 deadline；
- `settleMs` default `200`：quiet window，必须为正整数且 `< timeoutMs`；
- `shutdownTimeoutMs` default `1000`：LSP `shutdown`/`exit` graceful budget；
- `killGraceMs` default `500`：subprocess tree TERM→KILL grace；
- `maxDocumentBytes` default `2097152`；
- `maxMessageBytes` default `4194304`；
- `maxStderrBytes` default `16384`；
- `maxDiagnostics` default `50`；
- `maxResultChars` default `8000`；
- `reportClean` default `true`；
- `servers` default恰为：
  - `typescript: { command:'typescript-language-server', args:['--stdio'], env:{}, configuration:{}, initializationOptions:null, extensionToLanguage:{'.ts':'typescript','.tsx':'typescriptreact'} }`；
  - `go: { command:'gopls', args:[], env:{}, configuration:{}, initializationOptions:null, extensionToLanguage:{'.go':'go'} }`。

validator 对顶层、`servers`、每个 server 与 `extensionToLanguage` 都采用 strict object：unknown key fail loud；`servers` provider key 集合必须恰为 `typescript`、`go`，不得新增/缺少/重命名 provider。`enabled` 必须是 boolean；省略时默认 `true`，显式 `false` 不得被 default 覆盖。所有 timer/cap 必须为 Node timer 可安全表示的正安全整数（`<= 2_147_483_647`），`maxResultChars` 允许从 1 开始；`settleMs < timeoutMs`，`shutdownTimeoutMs` 与 `killGraceMs` 独立且不延长 operation deadline。provider id/command/language id必须非空，args为string array，env为string→string record；`configuration` 与 `initializationOptions` 必须能以无异常、无循环、无 `undefined`/function/symbol/bigint/非有限 number 的标准 JSON value 递归表示。每个 extension 原始 key 必须已是 ASCII 小写且精确属于 `.ts|.tsx|.go`；另以 ASCII 小写 normalized key 做跨 provider 重复检测，最终 route 集合 **恰为** `.ts`、`.tsx`、`.go` 且分别映射固定 provider/language id。任何 unknown/大小写变体 extension、缺项、重复 normalized extension或 route 改写均在 load 时 fail loud。运行时 server 缺失才 fail-open。

`bundle.spec.ts`/config tests 必须表驱动覆盖：`enabled` 缺省/true/false、所有默认值、所有层级 unknown key、unknown/missing/duplicate-normalized extension 与错误映射、有效/无效 JSON（含循环/undefined/function/bigint/NaN/Infinity）、timer `0`/负数/小数/超安全范围/超 Node timer range、`settleMs === timeoutMs` 与 `settleMs > timeoutMs`、合法边界。`enabled=false` 还必须断言 apply 后零 collector/runtime/coordinator、零 listener/effect、零 process。

### 3. 插件 ESM 入口

`index.js` 仅 named-export，不得 `export default`：

```js
export const name = 'lsp-diagnostics'
export const inject = ['fs', 'subprocess', 'tools']
export const Config = { /* 上述 validator */ }
export function apply(ctx, config) { /* 装配 */ }
```

真实 Loader 得到 module namespace，因此保留 `name`、`inject`、`Config`、`apply`。同时单测必须用 `await ctx.plugin(await import('../index.js'), config)` 验证 namespace direct load；禁止只对裸 `apply` 做测试。

`apply` 首先检查 validated `enabled`；为 false 时立即返回，不创建 collector/runtime/coordinator，不调用 `ctx.on`/`ctx.effect`，不 spawn。为 true 时创建 collector、runtime 与 coordinator-owned active augment operation registry/controller及 `retiredIo` late-final-stat registry，显式持有 `offObserved = ctx.on('fs/observed', ...)` 与 `offPost = ctx.on('tools/post-execute', coordinator.listener)` 返回的 disposer，然后只注册 **一个** cleanup effect：

```js
ctx.effect(() => async () => {
  coordinator.stopAdmission() // 同步关闭 coordinator，并同步调用 runtime.stopAdmission()
  const errors = []
  for (const off of [offPost, offObserved]) {
    try { await Promise.resolve(off()) } catch (error) { errors.push(error) }
  }
  try { coordinator.abortActiveOperations() } catch (error) { errors.push(error) }
  try { await coordinator.awaitActiveOperations() } catch (error) { errors.push(error) }
  try { await coordinator.awaitRetiredIo() } catch (error) { errors.push(error) }
  try { await runtime.dispose() } catch (error) { errors.push(error) }
  if (errors.length > 0) throw new AggregateError(errors)
}, 'dsh-lsp-diagnostics listeners, operations, retired I/O, and runtime teardown')
```

不得另注册 listener/operation cleanup effect，不得依赖 Cordis 对多个 disposer 的并发/逆序调度，不得 fire-and-forget。单一 cleanup、`coordinator.stopAdmission()`、`abortActiveOperations()`、`awaitActiveOperations()`、`awaitRetiredIo()` 与 `runtime.dispose()` 都幂等；严格顺序固定为 stop admission → `offPost` → `offObserved` → abort coordinator operations → await all active augment promises → await all `retiredIo` → `runtime.dispose()`，任一步失败也继续后续 quiescence，最后才聚合抛错。

coordinator 是整个 post-execute augment transaction 与 late final-stat I/O 的唯一 owner：在任何 workspace `resolve/stat/contains/readBytes` 或 runtime admission 前创建 operation controller、absolute-deadline timer，并把 caller signal 与 coordinator cleanup signal 的 relay listeners 接到该 controller；随后把 `{ controller, promise, disposeOperationDeadline }` record 放入 `Set<AugmentOperation>`。`disposeOperationDeadline()` 必须幂等地 `clearTimeout` 并移除 caller/cleanup listeners；tracked augment promise 的最外层 `finally` 在所有路径（无候选、non-accept、快速 stats-first、deadline-first、caller/cleanup abort、plugin throw）无条件先调用该 disposer再幂等删除 record。登记与 stop-admission 在同一同步临界区，若 cutoff 已关闭则不登记、不创建 timer/listener、不做 I/O并原样返回 decision。

每个final stat启动时立即包装成`FinalStatRecord { promise, settled }`：从创建同一同步turn起就使用等价于`Promise.resolve().then(() => ctx.fs.stat(target, signal)).then(value => ({status:'fulfilled',value})).catch(reason => ({status:'rejected',reason})).finally(nonThrowingFinalize)`的链；因此stat同步throw与异步rejection都始终有显式`catch`，`nonThrowingFinalize`同步置`settled=true`并从`retiredIo`幂等删除。coordinator提供唯一同步幂等helper`retireUnsettledFinalStats(records)`，对每个`settled === false`的record执行`retiredIo.add(record.promise)`。deadline-first/no-publish临界区在返回decision **之前**调用它；operation最外层`finally`若发现final stats已启动但gate尚未正常stats-first收束，也先abort operation controller、关闭发布资格并再次调用该helper，然后才dispose timer/listener与删除active record。这样plugin-owned异常等非标准终止也不会留下无owner promise。若promise与登记同tick settlement，JS顺序保证要么先见`settled=true`而无需登记，要么先登记而其`finally`随后删除，不会漏管、重复发布或unhandled rejection。该helper从不await，故工具结果仍满足hard deadline；late fulfillment/rejection到达all-stats contender时只能观察closed gate并返回，不能进入commit/render/context分支。`awaitRetiredIo()`与`awaitActiveOperations()`都循环snapshot+`Promise.allSettled`直到对应registry为空。

abort snapshot 与自然 settlement/重复 cleanup race 必须安全：每个 controller至多 abort一次，每个 operation/retired promise至多移除一次，任意次数 disposer/cleanup调用后 timer与caller/cleanup signal listener计数均为零。cleanup resolve 前保证 active augment、late final-stat `retiredIo`、queued runtime work、workspace-resolution/read与 retired process-tree cleanup全部 settled；此后不得继续任何 workspace I/O、runtime admission或 context 发布。测试以卸载发生在 listener 登记边界、resolve、workspace stat、contains 前后、target stat、unknown-size read、runtime admission前、queue/runtime各阶段及 final stat 证明无 race、无迟到执行，并断言 `retiredIo` 清空后最终才调用 `runtime.dispose()`。

### 4. Mutation Collector 与最终发布 generation

collector 维护三个职责分离的结构：

- `WeakMap<ToolExecution, Map<targetKey, Candidate>> pendingByExec`；
- `Map<targetKey, number|'exhausted'> nextGenerationByTarget`：number 值是该 target 下一次要分配的 generation（缺项视为 `1`），只负责单调分配，在一个 plugin lifetime 内绝不回退或复用；
- `Map<targetKey, { generation, version }> latestObserved`：只保存当前 active marker，不充当 counter。

每个匹配的 present mutation observation 都先按 target 独立执行：读取 next counter；number 值必须为正安全整数，分配该值后，若它小于 `Number.MAX_SAFE_INTEGER` 则把 next 写为 `generation + 1`，若恰等于上限则把 next 写为永久 `'exhausted'`；随后以 `{ generation, version }` 替换 active marker，并在当前 exec/target 保存最新 `{ target, version, generation }` Candidate。同 exec/target 被替换的 candidate立即 stale。若后续 observation 读到 `'exhausted'`，必须先删除 active marker并静默抑制新 Candidate，使此前包括 generation 上限在内的所有 Candidate stale，绝不 wrap/reset。`isCurrent(candidate)` 必须同时要求 active marker存在、`generation === candidate.generation` 且 `version === candidate.version`，不能只比 version或只比 generation。`retireIfCurrent(candidate)` 仅在上述双匹配时删除 active marker；无论是否匹配都不得删除/递减 `nextGenerationByTarget`，也不得让任何旧 marker复活。因此 `observe A → observe B → retire B → observe C` 必为 generations `1,2,3`，A/B 都永远不能重新 current；即使 A/B/C 的 `FsVersion` token 值复用也由 generation隔离，跨 exec亦相同。

监听器捕获包括 counter 状态异常在内的内部错误且不 throw。为证明无 ABA，`nextGenerationByTarget` 在 V1 **不做逐 target 清理**：仅 plugin lifetime dispose时整体释放；任何未来优化只有在能证明该 target 的 pending、taken/in-flight、late-final-stat Candidate 全部不存在时才可清理，否则必须 lifetime-retain。这样内存为 `O(plugin lifetime 内不同 targetKey 数)`，不是 `O(observation 数)`；`latestObserved` 则由 current retire及时回收。仅接受 `write`、`edit`、`str_replace_editor(create|str_replace|insert)`；监听器必须捕获内部异常并静默返回，绝不 await/throw。collector 提供 `take(exec)`、`isCurrent(candidate)` 与 `retireIfCurrent(candidate)`；后两者是同步方法。

coordinator 在所有 diagnosis 完成后，并发启动候选的最后一轮 `ctx.fs.stat(target, signal)`；每个调用先包装为上一节的 always-observed `FinalStatRecord`，再以每 exec 唯一的同步 one-shot `commitGate`（初始 `open`）裁决 `Promise.all(records.map(r => r.promise))` contender 与 absolute deadline 的竞争，发布规则只有以下两种且恰有一种能赢：

1. **stats-first**：仅当全部 final stat record 已 settled、注入的 monotonic clock 满足 `now < deadlineAt`、`deadlineSignal.aborted === false` 且 gate 仍 open，当前 microtask 内同步将 gate 置为 `committed`；不得再 `await`。`now === deadlineAt` 一律视为 deadline-first。同一临界区逐项要求 final stat 为 regular file、`version === candidate.version`、`collector.isCurrent(candidate)`（active generation/version双匹配）、runtime outcome 非 stale；通过者可发布原 outcome，stat 自身的 plugin-owned error 仅对仍 current 的 candidate 变成 bounded unavailable，version/generation stale 则静默丢弃。
2. **deadline-first（同 tick 优先）**：deadline handler同步置 `deadlineSignal.aborted` 后将 gate 置为 `timed-out`；stats contender 若观察到 `now >= deadlineAt` 或 signal aborted，必须在自身 microtask立即执行同一 timeout transition，不等待 timer task。即使 final stat promises 已排入 microtask，只要检查时 deadline已到就不得 commit。timeout transition在返回 decision前同步把每个尚未 settled record登记到 coordinator `retiredIo`；caller/cleanup abort在 final stats已启动时走同一“禁止发布并登记未settled records”路径。此后任何迟到 stat resolve/reject都只有 record observer/幂等删除副作用，永远不能访问 gate获胜分支、发布 diagnostics/clean 或改写已返回 decision。deadline临界区只可为当时仍 `collector.isCurrent` 的 eligible candidate生成 `timeout` unavailable；cleanup/caller abort不生成 context；stale candidate始终静默丢弃。

两条 terminal 路径都在同一无 await 的临界区对所有 taken candidate调用 `retireIfCurrent`，最后只返回一次 decision。`retiredIo` 不属于 active augment 的返回依赖，因此 hard deadline不等待它；但它仍属于 coordinator cleanup依赖，卸载必须在 active augment settlement后 `awaitRetiredIo()` 至空。官方后续 mutation会同步更新独立 counter与active marker，因此“前一个文件已诊断、等待其他文件时又被修改”、version token复用以及final stat/deadline/generation同tick竞争都由JS事件顺序和one-shot gate唯一决定。外部绕过 `fs/observed` 的写入不在V1承诺，但final stat仍提供一次best-effort防护。

### 5. Workspace、路由、URI 与池键

coordinator 从 `exec.agent?.session.header.cwd` 取得唯一 workspaceRoot；缺失/空值立即把全部 taken candidate retire 并静默返回。不得使用 `target.displayPath` 的 dirname。对一次 exec 只 canonicalize workspace 一次；resolve/stat 失败、不是 directory 或任一 target 的 `ctx.fs.contains(workspaceTarget, target) !== true` 时，该 target ineligible、静默 retire，既不进入 runtime/renderer，也没有 `workspace unavailable`/`outside workspace` reason。

每次 eligible diagnosis 在总 deadline 内执行：

1. `workspaceTarget = await ctx.fs.resolve(workspaceRoot, { signal })`；
2. `workspaceInfo = await ctx.fs.stat(workspaceTarget, signal)` 且必须是 directory；
3. 在调用前检查 operation signal，`ctx.fs.contains(workspaceTarget, target)` 必须严格为 true，并在同步返回后再次检查 signal；cleanup abort 与 contains 同 tick 由 JS 顺序决定，active promise 始终被等待；
4. runtime pool 使用无拼接、无碰撞的两级结构 `Map<string, Map<FsTargetKey, Session>>`，内层直接使用 opaque `workspaceTarget.targetKey`；serialization tails 使用同形两级 Map，禁止 `${providerId}::${targetKey}` 字符串键；
5. spawn `cwd = ctx.fs.processPath(workspaceTarget)`；
6. initialize `rootUri`/`workspaceFolders[0].uri = ctx.fs.fileUrl(workspaceTarget)`；
7. document URI = `ctx.fs.fileUrl(target)`，并保存为该 open generation 的 exact canonical URI；
8. 读取前 `targetInfo = await ctx.fs.stat(target, signal)`；若非 regular file则按普通 unavailable 处理，若已知 `size > maxDocumentBytes` 则不调用 read、直接 `document too large`；`size === maxDocumentBytes` 必须允许。已知 size 在上限内或 `size === undefined` 时调用 `ctx.fs.readBytes(target, signal, maxDocumentBytes)`：若 operation 已 abort 则走既有 cancellation/timeout，不发布 read reason；否则捕获值只有在 `error instanceof FsError && error.code === 'FS_TOO_LARGE'` 时映射封闭 reason `document too large`，其他 read error 一律映射 `diagnostics unavailable`。公共 seam 保证成功返回完整内容且 `bytes.length <= maxDocumentBytes`，实现与测试不得保留或依赖返回 bytes 超 cap 的不可能规则；成功后直接用 fatal UTF-8 `TextDecoder` 解码。`maxDocumentBytes` 限制的是 didOpen 发送 bytes，也是 backend 内存读取上限；禁止无界 `readText` 或读完字符串后才 `Buffer.byteLength`。

extension 从 `new URL(ctx.fs.fileUrl(target)).pathname` 的最后后缀 ASCII 小写取得；不读取 `displayPath` 做 route。运行时只接受固定 `.ts/.tsx/.go` route；其他 extension 在任何 workspace/runtime/read 前静默 retire。通过 route、cwd canonicalization与 `contains === true` 的 eligibility 后，coordinator 对每个目标恰好一次计算 `canonicalUri = ctx.fs.fileUrl(target)` 与 `renderPath = sanitizeDisplayPath(target.displayPath)`，冻结为 `EligibleTarget { candidate, renderPath, targetKey, canonicalUri, ... }`。`sanitizeDisplayPath` 与 `compareEligibleTargets` 均从 `render.js` 导出供 coordinator/renderer 共用；后者实现唯一 `TOTAL_FILE_ORDER = (renderPath, String(targetKey), canonicalUri)` Unicode code-point comparator。coordinator 先按它排序再串行发起 diagnosis，renderer 必须按同一函数防御性重排；因此最终 section 顺序（忽略 reportClean/count cap 后省略项）与诊断调度顺序完全相同。禁止任何 raw `displayPath` tuple、locale/default sort或不同 fallback。

### 6. JSON-RPC 与 subprocess 完整状态机

runtime provider层拥有两级 `Map<string, Map<FsTargetKey, ...>>` 的唯一 serialization tail 与 instance map；每个 session 只拥有 handle、decoder、monotonic request id、pending request map、serialized write tail、initialize promise、per-URI next document version、active diagnostic waiter、**processLifetimeController** 与 teardown promise。coordinator 独占 active augment registry、`retiredIo` late-final-stat registry、每次 augment controller、absolute-deadline timer及caller/cleanup relay listener disposer；runtime 只拥有自身 admission cutoff并消费传入 signal，不得另建 dispose-operation controller、operation deadline、late-stat registry或把 coordinator operation 从 registry提前移除。三者职责禁止混用：admission只阻止新工作，operation abort取消整个augment的workspace I/O、runtime queue/I/O/waiter并触发eviction，process lifetime signal只传给spawn，operation/admission永不abort它；teardown的唯一hard-stop是graceful phase后的guarded `handle.terminate()`，且只在进程仍存活时调用，随后await `handle.done`与`waitForExit()`，最后才abort controller释放lifetime listeners。禁止再建第二条session queue；operation最外层finally必须释放timer与relay listeners，runtime/session cleanup只释放各自创建的listener。

spawn 前用 `ctx.subprocess.resolveExecutable(command, env, signal)`；spawn 必须恰为：

```js
ctx.subprocess.spawn({
  argv: [resolvedExecutable, ...args],
  cwd: canonicalWorkspacePath,
  stdio: {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: { maxBytes: maxStderrBytes },
  },
  graceMs: killGraceMs,
  signal: processLifetimeController.signal,
  env,
})
```

要求：

- stdout只由`MessageDecoder(maxMessageBytes)`消费；固定协议上限`MAX_HEADER_BYTES=8192`，未找到header terminator前也必须执行该上限；声明body长度不得超过`maxMessageBytes`，总retained undecoded buffer不得超过`MAX_HEADER_BYTES + maxMessageBytes`。半帧可在此界内累积，超界/header/body/JSON非法即fatal transport failure。
- stderr 只保留 bounded tail，不 spill；错误文案自身也受 aggregate char cap。
- 所有 outbound frame 经单一 write tail；write callback reject、stdin error、stdout decode error、process `done` reject/resolve都只触发一次 fatal close。
- request在写前登记numeric id；response必须`jsonrpc:'2.0'`、按numeric id关联，并且`result`/`error`恰有其一；error对象至少含numeric code与string message。违反这些字段约束是fatal protocol failure。完成、abort、transport close时都删除pending entry与abort listener；未知response id忽略。
- server request 必须回复：`workspace/configuration` 返回与 items 等长的 static configuration；`window/workDoneProgress/create`、`client/registerCapability`、`client/unregisterCapability` 返回 `null`；`workspace/applyEdit` 与其他 method 返回 JSON-RPC `-32601`，且客户端绝不执行 server edit/command。
- notification：仅 `textDocument/publishDiagnostics` 进入诊断 waiter；其他 notification 忽略。处理顺序固定为：先验证 params 是 object 且 `uri` 是 string；若 `uri !== activeWaiter.canonicalUri` 则整条静默忽略，**不得再检查其 version/diagnostics**；只有 exact URI 后才执行 version correlation，再按下节 consumed-field Diagnostic schema 校验并投影 diagnostics。当前 URI 的 params/version/diagnostics 或 consumed field 非法是 fatal protocol failure；ignored optional/extension fields 永不单独 fatal。
- initialize single-flight：发送 `initialize`（`processId:null`、canonical root URI/workspaceFolders、initializationOptions；capabilities至少声明UTF-16、workspace folders/configuration、text synchronization及`publishDiagnostics.versionSupport:true`），校验result含object capabilities，成功后必须await写完`initialized`才可`didOpen`。
- provider 层按 canonical workspace key 序列化完整 lifecycle，包含 queue wait、read、initialize、open、quiet wait、close；instance 在 map 中同步发布后才开始/暴露 initialize promise，禁止双 spawn。
- transport failure立即poison并从pool条件式eviction。若尚未接受匹配diagnostics且execution deadline仍有预算，本次diagnosis只允许在fresh instance上自动重试一次；重试仍失败或已接受publication后失败则返回unavailable。下一次diagnosis也必须创建新instance；测试分别证明same-call单次restart与下一次写restart成功。

### 7. Diagnostics schema、correlation、freshness 与 hard deadline

listener 在唯一 `await next()` 成功后先经 coordinator 同步 admission gate创建augment controller、active promise、一次absolute execution deadline及其`disposeOperationDeadline`，并在任何`collector.take`后的workspace I/O前登记；`augmentAcceptedDecision`使用同一个operation signal完成该exec的全部工作，不得按文件重新计时。operation signal通过显式relay组合caller signal、deadline timer与coordinator cleanup abort，覆盖共享file-order排序、workspace `resolve/stat`、同步`contains`前后abort check、bounded read、全部runtime admission/queue、resolveExecutable、initialize、所有protocol writes、quiet wait、didClose、最终freshness stat与aggregate gate；**不得**拿它作为spawn process lifetime signal。deadline一到，coordinator停止启动新diagnosis，按one-shot final commit gate处理尚未完成文件并把迟到final-stat records转交`retiredIo`；cleanup abort则禁止生成/提交新context，active promise仍须经过统一`finally` settlement后才从registry移除。最外层`finally`无条件幂等取消deadline timer、解除caller/cleanup relay listeners；无candidate、non-accept、快速stats-first、deadline-first、caller abort、cleanup abort、plugin error与重复dispose全部走此路径，settlement后operation timer/listener residue必须为零。

`publishDiagnostics` 输入按 consumed fields 验证并投影；不得把 server 任意对象直接交给 renderer：

- 先只验证 params 是 object 且 `uri` 是 string并做 exact URI comparison；跨 URI publication 整条忽略，哪怕其其余字段非法。对 exact URI，params 的允许字段只有 `uri`、`version`、`diagnostics`，unknown field fatal。
- `version` 若存在必须是 `>= 0` 的 safe integer；`diagnostics` 必须为 array。
- 每个 Diagnostic 必须是 object；只读取并严格验证 `range`、`severity`、`code`、`source`、`message`，其中 `range` 与 `message` 必填，其余可选。标准可选字段 `tags`、`relatedInformation`、`codeDescription`、`data` 以及任何当前或未来 unknown extension field 均允许存在并安全忽略：validator 不遍历、不校验、不 stringify、不复制这些值，它们不进入 normalized schema、排序键、renderer或输出；即使其类型不符合当前 LSP 标准也不能单独使 publication fatal。被消费字段缺失或类型/值非法仍使当前 URI publication fatal。
- `range` 作为 consumed field 必须是 strict object且恰有 `start`/`end`；Position strict object恰有 `line`/`character`，两者都是 `0..Number.MAX_SAFE_INTEGER-1` 的整数，采用 LSP **0-based UTF-16 code-unit** 坐标；`end` 按 `(line,character)` 不得早于 `start`。渲染时 line/character 各加 1，安全输出为 **1-based**，不做字节/code-point 换算。
- `severity` 可缺省；存在时只能是整数 `1|2|3|4`，分别规范化为 `error|warning|info|hint`；缺省规范化为 `unknown`，其他值 fatal。
- `code` 可缺省或为 finite safe integer/string；缺省规范化为空字符串，数字以十进制 `String(code)`；`source` 可缺省或 string，缺省为空字符串；`message` 必须是 string。
- 所有被消费的 server string（source/code/message）先把 CRLF、CR、LF、U+2028、U+2029 规范化为空格，再把其余 C0/C1 控制字符（除已处理换行）与 lone surrogate 替换为 U+FFFD；不得让 server 文本注入额外输出行。规范化后只保存不可变内部对象 `{uri, range:{start,end}, severity, severityRank, code, source, message}`，renderer 只接受该 strict normalized schema。

correlation 与 deadline 规则：

- quiet window 只能在 execution deadline 以内等待；连续 notifications 可以重置 quiet timer，但不能移动 absolute deadline。
- 每个 session/URI 的 didOpen version 单调递增，绝不重置为 1。
- waiter 必须在 didOpen write 前 armed，但只有 didOpen write 成功后的 open generation 才可接收 notification。
- 对 exact current canonical URI，带 `version` 的 publish 只接受 `version === currentOpenVersion`；较旧版本忽略，未来版本视为 fatal protocol failure。跨 URI publish 在此规则之前已被忽略，不能因其 version 相同而满足当前 waiter。
- 缺少 `version` 的 publish 只可在“该进程第一次打开该 URI”时接受。接受后标记该 URI/session 为 `retire-after-close`，完成 close 后 eviction 并 teardown；同一进程再次打开该 URI时收到 versionless publish 必须拒绝并 poison。这样旧 open 的无版本延迟通知不能满足新 diagnosis。
- 收到 matching URI/version/schema-valid batch 后只保留该 version 最新完整数组；quiet window 到期时返回它。显式空数组表示 clean。
- didOpen 成功后必须进入 opened-guarded `finally`：operation deadline 尚有预算时 await didClose write；close 失败/超时或 deadline 已过则 poison + eviction，不能把 session 留在 opened 状态。
- deadline/caller abort 会同步取消本 operation waiter/pending entry并把 session 从 pool eviction；diagnose 立即返回 unavailable/aborted，不等待 kill grace。它只启动 tracked teardown，不能直接 abort processLifetimeController 或先 `terminate()`；teardown 仍先走独立 graceful budget，再进入 terminate。后续 query 不复用该进程，plugin dispose 必须 await retired teardown。
- `timeoutMs` 是 plugin post-processing 可见的 hard deadline；caller abort 的工具结果/取消语义由 ToolRuntime 与下游 listener决定，插件仅清理自身 operation，绝不把 `await next()` 的 abort/异常改写成成功。process tree 最终回收由 tracked teardown完成，不阻塞已超时诊断，也不会成为 orphan。

### 8. Bounded teardown

session teardown 是所有起因（transport failure、operation abort、retire-after-close、runtime dispose）共用的幂等 single-flight transaction，process lifetime 与 operation cancellation 严格分离，且只有下列顺序合法：

1. 标记 session closing，禁止新 ordinary request，取消/清理全部本 operation waiter 与 pending request；teardown-owned `shutdown` request 是唯一例外。此时及后续 hard-stop 前均不得 abort `processLifetimeController`，因为 graceful JSON-RPC 与 process 观察仍需活的 transport/lifetime signal。
2. 以独立、不可被已过期 operation signal 污染的 `shutdownTimeoutMs` budget 尝试 request `shutdown`；request settled/失败后，若 transport 仍可写则发送 `exit` notification，再在剩余 graceful budget 内等待自然 close。即使 shutdown/exit 写失败，也只推进同一事务，不另开终止路径。
3. graceful 的 shutdown request → exit notification/自然关闭等待完成或 budget 耗尽后，重新检查进程存活状态；**仅仍存活**时通过 single-flight guard 恰好一次调用 `handle.terminate()`。`handle.terminate()` 是全插件唯一 hard-stop，禁止任何 deadline/caller/coordinator cleanup/runtime dispose/processLifetime abort 绕过前两步或另行 kill。
4. 无论自然关闭还是调用过 terminate，都必须 await `handle.done` 与 `handle.waitForExit()` 两者 settlement（收集错误但不缩短 quiescence）；进程 seam 用 `killGraceMs` 完成 TERM→KILL，整棵进程树确认退出后才调用 `processLifetimeController.abort()` 释放 lifetime listeners，且 abort 不得再触发 hard-stop。
5. 最后 detach stdout/stdin/error listeners并从两级 pool/tail maps 条件式移除。重复 teardown 返回同一 promise；natural-close、transport-failure与 dispose race 只能推进这一个状态机，`terminate()` 至多一次、lifetime abort 至多一次。

runtime dispose：幂等地同步设置自身 admission cutoff，snapshot pool/queues/retired process cleanup并清空公开 pool；coordinator cleanup在调用它之前已经abort且依次await空active augment registry与空`retiredIo`，因此runtime不拥有也不abort coordinator operation controller、不接管late final-stat promise。runtime让每个session执行上述唯一teardown，并`Promise.allSettled`等待queues、session teardown与retired process cleanup，聚合cleanup error。单一plugin async cleanup只在两个listener disposer、coordinator abort、全部active augment promise settlement以及全部retired final-stat I/O settlement后调用并await此promise。测试必须覆盖unload发生在listener登记/尚未runtime admission、queue wait、initialize、read、didOpen后等待、didClose、final-stat已retire与idle阶段，以及自然关闭、hung shutdown、shutdown/exit写失败和重复dispose race；每例事件序列必须精确且只包含`shutdown request → exit notification/自然关闭等待 → terminate（仅仍存活）→ handle.done + waitForExit → processLifetimeController.abort`，hard-stop事件至多一个且只能是terminate。

### 9. Aggregate renderer

renderer 输入只能是 coordinator 在 eligibility 后构造的以下 discriminated union；unknown field 或形状不符是实现 bug，unit test 必须让 renderer fail loud，coordinator 的 plugin-owned catch 再 fail-open：

```text
{ renderPath, targetKey, canonicalUri, kind:'diagnostics', diagnostics: NormalizedDiagnostic[] }
{ renderPath, targetKey, canonicalUri, kind:'clean' }
{ renderPath, targetKey, canonicalUri, kind:'unavailable', reason:UnavailableReason }
```

其中`renderPath`已由`sanitizeDisplayPath(displayPath)`冻结；sanitizer与server-string sanitizer同规则：每个CRLF序列、单独CR/LF、U+2028或U+2029各变为一个U+0020，其余C0/C1 control与lone surrogate变为U+FFFD，从而恰为一行。`NormalizedDiagnostic`恰为上一节不可变内部schema；`canonicalUri`是eligibility后从`ctx.fs.fileUrl(target)`保存的document URI：diagnostics/clean必须与所接受publication的exact URI相同，unavailable则是本次尝试的URI；它只作审计/第三排序列而不显示。renderer不得接收或再次从raw`displayPath`派生另一排序值，不得输出未清洗的path/source/code/message。

唯一处理顺序：

1. strict-validate全部entries；`reportClean=false` 时删除clean entry。
2. 用共享的 `compareEligibleTargets` 按 `TOTAL_FILE_ORDER = (renderPath, String(targetKey), canonicalUri)` 排序；每列逐Unicode code point数值lexical比较。此顺序必须与coordinator诊断调度顺序相同，renderer只是防御性重排；最终section顺序是其稳定子序列。
3. 每文件diagnostics按 `(start.line, start.character, severityRank(error<warning<info<hint<unknown), source, code, message, end.line, end.character)` 的numeric/Unicode-code-point lexical order排序。
4. 依文件顺序把唯一全局 `maxDiagnostics` 预算分配给diagnostic lines；clean/unavailable不消耗预算。一个diagnostics entry若在global count cap后保留零条，则删除整个entry/section；不得输出只有`File:`而没有diagnostic line的空section。若因此无任何entry则返回`text:null`。
5. 对剩余entries按下面grammar构造**完整 canonical aggregate**；此时决定是否有至少一条保留diagnostic，并据此添加至多一个全局尾注。
6. 最后才对完整canonical aggregate应用 `maxResultChars`。若完整文本code-point length `<= cap`，逐字返回且不添加marker；否则令marker固定为`…(truncated)`：当`cap >= marker`长度时，返回canonical aggregate的前`cap-marker.length`个code points再直接连接marker，当`cap < marker`长度时仅返回marker的前`cap`个code points。marker不是先参与section/尾注grammar再截断；它只在完整文本超cap后替换被删后缀。输出绝不超过cap、不切surrogate pair，也不额外添加换行。

逐字节grammar（所有换行均为单个LF `\n`）：

```text
TITLE               = "[LSP diagnostics after write]"
DIAGNOSTIC_LINE     = "- " severity " " startLine ":" startCharacter "-" endLine ":" endCharacter " source=" JSON_STRING(source) " code=" JSON_STRING(code) " " sanitizedMessage
DIAGNOSTICS_SECTION = "File: " renderPath "\n" DIAGNOSTIC_LINE *("\n" DIAGNOSTIC_LINE) ; 至少一条
CLEAN_SECTION       = "File: " renderPath "\nStatus: clean"
UNAVAILABLE_SECTION = "File: " renderPath "\nStatus: diagnostics unavailable (" reason ")"
SECTION             = DIAGNOSTICS_SECTION / CLEAN_SECTION / UNAVAILABLE_SECTION
ADVISORY            = "Fix these diagnostics before considering the change complete."
AGGREGATE            = TITLE "\n" SECTION *("\n\n" SECTION) ["\n\n" ADVISORY]
```

`UnavailableReason` 封闭为：`server not found`、`server crashed`、`timeout`、`malformed response`、`document too large`、`diagnostics unavailable`；workspace/cwd/outside不在union内。坐标固定把0-based UTF-16 `line`/`character`分别`+1`并显示完整start-end；severity总是normalized token，source/code总是`JSON.stringify`所得JSON string（缺省即`""`），即使message为空，`code=...`之后仍有grammar规定的一个U+0020。

每个aggregate恰有一个TITLE，每个保留文件恰有一个SECTION，SECTION之间恰有一个空行（即恰好两个LF），无前导换行。仅当count cap后aggregate至少有一条diagnostic line时，末尾恰有一个全局ADVISORY，且最后SECTION与ADVISORY间恰有一个空行；全canonical aggregate在ADVISORY或最后SECTION末尾均无尾随换行。clean/unavailable-only aggregate无ADVISORY。一个exec最多一条context；`diagnosticCount`是count cap后保留行数，`fileCount`是char cap前保留section数，summary由`boundContextSummary`限制。

多文件 diagnostics+clean+unavailable 的唯一逐字节 golden（JSON string解码后的值；首尾双引号不属于输出，末尾`.`后无LF）为：

```json
"[LSP diagnostics after write]\nFile: src/a.ts\n- error 12:5-12:10 source=\"typescript\" code=\"TS2322\" Type 'string' is not assignable to type 'number'.\n\nFile: src/b.tsx\nStatus: clean\n\nFile: src/c.go\nStatus: diagnostics unavailable (server not found)\n\nFix these diagnostics before considering the change complete."
```

以上grammar、global count后空section省略、char-cap/marker顺序、换行位置、全局尾注、JSON quoting与排序必须golden-test逐字节确定。

### 10. Coordinator 与 context 合并

listener 的控制流必须使用真实三参 waterfall 并结构性保证下游异常不被 plugin catch 捕获；`_result` 是真实第二参但本插件不消费，禁止误把它当 `next`：

```js
return async (exec, _result, next) => {
  const decision = await next() // 唯一调用；位于任何 try/catch 外
  try {
    const operation = coordinator.beginAugment(exec, decision)
    if (operation === undefined) return decision // admission 已关闭；已同步 take/retire，零 augment I/O
    return await operation.promise
  } catch (_pluginOwnedFailure) {
    return decision // 只能 fail-open 已成功的下游 decision
  }
}
```

`coordinator.beginAugment(exec, decision)` 在一个无 await 临界区检查 admission；若已关闭，必须同步 `collector.take(exec)` 并逐项 `retireIfCurrent` 后返回 `undefined`，不得创建timer/listener、不得做workspace I/O。若仍开放，则创建controller、absolute-deadline timer、caller/cleanup relay listener与幂等`disposeOperationDeadline`，再创建`{ controller, promise, disposeOperationDeadline }` operation record，并用`Promise.resolve().then(() => augmentAcceptedDecision(...))`延迟启动body；先把record加入`Set<AugmentOperation>`，再返回其tracked promise，因此microtask中首次可能的workspace I/O必然发生在登记之后。tracked promise覆盖take/eligibility/resolve/stat/contains/read、runtime diagnose、final stat、render/commit；最外层`finally`无条件调用disposer并幂等删除同一record。即使decision非accept或take为空，也走已登记transaction后take/retire/finally；stop-admission与登记不能在同一JS同步临界区交错，已关闭则返回`undefined`，已登记则cleanup必须abort并await。不得先调用async augment再登记其返回promise，因为async body会在返回前执行到首个await并可能已调用`ctx.fs.resolve`。

`augmentAcceptedDecision` 必须：

1. `collector.take(exec)`，确保non-accept也清理per-exec state；
2. decision非`accept`时逐一`retireIfCurrent`后原样返回；
3. 先过滤unsupported extension；无/空cwd、workspace canonicalization失败/非directory、outside workspace再静默过滤，并立即`retireIfCurrent`，均不产生notice；
4. eligibility后对每个目标以共享`sanitizeDisplayPath`冻结`renderPath`并保存`canonicalUri`，再使用共享`compareEligibleTargets`按唯一`(renderPath,String(targetKey),canonicalUri)`顺序串行诊断；每个workspace I/O与runtime admission前后检查abort，cleanup abort后不启动后续步骤；
5. 通过one-shot commit gate完成final stat/deadline/generation原子裁决；deadline/caller/cleanup先赢时在返回前把尚未settled final-stat records登记到coordinator `retiredIo`，late outcome只有observer/删除副作用；stale静默，eligible plugin-owned unavailable可渲染，所有candidate都调用`retireIfCurrent`且不得删除/回退独立counter或期间出现的更新active marker；
6. aggregate renderer按同一共享comparator防御性排序并执行完整grammar/global count/char cap；
7. 仅当operation未abort且commit gate获胜时，把一条`createUserMessage`追加到`decision.additionalContexts`末尾，不覆盖下游context；cleanup abort后不得发布。

禁止包围 `await next()` 的顶层 catch，禁止把下游 throw/abort 转成 accept 或 unavailable。plugin-owned catch 仅在 target 已完成 supported-extension 与 workspace eligibility 检查后，才可以在有安全 candidate metadata 时生成 bounded unavailable；eligibility 探测自身失败仍须静默。也可以原样返回 decision；两者都不得改变 result。caller abort 对工具调用的最终语义由 ToolRuntime/下游 listener 决定，本插件只保证自身 operation cancellation 与 cleanup。plugin source 固定：

```js
{ kind: 'plugin', plugin: 'dsh-lsp-diagnostics', form: 'notice', summary: boundContextSummary(...) }
```

跨多个并行工具调用时，Agent loop 按 tool-result commit 顺序附加各 exec context；单个 exec 内文件始终按上述文件排序。计划不再声称 collector insertion order 是输出顺序。

### 11. Fake server 与测试可观测性

`tests/fixtures/fake-lsp-server.mjs` 使用 stdio Content-Length。模式至少包括：

- `push-versioned`、`push-versionless`、`clean`；
- `two-batches`、`continuous`、`delayed-old`、`cross-uri-same-version`、`cross-uri-future-version`、`cross-uri-malformed-diagnostics`；
- `strict-diagnostic`、`diagnostic-standard-optionals`（同时携带 tags/relatedInformation/codeDescription/data）、`diagnostic-unknown-extension`、`diagnostic-invalid-consumed-field`、`diagnostic-controls`、`timeout`、`hang-initialize`、`crash`、`malformed`；
- `server-requests`（configuration/lifecycle/applyEdit/unsupported）；
- `close-stdin-after-diagnostics`、`hang-shutdown`、`graceful-order`（记录 shutdown request、exit notification、自然关闭等待、conditional terminate、handle.done/waitForExit、processLifetime abort顺序）。

fixture 可把协议事件写到测试创建的临时日志；生产代码不得依赖该日志。unit test还使用 public `ctx.subprocess` fake handle/writable 模拟 initialize/write/didClose callback 永不 settle，无需 production test hook。

### 12. 执行审计与修复接口

- Todo1-7、Todo6 continuation、fixer、F1-F5 每次 invocation 前均由 coordinator 写 append-only routing JSONL，schema、identity复用、provider/model/full-prompt/round/baseSha规则以「TDD 与实现证据」为准；这是验收接口，不是可选日志。
- Todo6 发现早期 owner 的 manifest/fixture/helper/source/spec 缺陷时，只能按固定 `EARLY_OWNER_REPAIR_PATHS` request→coordinator authorize→同 identity continuation→回归 RED→最小 GREEN 流程回修。
- Final REJECT 必须分类为 `tracked-deliverable` 或 `coordinator-non-code`。前者使用固定 fixer；后者仅允许 coordinator 重采/无损重封装日志、evidence、response，零 tracked commit。两者完成后都复用原 F1-F5 identity 全量重审。
- routing 历史事实不可改写；reviewer response 使用固定 JSON envelope。F2 是上述审计接口的最终 verifier。

---

## Verification strategy

### TDD 与实现证据

- Todo 1-7 每项必须有 `.omo/evidence/dsh-lsp-diagnostics-v1/task-<N>/tdd-red.log`、`tdd-green.log`、`karpathy.md`。
- `karpathy.md` 必须包含仓库 verifier 要求的五个精确标题：
  - `## Assumptions`
  - `## Simplest sufficient approach`
  - `## Changed files`
  - `## No speculative abstraction`
  - `## Surgical scope confirmation`
- Todo 8 若无 tracked 修复，使用 `tdd-not-applicable.md` 且含精确句 `no implementation change; TDD not applicable`，并仍提供 `karpathy.md`；若有 fixer commit，则 fixer 提供 Todo 8 的 `tdd-red.log`/`tdd-green.log` 与 `karpathy.md`。
- 实现/修复代理可以写自己的 git-ignored task evidence；acceptance reviewer 绝对不能写任何文件。
- coordinator 独占写入 append-only `.omo/evidence/dsh-lsp-diagnostics-v1/final/coordinator/subagent-routing.jsonl`。每次启动任何 Todo 1-7 implementation、Todo 6 early-owner repair、Todo 8/acceptance fixer 或 F1-F5 reviewer **之前**追加一行 strict JSON object：`{"invocationId":"<unique-stable-id>","identity":"<stable-id>","role":"implementation|integration-repair|fixer|reviewer","provider":"<actual-provider-route>","model":"<exact-model-id>","prompt":"<完整逐字prompt>","round":<positive-int>,"baseSha":"<40-hex>"}`；不得只记 prompt 摘要/hash，不得事后补造。Todo 1-7、Todo6 continuation 与 fixer 的 provider/model 必须为 `deepseek`/`deepseek-v4-flash`；F1-F5 的 model 必须为 `gpt-5.6-sol`，provider 字段记录启动时的实际 provider/route，不硬编码为 `deepseek`。identity 对 Todo 固定 `T1`…`T7`（Todo6 continuation仍为`T6`）、reviewer 固定 `F1`…`F5` 并跨重审复用；fixer identity 固定为其 round 名，`invocationId` 对每次调用唯一。JSONL 本身不含 secret，prompt 禁止嵌入 secret。
- coordinator 在每轮 response 到达后写对应既有 evidence response 文件，不改 routing 原行。F2 对所有已完成 invocation 将 routing 行与 commit/evidence/response 一一核对；对当前并行 F1-F5 round 则核对 coordinator 在启动批次前已写齐五行及其 identity/round/baseSha，当前五个 response 由 coordinator 收齐后校验 envelope 并供下一轮/最终审计。F2 对 Todo 1-7、Todo6 continuation 与 fixer 断言 provider/model 精确为 `deepseek`/`deepseek-v4-flash`，且 prompt 逐字含 `provider: deepseek` 与 `model: deepseek-v4-flash`；对 F1-F5 断言 model 精确为 `gpt-5.6-sol`、provider 与实际启动 route 一致，且 prompt 逐字含 `model: gpt-5.6-sol`。缺行、多行、错误模型、错误 round/base 或已完成 invocation 无法对应 response 均 REJECT。

### 确定性验证

- 所有 server 测试使用 fake fixture，不访问网络、不依赖全局 profile/真实 server。
- 每个测试拥有并清理自己的临时 workspace、profile、进程与环境变量。
- 编译：`pnpm exec tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit`。
- focused specs：`pnpm exec vitest run plugins/dsh-lsp-diagnostics tests/composition/lsp-diagnostics.spec.ts tests/docs-shape-lsp-diagnostics.spec.ts tests/package-shape.spec.ts`。
- full suite：`pnpm exec vitest run`。
- plan：`node tests/verify-plan-hygiene.mjs docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`。
- evidence：`node tests/verify-task-evidence.mjs .omo/evidence/dsh-lsp-diagnostics-v1 1 2 3 4 5 6 7 8`。
- lock/version：用 `pnpm list --depth 0 --filter dsh-lsp-diagnostics` 与 package-shape spec 断言所有直接 DSH dev dependency 为 `0.1.1-rc.2`；`@deepseek-ai/dsh-fs`、`dsh-llm`、`dsh-subprocess`、`dsh-tools` peer 精确为 `>=0.1.1-rc.2 <0.1.2-0`。

### 必须覆盖的测试矩阵

1. config/package：`enabled` omitted/true/false、完整 defaults、strict unknown keys、只允许且恰好 `.ts/.tsx/.go`、跨 provider duplicate normalized extension、固定 language mapping、JSON serializability、timer/cap边界、`settleMs < timeoutMs`；manifest/lock 断言 `@deepseek-ai/dsh-tools` peer `>=0.1.1-rc.2 <0.1.2-0` 与 direct dev pin。
2. framing：split/coalesced/multibyte frames、大小边界、坏 header/body/JSON。
3. pooling：不同 provider/workspace 隔离，两级 Map 对包含 `::` 的 provider/target key 无碰撞，同 workspace single-flight，同 workspace/same URI并发完整序列化。
4. protocol/schema：request id/result/error、pending cleanup、serialized writes、server requests responses、initialized notification；Diagnostic consumed fields `range/severity/code/source/message` 的类型与range order/0-based UTF-16严格验证；标准 optionals `tags/relatedInformation/codeDescription/data`及unknown extension无论值类型均安全忽略且不进入normalized schema/renderer；各 consumed field非法仍fatal；换行/C0/C1 normalization。
5. URI/version/generation freshness：先 exact canonical URI 再检查 version/schema，跨 URI 同 version/未来 version/畸形 diagnostics 均忽略；当前 URI monotonic old/future/missing version、delayed old notification、后续 observation 在其他文件 diagnosis期间发生、final stat stale；collector表驱动覆盖`observe A→B→retire B→C` generations严格`1,2,3`且A永不复活、A/B/C复用同一`FsVersion`仍只C current、跨exec相同target、retire active不回退counter、`Number.MAX_SAFE_INTEGER`最后一次分配及下一observe进入permanent exhausted fail-safe、lifetime counter retention/active marker回收。
6. final publish gate/late I/O：all stats before deadline、deadline before stats、同tick两种注册顺序、stat reject、deadline后late resolve与late reject、caller/cleanup abort、gate后generation mutation；逐例断言单次decision、无迟到context、正确retire，deadline返回前所有未settled records已在coordinator `retiredIo`且已有rejection observer，late settle幂等移除、无unhandled rejection，工具结果不等待late stat，而cleanup在active augment后等待`retiredIo`至空。
7. deadlines/read/resources：queue、workspace resolve/stat、size preflight；known-size`size === cap`成功、known-size`size > cap`不读即`document too large`、unknown-size`readBytes(..., cap)`成功、unknown-size`FsError`+`FS_TOO_LARGE`→`document too large`、其他read error→`diagnostics unavailable`、invalid UTF-8、initialize、didOpen write、continuous notification、didClose；断言不构造bytes>cap返回值测试、不保留该不可能分支，timeout不因任何事件延长且不调用无界`readText`。用fake clock/listener计数覆盖无candidate、non-accept、快速stats-first、deadline-first、caller abort、cleanup abort与plugin throw；每个operation settlement及重复disposer/cleanup后deadline timer、caller listener、cleanup listener residue均为零。
8. lifecycle：coordinator/runtime/process-lifetime ownership分离；active augment在任何workspace I/O前登记；cleanup严格stop admission→offPost→offObserved→abort coordinator operations→await all active augment promises→await all `retiredIo`→runtime.dispose；覆盖listener已进入但尚未runtime admission及resolve/stat/contains/read/final-stat race、deadline已返回但final-stat仍pending、late resolve/reject与cleanup race，cleanup后零继续执行且registry/timer/listener全空；session teardown严格shutdown request→exit notification/自然关闭等待→conditional terminate→await handle.done+waitForExit→processLifetimeController.abort，terminate是唯一hard-stop；crash eviction、restart、opened close-or-evict、重复cleanup与`enabled=false`零collector/runtime/coordinator/listener/effect/process。
9. coordinator/fail-open/order：通过Cordis`ctx.on('tools/post-execute', ...)`注册并调用真实`ctx.waterfall(..., exec, result, terminalNext)`，验证listener为`(exec, _result, next)`、第二参identity透传、链中前/本插件/后置顺序及terminal next；不得手工直调listener冒充waterfall。`await next()`只有一次且在catch外；下游throw/caller abort identity原样传播；仅plugin-owned failure原decision；无/空cwd、invalid/non-directory cwd、outside workspace与unsupported全静默且不进入renderer/runtime；existing contexts append。用包含newline/control/lone surrogate、Unicode supplementary字符、相同sanitized path与相同target string的目标证明eligibility后`renderPath`只计算一次，诊断调用顺序和最终section顺序都严格使用共享`(renderPath,String(targetKey),canonicalUri)` code-point comparator；禁止raw displayPath二元排序、localeCompare/default UTF-16 sort。
10. aggregate grammar/caps：严格union、1-based start-end、source/code JSON quoting、控制字符单行化、唯一TITLE、每文件一个两行/多诊断行SECTION、section间恰一空行、无前导/尾随LF；diagnostics+clean+unavailable三文件golden逐字节一致；global count cap后零diagnostic文件整section省略，clean/unavailable不耗count；至少一条保留diagnostic时且仅此时末尾恰一个全局ADVISORY并与最后section隔一空行。先构造含ADVISORY的完整canonical text，再应用Unicode code-point char cap并替换后缀为marker；覆盖完整8000、exact/tiny caps、multibyte、单条oversized、marker自身被截、无diagnostic时无ADVISORY，workspace reasons无法传入。
11. real composition：通过真实 Loader/app/process安装并加载 namespace plugin，实际执行官方 `write`、`edit`、三种 mutating `str_replace_editor`，覆盖 `.ts/.tsx/.go`；unsupported/无cwd/outside静默、enabled=false无注册/进程。
12. actual PTC：真实 `run_code` 调用 nested `write`，断言 outer result 的 `additionalContexts`，不得伪造 `parent`。
13. durable delivery：真实 Agent loop + deterministic mock LLM 两步请求；第一步实际调用 mutation tool，session log 的 `user/message` 与第二个模型 request 都包含 plugin notice。
14. execution audit：Todo6 RED 是真实 assertion failure；early-owner repair 的 request/授权/同 identity continuation/回归 RED 完整；routing JSONL 对每次 invocation 记录 identity/provider/model/full prompt/round/base；Final Reject 分类、coordinator-only zero-commit repair 与其后原五 reviewer 全量重审可由 F2 逐项复核。

---

## Execution strategy

### 全局代理规则

- Todo 1-7 每个实现任务的完整提示必须逐字包含 `provider: deepseek`、`model: deepseek-v4-flash`。
- 任何 Todo6 early-owner repair、Todo8 integration fixer 或 acceptance fixer 的完整提示必须逐字包含同一 provider/model。
- 恰好创建五个 acceptance subagent identity：F1-F5，均使用与主协调者相同的 `model: gpt-5.6-sol`，provider/route 使用启动时承载该模型的实际值并写入 routing manifest；F1-F5 不得使用 `deepseek-v4-flash`。修复后复用这五个 identity 重审，不新增第六个 reviewer。
- 每次 subagent invocation 前，coordinator 必须先按「TDD 与实现证据」schema append routing manifest；invocationId/identity/provider/model/prompt/round/baseSha 缺一不可。F2 对 manifest、实际响应、commit/evidence 做闭环审计。
- 所有实现/修复代理都在当前 `feat/dsh-lsp-diagnostics-v1` 分支工作；禁止创建 worktree。写任务严格串行：前一任务完成验证、更新本计划对应 Todo 复选框并提交后，下一任务才能启动。每个执行代理必须自行提交自己负责的实现、测试、文档以及该 Todo 的计划勾选，且不得 `git add .`。
- acceptance reviewer 只读取当前分支冻结 SHA 和协调者预先生成的 evidence，不得调用 write/edit、不得 redirect、不得 `mkdir`、不得生成 cache/snapshot/temp/log、不得 stage/commit；报告只通过 subagent response 返回。F1-F5 是唯一允许同轮并行的 subagent 阶段。

### 审批、计划提交与 base-0

1. 直接人类已明确批准按本计划实施，并要求在 `banbo-dsh` 内新建单一分支、禁止 worktree。
2. 协调者创建并确认当前分支恰为 `feat/dsh-lsp-diagnostics-v1`，运行 plan hygiene，然后只 stage `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`，提交消息固定 `docs(plan): approve dsh LSP diagnostics v1`。
3. 验证该 plan file 已被 `git ls-files` 跟踪且提交内只有该文件；该 commit SHA 写入 `approved.txt` 并定义为 `base-0`。
4. 只有此后才启动 Todo 1。实现期间始终留在同一分支，不创建 worktree、不创建临时集成分支、不 cherry-pick/rebase；若当前分支或 HEAD 出现非预期漂移，停止并交由人类决定。

### 波次与单分支提交链

- Wave 0：Todo 1，从 `base-0` 开始；完成后更新计划勾选并提交。
- Wave 1：Todo 2、Todo 3、Todo 4 按此顺序串行；每项从前一 Todo 提交开始，独立验证、勾选并提交。
- Wave 2：Todo 5、Todo 7 按此顺序串行；每项从前一 Todo 提交开始，独立验证、勾选并提交。
- Wave 3：Todo 6 从 Todo 7 提交开始，完成后勾选并提交。
- Wave 4：Todo 8 串行预验收；完成后勾选并提交计划状态。
- Final wave：冻结 Todo 8 提交 SHA，同一轮并行 F1-F5；五者 unanimous APPROVE 才完成。

| Todo | 依赖 | Blocks | 实际执行 |
| --- | --- | --- | --- |
| 0 | 直接人类批准 | 1 | 协调者串行 |
| 1 | 0 | 2 | 单一 subagent |
| 2 | 1 | 3 | 单一 subagent |
| 3 | 2 | 4 | 单一 subagent |
| 4 | 3 | 5 | 单一 subagent |
| 5 | 4 | 7 | 单一 subagent |
| 7 | 5 | 6 | 单一 subagent |
| 6 | 7 | 8 | 单一 subagent |
| 8 | 6 | F1-F5 | 协调者串行 |

实现 Todo 1–7 与任何 fixer 始终只允许一个写代理运行；只有最终 F1–F5 只读 reviewer 同轮并行。

---

## Todos

- [x] 0. 审批门与 committed plan baseline
  What to do / Must NOT do: 直接人类已明确批准实施；协调者创建并确认当前分支为 `feat/dsh-lsp-diagnostics-v1`，仅提交本计划并确认提交只含该文件，再记录 `base-0`。不得创建 worktree，不得在 Todo 0 触碰实现、测试、manifest、lockfile或其他文档。
  Parallelization: Gate | Blocked by: direct human approval | Blocks: 1
  References: 本计划「审批、计划提交与 base-0」；当前计划在批准时为 untracked，必须先纳入 committed baseline。
  Interfaces:
  - `.omo/evidence/dsh-lsp-diagnostics-v1/approved.txt` 首行 `baseline: <SHA>`；SHA 的 commit 只含本计划。
  TDD steps:
  - RED: 批准前确认实现路径无本任务产生的变更，目标分支尚未建立。
  - Run RED: `git status --short`、`git branch --show-current` 与 `git diff --name-only --cached`。
  - GREEN: 已创建 `feat/dsh-lsp-diagnostics-v1`，运行 plan hygiene，并精确 stage/commit 本计划。
  - Run GREEN after approval: `node tests/verify-plan-hygiene.mjs docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md && git branch --show-current && git show --name-only --format= HEAD`。
  Acceptance criteria: 当前分支为 `feat/dsh-lsp-diagnostics-v1`；`base-0` 是含已批准计划且仅含该文件的 commit；此前无实现变更。
  QA scenarios: happy: plan-only commit 成为 base-0。failure: 分支错误或 commit 含第二个路径 → 停止。
  Commit: Y | `docs(plan): approve dsh LSP diagnostics v1` | Stage exactly `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`.
  Recommended task executor category: unspecified-high
  Executor: coordinator, not a subagent; Todo 0 完成后方可实施

- [ ] 1. Wave 0：精确脚手架、版本锁定、strict Config 与 fake server
  What to do / Must NOT do: 创建 manifest/patch/tsconfig、named-export namespace 入口骨架、六个模块骨架、README 章节骨架、helpers、bundle/config/fixture specs 与完整 fake server；在入口实现 strict Config validator 与 `enabled=false` early return；更新 package-shape；运行 pnpm install。不得实现 collector/runtime/render/coordinator行为；不得创建可选 wrapper；不得改根 package.json。
  Parallelization: Wave 0（单分支串行） | Blocked by: 0 | Blocks: 2
  References: 包与版本契约；配置与验证；Loader unwrap；`plugins/rtk/package.json`；`tests/package-shape.spec.ts`。
  Interfaces:
  - fake server 提供接口契约列出的全部模式，包括跨 URI、Diagnostic consumed-field fatal/optional-extension ignored payload 与完整 teardown 顺序可观测事件。
  - manifest 的五个 peer（含 `@deepseek-ai/dsh-tools`）range 与所有直接 dev version 精确匹配本计划。
  - Config 只接受 `.ts/.tsx/.go` 固定 route，strict unknown/JSON/timer/settle 规则逐项可测试；disabled apply 零 collector/runtime/coordinator/listener/effect/process。
  TDD steps:
  - RED: 先写 bundle/config/fixture/package-shape assertions；必须至少有一个因缺少 `@deepseek-ai/dsh-tools` peer、一个因 validator 尚未实现而真实 assertion failure，记录命令非零和具体失败，不接受 “test file absent/no tests”。
  - Run RED: `pnpm exec vitest run plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts plugins/dsh-lsp-diagnostics/tests/fixture.spec.ts tests/package-shape.spec.ts`。
  - GREEN: 创建精确脚手架、strict validator 与 fixture，运行 pnpm install。
  - Run GREEN: 同上，加 `pnpm exec tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit`。
  Acceptance criteria: package、patch、namespace exports、fixture modes、Config 矩阵、disabled zero-runtime、五个 peer 与直接 rc.2 lock resolution通过；证据含 `tdd-red.log`、`tdd-green.log`、`karpathy.md`。
  QA scenarios: happy: clean/push fixture 完成 initialize/initialized，valid strict config load。failure: unknown `.js`/duplicate `.TS`、invalid JSON、settle>=timeout、peer 放宽到可接受 `0.1.2-rc.1` 或 direct dependency 使用 caret → spec 失败。
  Commit: Y | `chore(lsp-diagnostics): scaffold pinned plugin and fake server` | Stage exactly `plugins/dsh-lsp-diagnostics/package.json`, `plugins/dsh-lsp-diagnostics/cordis.patch.yml`, `plugins/dsh-lsp-diagnostics/tsconfig.json`, `plugins/dsh-lsp-diagnostics/index.js`, `plugins/dsh-lsp-diagnostics/collector.js`, `plugins/dsh-lsp-diagnostics/framing.js`, `plugins/dsh-lsp-diagnostics/runtime.js`, `plugins/dsh-lsp-diagnostics/render.js`, `plugins/dsh-lsp-diagnostics/coordinator.js`, `plugins/dsh-lsp-diagnostics/README.md`, `plugins/dsh-lsp-diagnostics/tests/helpers.ts`, `plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/fixture.spec.ts`, `tests/fixtures/fake-lsp-server.mjs`, `tests/package-shape.spec.ts`, `pnpm-lock.yaml`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 1）。
  Recommended task executor category: quick
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前 `feat/dsh-lsp-diagnostics-v1` 的 Todo 0 提交；禁止创建 worktree

- [ ] 2. Wave 1：Mutation Collector 与 generation freshness
  What to do / Must NOT do: 实现同步collector、独立`nextGenerationByTarget` monotonic counter、`latestObserved` active marker、take/isCurrent/retireIfCurrent及单测。不得把active marker兼作counter、retire时回退/删除counter、做I/O/await/provider routing；任何hostile observation/exec访问异常都必须containment。
  Parallelization: Wave 1（单分支串行） | Blocked by: 1 | Blocks: 3
  References: `fs/observed` 同步契约；本计划「Mutation Collector 与最终发布 generation」。
  Interfaces:
  - `createMutationCollector()` 返回`observe`、`take`、`isCurrent`、`retireIfCurrent`；内部counter lifetime-retain，`isCurrent`严格匹配active generation+version。
  TDD steps:
  - RED: 覆盖write/edit、三种mutating editor、view/unsupported/absent忽略、dedupe、take清理、never-throw；新增`observe A→B→retire B→C`严格分配`1,2,3`且旧A/B永不复活、相同`FsVersion` token跨generation重用、同target跨exec、retire旧/当前candidate、counter到`Number.MAX_SAFE_INTEGER`及下一observe永久exhausted fail-safe、counter不随active marker清理。
  - Run RED: `pnpm exec vitest run plugins/dsh-lsp-diagnostics/tests/collector.spec.ts`。
  - GREEN: 最小实现collector双Map职责与溢出fail-safe。
  - Run GREEN: 同上。
  Acceptance criteria: 后续exec observation使旧candidate同步stale；`isCurrent`同时验证generation/version；retire只删除匹配active marker、不删除/回退counter或较新marker；generation在plugin lifetime不复用，exhaustion后fail-safe不发布；内存为每distinct target一个counter而非每observation增长；证据三文件齐全。
  QA scenarios: happy: generation 1可current，retire后下一次为2。failure: A→B→retire B后A重新current、version token重用绕过generation、counter wrap/reset或跨exec回退均使spec失败。
  Commit: Y | `feat(lsp-diagnostics): track mutation generations` | Stage exactly `plugins/dsh-lsp-diagnostics/collector.js`, `plugins/dsh-lsp-diagnostics/tests/collector.spec.ts`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 2）。
  Recommended task executor category: quick
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前分支 Todo 1 提交；禁止创建 worktree

- [ ] 3. Wave 1：完整 diagnostics runtime、JSON-RPC、兼容 Diagnostic 投影与 teardown
  What to do / Must NOT do: 按接口契约实现 framing/runtime 全状态机；必须使用 canonical session workspace、public FS URI/process path、stat+`readBytes(maxDocumentBytes)`及精确`FsError.code`映射、两级无碰撞 pool/tail Map、完整 spawn spec、唯一 queue、hard deadline、exact URI-first version correlation、consumed-field strict/optional-extension ignored Diagnostic normalization、transport eviction/restart、唯一 tracked graceful-first teardown。不得依赖真实 server、无界 readText、oversized-success bytes、拼接 pool key、host path 猜测、lifetime controller提前abort或第二种hard-stop。
  Parallelization: Wave 1（单分支串行） | Blocked by: 2 | Blocks: 4
  References: `lsp-stdio/src/host.ts:32-58`、`index.ts:216-367`、`connection.ts:17-323`、`instance.ts:252-317`；`FileSystem.readBytes(target, signal, maxBytes)`；SubprocessSpawnSpec/Handle。
  Interfaces:
  - `DiagnosticsRuntime.diagnose(candidate, canonicalWorkspace, executionSignal)` 返回 `ok|stale|unavailable`；runtime不得创建/延长 execution deadline；`stopAdmission(): void`、`dispose(): Promise<void>`。
  - `MessageDecoder(maxMessageBytes)` 与 `encodeMessage(message)`；runtime outcome diagnostics 只能是严格 normalized schema。
  TDD steps:
  - RED: 先写协议/schema（含四个标准optional与unknown extension忽略、各consumed field非法fatal）、两级pool碰撞、concurrency、URI/version freshness、bounded read（exact/known over/unknown success/unknown FS_TOO_LARGE/other error）、deadline、server request、restart、三类signal、唯一teardown顺序与dispose各阶段全部用例。
  - Run RED: `pnpm exec vitest run plugins/dsh-lsp-diagnostics/tests/framing.spec.ts plugins/dsh-lsp-diagnostics/tests/runtime.spec.ts`。
  - GREEN: 实现最小状态机，逐个使上述用例通过。
  - Run GREEN: 同上，加 tsc。
  Acceptance criteria: 不存在双 spawn/交错 open/键碰撞/无界读取/oversized-success分支；known-size exact cap与unknown-size success可诊断，known-size over及unknown-size `FsError.code === 'FS_TOO_LARGE'`只映射`document too large`，其他read error只映射`diagnostics unavailable`；跨URI永不满足waiter；0-based consumed输入严格验证并规范化，四个标准optional与unknown extension不进入normalized schema/renderer；timeout覆盖operation全生命周期但不提前杀process；missing-version规则、close-or-evict、pending cleanup，以及shutdown→exit/natural wait→conditional terminate→done+waitForExit→lifetime abort全部有事件顺序断言；证据三文件齐全。
  QA scenarios: happy: exact URI/versioned two-batches quiet 后返回最新 normalized 数组，携带tags/relatedInformation/codeDescription/data及unknown extension仍得到相同结果。failure: 跨URI同version/畸形payload被忽略；当前URI任一consumed field非法fatal而ignored field任意类型不fatal；unknown-size bounded read只按`FsError.code`分类；hung initialize/write/close/continuous push 在绝对 deadline返回并由唯一teardown顺序回收，下一次诊断可重启。
  Commit: Y | `feat(lsp-diagnostics): add bounded diagnostics runtime` | Stage exactly `plugins/dsh-lsp-diagnostics/framing.js`, `plugins/dsh-lsp-diagnostics/runtime.js`, `plugins/dsh-lsp-diagnostics/tests/framing.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/runtime.spec.ts`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 3）。
  Recommended task executor category: unspecified-high
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前分支 Todo 2 提交；禁止创建 worktree

- [ ] 4. Wave 1：全局确定性 strict-schema aggregate renderer
  What to do / Must NOT do: 实现共享path sanitizer、唯一file comparator、单一aggregate renderer与单测；renderer只接受eligibility后已冻结`renderPath`的规定discriminated union/NormalizedDiagnostic，完成source/code/message control sanitization、0→1 based start-end rendering与完整grammar。数量cap先于canonical text，字符cap只作用于含条件式全局ADVISORY的完整文本；不得重新读取raw displayPath、逐文件各给50/8000预算、输出空diagnostics section、给每section重复标题/尾注、依赖Map顺序/localeCompare/default UTF-16 sort或server object枚举顺序。
  Parallelization: Wave 1（单分支串行） | Blocked by: 3 | Blocks: 5
  References: 本计划「Diagnostics schema」与「Aggregate renderer」。
  Interfaces:
  - `sanitizeDisplayPath(displayPath): string`产生单行`renderPath`；`compareEligibleTargets(a,b): number`唯一比较`(renderPath,String(targetKey),canonicalUri)`三列Unicode code points；coordinator与renderer必须导入同一函数。
  - `renderDiagnostics(entries, config): { text: string|null, diagnosticCount:number, fileCount:number }`；entries只含`renderPath/targetKey/canonicalUri/kind/...`，不含raw displayPath。
  TDD steps:
  - RED: 覆盖非法/unknown input field fail loud、0/1-based坐标、source/code缺省与JSON quoting、CRLF/CR/LF/U+2028/U+2029/C0/C1/lone-surrogate单行化、supplementary code point与共同前缀比较、三列完整tie-breaker、多文件乱序、global count导致diagnostics section零行时整section省略、exact/tiny code-point caps、multibyte、oversized single item、marker自身截断；逐字节断言唯一TITLE、SECTION之间两个LF、无首尾LF、diagnostics+clean+unavailable混合golden、diagnostic存在时唯一全局ADVISORY/无diagnostic时无ADVISORY，以及workspace reason不能构造。
  - Run RED: `pnpm exec vitest run plugins/dsh-lsp-diagnostics/tests/render.spec.ts`。
  - GREEN: 实现shared sanitizer/comparator、strict assertion、排序、count预算、canonical grammar与最后char-cap marker算法。
  - Run GREEN: 同上。
  Acceptance criteria: coordinator可复用同一comparator；grammar/golden逐字节固定；global count后零diagnostic section不存在；仅有保留diagnostic时尾部恰一个全局ADVISORY；先构造完整canonical text再截断/marker；所有输出code-point数不超过cap；相同输入逐字节一致；任何path/server控制字符不能新增行；证据三文件齐全。
  QA scenarios: happy: diagnostics+clean+unavailable乱序输入按三列code-point key输出一个标题和一个全局尾注。failure: cap=1仍不越界且不切surrogate pair；raw displayPath排序与sanitized path排序冲突、count清空文件后留下`File:`、尾注重复/尾随LF或非法union均使spec失败。
  Commit: Y | `feat(lsp-diagnostics): render bounded aggregate notices` | Stage exactly `plugins/dsh-lsp-diagnostics/render.js`, `plugins/dsh-lsp-diagnostics/tests/render.spec.ts`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 4）。
  Recommended task executor category: quick
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前分支 Todo 3 提交；禁止创建 worktree

- [ ] 5. Wave 2：Coordinator、named plugin 装配与最终 freshness commit
  What to do / Must NOT do: 实现coordinator/index与单测；真实listener签名固定`(exec, _result, next)`，`await next()`唯一调用且在plugin try/catch外；coordinator在任何augment workspace I/O/runtime admission前登记controller+完整promise，并独占absolute-deadline timer/caller+cleanup relay disposer与`retiredIo` late-final-stat registry；所有返回分支take/retire；unsupported、无/空/invalid/non-directory cwd、outside workspace静默；一次workspace canonicalization；eligibility后冻结renderPath/canonicalUri并用renderer共享三列comparator同时决定诊断调度/输出；one-shot final stat/deadline/generation gate；单aggregate context；显式持有两listener disposers并由单一async cleanup严格执行stop admission→offPost→offObserved→abort active→await all active→await retiredIo→runtime.dispose。不得default export、fire-and-forget、依赖Cordis disposer并发/逆序、在deadline结果上等待late stat、吞下游异常、覆盖既有contexts、漏等pre-runtime listener/retired I/O或遗留timer/signal listener。
  Parallelization: Wave 2（单分支串行） | Blocked by: 4 | Blocks: 7
  References: Loader/Cordis metadata；真实tools/post-execute三参waterfall；agent-loop additionalContexts；本计划coordinator/entry/final commit/aggregate ordering契约。
  Interfaces:
  - `createDiagnosticsCoordinator({ collector, runtime, config, fs })`返回`{ listener, stopAdmission, abortActiveOperations, awaitActiveOperations, awaitRetiredIo }`；`listener`精确为`(exec, _result, next)`，active registry/controller、operation timer/listener disposer与`retiredIo`由该对象私有拥有。
  - named exports`name`、`inject`、`Config`、`apply`；无default；disabled apply不构造runtime/coordinator。
  TDD steps:
  - RED: 用真实三参waterfall链（前置/本listener/后置）覆盖`_result`占位、next唯一一次及顺序；下游throw与caller abort同一对象原样reject、plugin-owned throw原decision、non-accept清理、所有ineligible静默且零runtime/render、aggregate一条、existing context append、namespace direct load。排序fixture让raw/sanitized path顺序冲突并含supplementary code point/相同renderPath+targetKey，断言runtime diagnose调用顺序与renderer section顺序均严格使用共享`(renderPath,String(targetKey),canonicalUri)` comparator。final gate覆盖stats-first、deadline-first、same-tick、late resolve/reject、caller/cleanup abort与generation races：deadline decision不等待late stat，返回前未settled record已登记且有catch/finally，迟到不能发布或unhandled，settle后幂等移除。另以fake timers/listener counters与controllable promises覆盖无candidate、non-accept、快速stats-first、deadline、admission-vs-register、abort-vs-natural-settle、重复disposer/cleanup，并在resolve/workspace stat/contains前后/target stat/unknown-size read/runtime admission前/final stat各点卸载，断言完整cleanup顺序、active与retired registry最终为空、timer/caller/cleanup listener residue为零、runtime.dispose最后且cleanup后零I/O/admission/context。
  - Run RED: `pnpm exec vitest run plugins/dsh-lsp-diagnostics/tests/coordinator.spec.ts plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts`。
  - GREEN: 实现coordinator/index。
  - Run GREEN: 同上，加tsc。
  Acceptance criteria: Loader不会丢metadata；真实三参waterfall完整通过且下游异常不进入plugin catch；workspace边界无unavailable矛盾；诊断调度和输出共享唯一排序oracle；gate关闭或cleanup abort后无迟到消息/unhandled rejection；deadline工具结果不等待late final stat但coordinator保持ownership；每个augment在首个workspace I/O前登记、所有路径finally释放timer/listeners并幂等移除，listener已进入但尚未runtime admission也被取消并await；stop admission→offPost→offObserved→abort→await active empty→await retiredIo empty→runtime.dispose逐事件断言；证据三文件齐全。
  QA scenarios: happy: raw displayPath顺序相反的eligible目标仍按sanitized三列顺序诊断并生成一条同序notice。failure: runtime throw后decision仍accept且原result不变；`next()` throw/caller abort则同一错误原样向上传播；deadline返回被hung final stat阻塞、late reject unhandled/可追加context、cleanup未等retiredIo，或任一路径留下timer/listener均使spec失败。
  Commit: Y | `feat(lsp-diagnostics): inject fresh aggregate diagnostics` | Stage exactly `plugins/dsh-lsp-diagnostics/coordinator.js`, `plugins/dsh-lsp-diagnostics/index.js`, `plugins/dsh-lsp-diagnostics/tests/coordinator.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 5）。
  Recommended task executor category: unspecified-high
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前分支 Todo 4 提交；禁止创建 worktree

- [ ] 6. Wave 3：真实 Loader/app/process、官方工具、PTC 与 durable delivery
  What to do / Must NOT do: 新建专用 profile helper与composition spec，通过真实 `dsh-app-boot` Loader安装本地 bundle并启动 app；真实注册/执行官方 write/edit/str_replace_editor，真实 run_code nested write，真实 Agent loop + deterministic mock adapter验证持久化下一请求。不得手发 `fs/observed`、伪造 `parent`、仅 `ctx.plugin(apply)`、依赖网络/真实LSP。若 RED 暴露早期 owner 的 manifest/fixture/helper/plugin source/unit spec 缺陷，必须走下述固定 back-repair，不得因原 Todo ownership 已结束而跳过，也不得触碰固定集合外路径。
  Parallelization: Wave 3（单分支串行） | Blocked by: 7 | Blocks: 8
  References: `tests/composition/profile-loader.ts:124-155,200-224`；tool-fs write/edit emit；`tools/tests/ptc.spec.ts:103-116,1068-1092`；agent-loop interception `:613-660`；测试矩阵11-13与F5。
  Interfaces:
  - `lsp-diagnostics-profile.ts` 只创建隔离 profile、安装 bundle、写 test-only root config、boot与cleanup。
  - composition spec覆盖测试矩阵11-13和F5全部声明，包括严格route、workspace静默、真实三参post-execute waterfall、Diagnostic optionals/extensions兼容与consumed-field fatal、URI、known/unknown-size read分类、fail-open边界、eligibility后共享三列排序使诊断调度/最终sections同序、混合多文件唯一aggregate grammar、enabled=false、deadline工具结果不等late final stat但unload在active augment后等待`retiredIo`、operation timer/listener零残留与唯一session teardown顺序。
  - `EARLY_OWNER_REPAIR_PATHS` 固定为 Todo1-5 的全部 tracked stage 路径：`plugins/dsh-lsp-diagnostics/package.json`, `plugins/dsh-lsp-diagnostics/cordis.patch.yml`, `plugins/dsh-lsp-diagnostics/tsconfig.json`, `plugins/dsh-lsp-diagnostics/index.js`, `plugins/dsh-lsp-diagnostics/collector.js`, `plugins/dsh-lsp-diagnostics/framing.js`, `plugins/dsh-lsp-diagnostics/runtime.js`, `plugins/dsh-lsp-diagnostics/render.js`, `plugins/dsh-lsp-diagnostics/coordinator.js`, `plugins/dsh-lsp-diagnostics/README.md`, `plugins/dsh-lsp-diagnostics/tests/helpers.ts`, `plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/fixture.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/collector.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/framing.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/runtime.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/render.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/coordinator.spec.ts`, `tests/fixtures/fake-lsp-server.mjs`, `tests/package-shape.spec.ts`, `pnpm-lock.yaml`。
  TDD steps:
  - RED: 先创建可收集且至少含一个真实 `expect`/assertion 的 `tests/composition/lsp-diagnostics.spec.ts`，再运行精确路径并记录因尚未满足的产品行为而非“文件不存在/no tests/语法错误/人为破坏”导致的非零失败；日志必须含失败测试名、assertion expected/actual与退出码。
  - Run RED: `pnpm exec vitest run tests/composition/lsp-diagnostics.spec.ts`。
  - Back-repair: 若 RED 定位到早期 owner 路径，Todo6 executor 先停止修改并把 `{failingAssertion, rootCause, requestedPaths}` 写入自己的 task-6 evidence/response；coordinator 校验 requestedPaths 均在固定集合后，在 **同一 Todo6 identity、当前分支、同一 base/round** 发 continuation prompt（启动前先写 routing manifest），授权仅 requested subset。该 continuation 先在对应 unit/fixture/package spec 中加入最小回归 assertion并保持 RED，再最小修复；无需回退/重开已完成 Todo，但 final Todo6 commit 可包含该 fixed subset。越界则 blocker 交人类，不临时扩 scope。
  - GREEN: 在 composition 两路径与获批 fixed subset 内完成最小集成/回修，跑 focused + unit dependencies。
  - Run GREEN: `pnpm exec vitest run plugins/dsh-lsp-diagnostics tests/composition/lsp-diagnostics.spec.ts tests/package-shape.spec.ts`。
  Acceptance criteria: RED是真实行为assertion failure；所有early-owner修复有request/authorization/routing/回归RED证据；actual write TS error→durable second request、actual edit→clean、editor三mutations含tsx、Go error→fix、actual run_code outer forwarding、真实三参waterfall、Diagnostic optional/extension忽略且consumed invalid fatal、read error封闭映射、workspace静默、共享三列调度/输出顺序、diagnostics+clean+unavailable唯一标题/section/全局尾注grammar、enabled=false、hard deadline不等待late stat、unload取消并等待pre-runtime augment与`retiredIo`且operation timer/listener清零、按唯一顺序回收process全部通过；证据三文件齐全。
  QA scenarios: happy: mock LLM第二请求和session`user/message`都含逐字节canonical notice。failure: manifest缺peer、fixture缺模式或helper误装配时合法回修并增加回归测试；timeout/server crash只对plugin-owned路径保留成功tool result；下游abort原样传播；late final-stat reject无observer、fiber dispose未等retiredIo、dispose后仍有timer/listener或再次write仍触发plugin均失败。
  Commit: Y | `test(lsp-diagnostics): prove real tool and agent delivery` | Stage exactly `tests/composition/lsp-diagnostics-profile.ts`, `tests/composition/lsp-diagnostics.spec.ts`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 6）, plus only coordinator-authorized changed subset of `EARLY_OWNER_REPAIR_PATHS`; no other path.
  Recommended task executor category: unspecified-high
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前分支 Todo 7 提交；禁止创建 worktree

- [ ] 7. Wave 2：README、docs-shape、安装命令与 sync 脚本
  What to do / Must NOT do: 完成插件README的Usage/Config/Behavior/Model Experience/Known Limitations and Deferred Work/Verification；新增docs-shape、根README一行与独立sync脚本。文档必须准确写named Loader、`enabled=false`零runtime、严格`.ts/.tsx/.go`route、session workspace eligibility静默、plugin-owned fail-open与caller abort边界、真实三参post-execute、independent monotonic generation counter/active marker与overflow fail-safe、eligibility后共享`(renderPath,String(targetKey),canonicalUri)`code-point排序且调度/输出同序、唯一aggregate逐字节grammar/global count后空section省略/条件式单一全局尾注/完整文本后char marker、coordinator active+`retiredIo` ownership与cleanup顺序、每operation finally清timer/listener、bounded byte read和`FS_TOO_LARGE`/other read error映射、Diagnostic consumed-field严格而标准optional/unknown extension忽略、0→1 based渲染、hard deadline/final gate、唯一shutdown→exit/natural wait→conditional terminate→done/waitForExit→lifetime abort、shell边界、server自行安装、rc.2与`dsh-tools` peer边界。不得改其他文档/脚本。
  Parallelization: Wave 2（单分支串行） | Blocked by: 5 | Blocks: 6
  References: `plugins/rtk/README.md`、docs-shape模式、sync脚本模式、本计划接口契约以及当前分支已完成的 Todo 2–5 提交。
  Interfaces:
  - 安装命令固定 `dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics`。
  TDD steps:
  - RED: 从当前分支 Todo 5 提交先写 docs-shape 真实 assertion，记录 README 骨架缺少上述契约文本的非零失败。
  - Run RED: `pnpm exec vitest run tests/docs-shape-lsp-diagnostics.spec.ts`。
  - GREEN: 完成四个owned路径。
  - Run GREEN: 同上，加 `bash scripts/sync-lsp-diagnostics-to-profile.sh --help`。
  Acceptance criteria: Blocked-by 与实际 branch base 都是当前分支已完成的 Todo 5 提交；文档与实现契约不矛盾；限制与 deferred work 集中；证据三文件齐全。
  QA scenarios: happy: docs-shape通过。failure: README声称shell/unsupported/outside workspace也诊断、caller abort保证成功、post-execute为二参、用raw displayPath/不同排序器、每文件重复标题/尾注、deadline等待late stat或cleanup不等retiredIo、generation retire后重用、operation timer/listener无需释放、unknown Diagnostic extension fatal、readBytes可成功返回over-cap bytes、lifetime controller不在process-tree exit后才abort、支持0.1.2或遗漏dsh-tools peer→spec失败。
  Commit: Y | `docs(lsp-diagnostics): document bounded write diagnostics` | Stage exactly `plugins/dsh-lsp-diagnostics/README.md`, `tests/docs-shape-lsp-diagnostics.spec.ts`, `README.md`, `scripts/sync-lsp-diagnostics-to-profile.sh`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 7）。
  Recommended task executor category: writing
  Executor: provider=deepseek, model=deepseek-v4-flash
  Branch base: 当前分支 Todo 5 提交；禁止创建 worktree

- [ ] 8. Wave 4：串行预验收与最终 SHA
  What to do / Must NOT do: 确认当前分支仍为 `feat/dsh-lsp-diagnostics-v1`，且 HEAD 是 Todo 6 提交；协调者在当前分支运行全部命令并写 preflight logs/final SHA。Todo8协调者不得直接修改 tracked implementation；tracked code/test/doc/manifest缺陷走固定 fixer；纯 coordinator-owned 非代码 log/evidence/response **格式或采集完整性**问题走下述 coordinator-only repair。预验收全绿后只把本 Todo 复选框改为 `[x]` 并提交，不得改写历史。
  Parallelization: Wave 4（单分支串行） | Blocked by: 6 | Blocks: F1,F2,F3,F4,F5
  References: 本计划基线链；plan/evidence verifiers；routing manifest；固定 fixer 与 coordinator-only repair contracts。
  Interfaces:
  - coordinator evidence：`final/coordinator/{commit.txt,tsc.log,focused.log,full-vitest.log,plan-hygiene.log,task-evidence.log,lock-versions.log,diff-check.log,status.log,subagent-routing.jsonl,routing-audit.log,non-code-repairs.jsonl}`；`non-code-repairs.jsonl` 无修复时可为空但必须存在。`routing-audit.log` 在 reviewer 启动前验证全部既有 invocation 与当前 F1-F5 五条 launch record，在五个 response 持久化后再验证 response 对应关系；后验失败视为本轮 REJECT，不宣告完成。
  TDD steps:
  - RED: 无 tracked defect 时写 `task-8/tdd-not-applicable.md` 精确句并创建 `karpathy.md`；有 tracked defect 时 fixer先加复现测试并写RED；仅非代码格式/采集问题不得伪造代码 RED。
  - Run RED: `pnpm exec vitest run`（仅 tracked fixer defect flow 期望失败；正常集成与 coordinator-only repair 不制造失败）。
  - GREEN: coordinator依次运行 tsc、focused、full、plan/evidence、lock与git检查；tracked fixer后从头重跑；coordinator-only repair后重做受影响采集并验证同一 SHA。
  - Run GREEN after reconciliation: `pnpm exec tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit && pnpm exec vitest run && node tests/verify-plan-hygiene.mjs docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md && node tests/verify-task-evidence.mjs .omo/evidence/dsh-lsp-diagnostics-v1 1 2 3 4 5 6 7 8`。
  Acceptance criteria: main为clean frozen SHA；coordinator logs全为该SHA；routing manifest可逐项审计；所有进程已cleanup；才可启动五个reviewer。任何 repair 后都必须复用原 F1-F5 identity 对同一/新 frozen SHA 五角色全量重审。
  QA scenarios: happy: ff-only且全绿。failure: main移动、untracked tracked-scope异常或gate失败 → 停止/按缺陷类别进入 fixer 或 coordinator-only repair，不绕过。
  Commit: Y | `chore(lsp-diagnostics): complete preflight verification` | Stage exactly `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（仅勾选 Todo 8）；若预验收前有 tracked fixer，fixer 按固定 contract 独立提交，随后重新预验收并单独提交 Todo 8 勾选。
  Recommended task executor category: unspecified-high
  Executor: coordinator; any fixer uses provider=deepseek, model=deepseek-v4-flash

### 固定 fixer contract（Todo 8 preflight 与 F1-F5 后共用）

- 一轮只启动一个 fixer，固定 `provider=deepseek`、`model=deepseek-v4-flash`。
- `FIXER_OWNED_PATHS` 是唯一 tracked ownership，固定为：`plugins/dsh-lsp-diagnostics/package.json`, `plugins/dsh-lsp-diagnostics/cordis.patch.yml`, `plugins/dsh-lsp-diagnostics/tsconfig.json`, `plugins/dsh-lsp-diagnostics/index.js`, `plugins/dsh-lsp-diagnostics/collector.js`, `plugins/dsh-lsp-diagnostics/framing.js`, `plugins/dsh-lsp-diagnostics/runtime.js`, `plugins/dsh-lsp-diagnostics/render.js`, `plugins/dsh-lsp-diagnostics/coordinator.js`, `plugins/dsh-lsp-diagnostics/README.md`, `plugins/dsh-lsp-diagnostics/tests/helpers.ts`, `plugins/dsh-lsp-diagnostics/tests/bundle.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/fixture.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/collector.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/framing.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/runtime.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/render.spec.ts`, `plugins/dsh-lsp-diagnostics/tests/coordinator.spec.ts`, `tests/fixtures/fake-lsp-server.mjs`, `tests/package-shape.spec.ts`, `tests/docs-shape-lsp-diagnostics.spec.ts`, `tests/composition/lsp-diagnostics-profile.ts`, `tests/composition/lsp-diagnostics.spec.ts`, `scripts/sync-lsp-diagnostics-to-profile.sh`, `README.md`, `pnpm-lock.yaml`, `docs/plan/dsh-lsp-diagnostics-v1-implementation-plan.md`（fixer 仅可将 Todo 8 从 `[x]` 重新打开为 `[ ]`）。
- 每轮只在当前 `feat/dsh-lsp-diagnostics-v1` 分支启动一个 fixer；启动前确认工作树除允许的 evidence 外干净、HEAD 为当前 frozen SHA，并归并全部 finding。prompt 必须逐字携带完整 `FIXER_OWNED_PATHS`、该 frozen base SHA、当前分支名、commit message、真实失败的 RED 命令、GREEN/全量命令，以及本计划新增的 workspace 静默、strict route、真实三参 waterfall 与 next catch 边界、独立 monotonic generation counter/active marker/overflow fail-safe、eligibility 后共享三列 code-point 排序且调度/输出同序、唯一 aggregate 逐字节 grammar 与 count→canonical text→char marker 顺序、coordinator-owned active augment+`retiredIo` registries 和 cleanup quiescence、每 operation finally 释放 deadline timer/caller+cleanup listeners、bounded read 及 `FS_TOO_LARGE` 分类、Diagnostic consumed-field strict/optional-extension ignored、两级 Map、URI-first、final gate、三类取消、唯一 teardown 顺序与 terminate hard-stop、enabled=false 契约，不得缩写为“相关/受影响文件”。禁止创建 worktree 或修复分支；启动前先 append routing manifest。
- fixer只能修改 `FIXER_OWNED_PATHS` 与自己的 `.omo/evidence/.../task-8/**`；每个 substantive defect 必须先加入/指出真实失败 assertion，再最小修复。若 Todo 8 已为 `[x]`，fixer 必须在同一提交中只把 Todo 8 重新改为 `[ ]`，表示预验收已失效。必须使用逐项 `git add` 命令列出实际变更的 `FIXER_OWNED_PATHS`，不得 `git add .`；提交固定 `fix(lsp-diagnostics): resolve preflight findings round <N>` 或 `fix(lsp-diagnostics): resolve acceptance findings round <N>`。
- 若新发现需要 `FIXER_OWNED_PATHS` 外路径，fixer停止并返回 blocker，协调者不得扩大范围。纯 coordinator-owned 日志/evidence/response格式问题禁止启动 fixer，必须改走 coordinator-only contract。
- 每次 tracked change 后协调者更新 frozen SHA、重跑全部 Todo8 preflight与 routing/evidence映射，再让原五个 acceptance identity 从F1到F5全量重审。

### Coordinator-only non-code repair contract（Todo8/F1-F5 共用）

- 只适用于 tracked tree 与 commit 均无需变化，问题严格局限于 coordinator-owned `.omo/evidence/.../final/**` 的缺失/截断 command log、错误 evidence 文件名/JSON envelope、或 reviewer 原始 response 已含全部事实但 coordinator 持久化格式不合约。任何代码、测试、fixture、manifest、lockfile、README/sync、行为契约、测试覆盖或 reviewer 实质 finding 都必须走 tracked fixer；不得把 substantive REJECT 归类成格式问题。
- coordinator-only repair 不启动 fixer、不创建分支或 worktree、不 commit。coordinator 只能在同一 frozen SHA 重跑原只读/验证命令并重写对应 coordinator-owned log，或把 reviewer **原文无损**重新封装；不得编辑 reviewer 原文中的 finding/verdict，不得补造其未报告事实。每次 repair 向 `final/coordinator/non-code-repairs.jsonl` append strict object `{"round":<positive-int>,"sha":"<40-hex>","issue":"<具体问题>","files":["<evidence path>"],"source":"rerun-command|lossless-response-rewrap"}`。
- append-only `subagent-routing.jsonl` 的历史行不得改写。provider/model/prompt/baseSha/routing 缺失或事实错误不能靠 coordinator 伪造修复；只有从已存在 invocation record 可无损恢复的序列化/文件名问题可 rewrap，否则停止交人类。
- repair 后重新运行 evidence/plan/diff/status gates，确认 frozen SHA 未变且 tracked tree clean，然后 **复用原 F1-F5 五个 identity，在新 round 对同一 SHA 同轮全量重审**；不得只让原 REJECT 角色复查，不得把旧 APPROVE 沿用到新 round。新一轮启动前各自追加 routing manifest 行；五个新 response 全部持久化后才可裁决。

---

## Final verification wave

### 不可违反的 reviewer 只读规则

- 恰好 F1-F5 五个 acceptance subagent，同轮并行，全部使用与主协调者相同的 `model=gpt-5.6-sol`；provider/route 记录实际启动值，不得使用 `deepseek-v4-flash`。
- reviewer 不修改任何文件，包括 tracked、untracked、git-ignored、temporary、cache或evidence文件；不创建worktree、不redirect输出、不运行会创建temp/cache/snapshot的测试命令。
- Todo8 coordinator在 reviewer 启动前完成所有动态命令并持久化完整logs。reviewer只用 source/evidence读取、`node`只读 verifier，以及带 `GIT_OPTIONAL_LOCKS=0` 的只读 Git plumbing读取 frozen checkout；不得运行会刷新index的 porcelain。
- reviewer response 必须是一个 JSON object：`{"role":"F1|F2|F3|F4|F5","round":<positive-int>,"commitSha":"<40-hex>","readOnlyCommands":["..."],"findings":[{"id":"<stable>","category":"tracked-deliverable|coordinator-non-code","summary":"...","evidence":["..."]}],"verdict":"APPROVE|REJECT"}`。APPROVE 必须 findings 为空；REJECT 至少一项。`coordinator-non-code` 只可用于前述 contract 允许的 log/evidence/response persistence 格式或采集完整性，不能用于代码/测试/manifest/doc/行为/覆盖/routing事实。
- 五个response返回后，非reviewer coordinator才可把 response 原文逐字写入 `final/F1`…`F5`，并另写不改原文的 parsed envelope；这些目录由coordinator拥有。reviewer本身不持久化证据。
- 五者必须报告同一 frozen SHA/round。任一 `tracked-deliverable` REJECT 进入固定 fixer；若所有 REJECT findings 都是合法 `coordinator-non-code`，进入 coordinator-only repair；混合 findings 先走 tracked fixer。任一路径后都复用同五个subagent identity重新执行完整F1-F5，不只重跑失败角色。

### F1：代码质量与静态验证

- Executor: `model=gpt-5.6-sol`（与主协调者相同；provider/route 取实际启动值并记录），严格只读；不得使用 `deepseek-v4-flash`。
- 读取coordinator的tsc/focused/full-vitest/diff-check/status logs并确认SHA；审查全部plugin source的简洁性、JSDoc、无debug/dead exports、无fire-and-forget teardown；确认post listener精确为`(exec, _result, next)`、`await next()`在plugin catch外且唯一，coordinator active augment与`retiredIo` ownership可审计，每operation finally幂等释放deadline timer/caller+cleanup listeners，`enabled=false` early return不构造任何服务。
- reviewer只可运行：`GIT_OPTIONAL_LOCKS=0 git rev-parse HEAD`、`GIT_OPTIONAL_LOCKS=0 git diff --check <base-0>..HEAD`、只读搜索；`git status`、test/compiler均由coordinator预先运行并在evidence中读取。
- APPROVE要求coordinator logs成功，源码无质量finding，且显式listener disposers/单一async cleanup严格按stop admission→offPost→offObserved→abort active→await active→await retiredIo→runtime.dispose；session teardown只有shutdown→exit/natural wait→conditional terminate→done/waitForExit→lifetime abort一路。

### F2：计划、提交、routing 与证据一致性

- Executor: `model=gpt-5.6-sol`（与主协调者相同；provider/route 取实际启动值并记录），严格只读；不得使用 `deepseek-v4-flash`。
- 读取 coordinator 的 plan/evidence verifier logs、`subagent-routing.jsonl`、`non-code-repairs.jsonl` 与所有 task/reviewer response；用 `GIT_OPTIONAL_LOCKS=0 git log --oneline <base-0>..HEAD` 与 `GIT_OPTIONAL_LOCKS=0 git diff-tree --no-commit-id --name-only -r <commit>` 检查每commit path/message、plan已在base-0。reviewer不重新运行会写文件的 verifier。
- 对每个 T1-T7、Todo6 back-repair、fixer 与每轮 F1-F5 invocation 一一校验 invocationId/identity/role/provider/model/完整prompt/round/baseSha、启动前 append 顺序、response与commit/evidence对应；特别断言 T1-T7、Todo6 back-repair 与 fixer 使用 `provider=deepseek`、`model=deepseek-v4-flash`，F1-F5 使用 `model=gpt-5.6-sol` 且 provider/route 与实际启动值一致，并验证 F1-F5 identity 跨重审复用。
- APPROVE要求每任务 evidence语法通过、stage路径落在精确ownership、Todo6 early-owner授权链完整、无动态文件授权、routing无缺失/补造、coordinator-only repair合规且其后五角色全量重审。

### F3：scope、配置与版本边界

- Executor: `model=gpt-5.6-sol`（与主协调者相同；provider/route 取实际启动值并记录），严格只读；不得使用 `deepseek-v4-flash`。
- 用 `GIT_OPTIONAL_LOCKS=0 git diff --name-only <base-0>..HEAD`，读取manifest、strict Config tests与lock evidence；搜索 private import、ctx.lsp注册、monkey-patch、默认export。
- APPROVE要求 deepseek-harness/现有插件零改动；全部 direct DSH dev dependency 为精确 `0.1.1-rc.2`；`@deepseek-ai/dsh-fs`、`dsh-llm`、`dsh-subprocess`、`dsh-tools` peer 均为 `>=0.1.1-rc.2 <0.1.2-0`；route 只能且恰好 `.ts/.tsx/.go`；unknown/duplicate/JSON/timer/settle 配置与 `enabled=false` 均有断言；无清单外路径。

### F4：并发、协议与生命周期架构

- Executor: `model=gpt-5.6-sol`（与主协调者相同；provider/route 取实际启动值并记录），严格只读；不得使用 `deepseek-v4-flash`。
- 对照Interface contracts审查真实`(exec, _result, next)`waterfall、canonical FS identity、静默workspace eligibility、stat+bounded read及`FsError.code`分类、两级无碰撞pool/queue/single-flight、complete JSON-RPC、Diagnostic consumed-field strict与optional/extension forward compatibility、control sanitization、URI-first correlation、versions、独立`nextGenerationByTarget` monotonic counter与`latestObserved` active marker、operation deadline/disposer、one-shot final stat/deadline/generation gate、close-or-evict、coordinator active augment+`retiredIo` registries、admission/operation/process-lifetime拆分、eligibility后共享三列code-point comparator以及完整aggregate grammar/global caps；逐事件核对plugin cleanup只按stop admission→offPost→offObserved→abort active→await all active→await all retiredIo→runtime.dispose，session teardown只按shutdown request→exit notification/natural-close wait→conditional terminate→await handle.done+waitForExit→processLifetimeController.abort。
- APPROVE要求每项都有实现与对应unit/composition test；任何二参post listener或伪waterfall测试、cwd/outside unavailable、无界read、依赖成功返回over-cap bytes、未将unknown-size`FS_TOO_LARGE`映射为`document too large`、把其他read error映射为同一reason、拼接键碰撞、跨URI接受、拒绝tags/relatedInformation/codeDescription/data或unknown extension、接受非法consumed field、retire active时回退/删除generation counter、version token重用使旧candidate复活、safe-integer wrap、用raw displayPath/locale/default sort或调度与输出不同序、每文件重复标题/尾注、global count后空diagnostics section、char cap先于完整文本/marker、迟到stat可发布/无人观察/不登记retiredIo、deadline工具结果等待late stat、active augment在workspace I/O后才登记、cleanup漏等pre-runtime operation/resolve/stat/contains/read/retiredIo、任一operation路径遗留deadline timer或caller/cleanup listener、cleanup后继续执行、lifetime abort未排在handle.done与waitForExit之后、terminate之外hard-stop、未await disposer、可无限quiet、可接受旧version、可留下opened session均REJECT。

### F5：十项产品验收映射

- Executor: `model=gpt-5.6-sol`（与主协调者相同；provider/route 取实际启动值并记录），严格只读；不得使用 `deepseek-v4-flash`。

reviewer读取测试源码与coordinator focused/full logs，在response中逐项映射且必须10/10：

1. 真实 Loader/app/process 加载 namespace plugin并保留inject/Config；validator 覆盖 defaults/enabled/unknown/JSON/timer/settle 与严格且唯一 `.ts/.tsx/.go` route；`enabled=false` 零runtime/listener/effect/process。
2. 实际 official `write` 写TS错误，tool成功且diagnostics notice进入session `user/message`和下一模型请求；真实 Cordis三参waterfall证明`(exec, _result, next)`第二参及前/本/后/terminal顺序，`await next()`唯一且在catch外，下游throw/caller abort原样传播。
3. 实际 official `edit` 修复同文件，下一请求出现clean；仅 exact current canonical URI/version 的显式空数组可 clean，跨URI publication先忽略再判断version/schema。
4. 实际 `str_replace_editor` 的 create/str_replace/insert均触发，view不触发，并覆盖`.tsx`；`.js`及其他扩展静默且严格配置拒绝其route。
5. 实际Go文件错误→fix/clean；无/空/invalid/non-directory cwd 与 outside workspace全部静默，绝不显示 workspace unavailable/outside workspace。
6. bounded document read 用 stat size + `readBytes(maxDocumentBytes)` 分别证明exact cap成功、known-size over不读且`document too large`、unknown-size成功、unknown-size `FsError`且`code === 'FS_TOO_LARGE'`→`document too large`、其他read error→`diagnostics unavailable`、invalid-UTF8；不存在bytes>cap成功返回分支；两级Map证明provider/target含分隔文本也无碰撞。
7. `publishDiagnostics`严格执行URI/version/diagnostics correlation；Diagnostic只严格验证consumed`range/position/severity/code/source/message`；tags/relatedInformation/codeDescription/data及Diagnostic unknown extension安全忽略且不进入normalized schema/renderer，任一consumed field非法仍fatal；0-based UTF-16→1-based start-end与换行/control sanitization正确。eligibility后同一共享`(renderPath,String(targetKey),canonicalUri)`Unicode code-point comparator同时决定诊断调度和最终sections；diagnostics+clean+unavailable逐字节golden只有一个TITLE、每文件一个SECTION、section间一个空行、条件式唯一全局ADVISORY、无首尾LF，global count清空diagnostics文件时不留section，完整canonical text后才应用char cap/marker。
8. 多文件/并发same URI、delayed-old与collector freshness正确；必须实测`observe A→B→retire B→C`旧A/B永不复活、相同version token重用、跨exec、safe-integer上限/下一次永久exhausted fail-safe。final stat/deadline/generation one-shot gate覆盖stats-first/deadline-first/same-tick/late resolve+reject；deadline decision不等待late stat但返回前未settled records已归coordinator `retiredIo`且有observer，迟到不发布/不unhandled并幂等移除。
9. 缺server/crash/current-URI malformed/hung initialize-write-close/continuous notifications均hard-timeout、仅plugin-owned fail-open、evict/restart；无candidate/non-accept/快速stats-first/deadline/caller abort/cleanup abort及重复dispose后operation deadline timer、caller/cleanup listeners均为零；session teardown唯一顺序是shutdown request→exit notification/natural-close wait→conditional terminate→await handle.done+waitForExit→processLifetimeController.abort，terminate是唯一hard-stop，processLifetimeController只在done与waitForExit完成后abort。
10. 真实`run_code`nested write把context转发到outer result并持久化到下一请求；coordinator在任何workspace I/O前登记active augment，unload在listener已进入但尚未runtime admission以及resolve/stat/contains/read/final-stat/late-final-stat阶段均按stop admission→offPost→offObserved→abort→await all active→await all retiredIo→runtime.dispose，cleanup必须等待late resolve/reject而已返回tool result不等待，之后active/retired registry、timer/listener、listener/进程树均零残留且零继续执行；README准确陈述全部边界。

F5不得用手发 `fs/observed` 或伪造 `parent` 的测试冒充第2/10项。

---

## Commit strategy

- Approval plan commit：`docs(plan): approve dsh LSP diagnostics v1`。
- Todo 1：`chore(lsp-diagnostics): scaffold pinned plugin and fake server`。
- Todo 2：`feat(lsp-diagnostics): track mutation generations`。
- Todo 3：`feat(lsp-diagnostics): add bounded diagnostics runtime`。
- Todo 4：`feat(lsp-diagnostics): render bounded aggregate notices`。
- Todo 5：`feat(lsp-diagnostics): inject fresh aggregate diagnostics`。
- Todo 6：`test(lsp-diagnostics): prove real tool and agent delivery`。
- Todo 7：`docs(lsp-diagnostics): document bounded write diagnostics`。
- Fixer：每轮一个新提交，禁止amend/rebase；message按固定 fixer contract。
- Todo 8 预验收全绿后提交计划中的 Todo 8 勾选；若后续 fixer 产生 tracked change，fixer 同提交重新打开 Todo 8，重新预验收后再提交勾选。
- 禁止 `git add .`、push、tag、force；当前 `feat/dsh-lsp-diagnostics-v1` 分支上的写任务与提交严格串行。

## Success criteria

- 直接人类已批准本修订计划；已批准 plan-only commit 是当前 `feat/dsh-lsp-diagnostics-v1` 分支的 `base-0`。
- 只修改Scope C tracked路径；`deepseek-harness`和现有插件零改动。
- package由真实Loader正确加载named namespace exports；dependency/lock严格停留在direct `0.1.1-rc.2`；四个 DSH peer（含 `@deepseek-ai/dsh-tools`）精确为 `>=0.1.1-rc.2 <0.1.2-0`。
- Config strict 验证 enabled/default/unknown/JSON/timer/settle；route 只能且恰好 `.ts/.tsx/.go` 固定映射；`enabled=false` 零runtime/listener/effect/process。
- official write/edit/editor三mutations只对 `.ts/.tsx/.go` 且在 canonical session workspace 内触发；unsupported、无/空/invalid cwd 与 outside workspace统一静默，无 workspace unavailable/outside 文案。
- workspace/pool/URI完全基于`ctx.fs.resolve/stat/contains/targetKey/processPath/fileUrl`；pool/tail为两级无碰撞Map；document只用stat size + bounded `readBytes`：exact cap可读、known over与unknown-size `FS_TOO_LARGE`为`document too large`、其他read error为`diagnostics unavailable`，从不无界读取或依赖over-cap成功返回。
- runtime满足complete JSON-RPC、Diagnostic consumed-field严格验证/标准optional与unknown extension前向兼容、strict normalized schema/控制字符规范化、exact URI-first correlation、single-flight/serialization、monotonic document versions、hard deadline、one-shot final stat/deadline/generation gate、eviction/restart。
- collector以独立`nextGenerationByTarget` monotonic counter与`latestObserved` active marker同时校验generation/version；retire不回退counter，A→B→retire B→C及version token重用/跨exec均无ABA，safe-integer耗尽永久fail-safe，counter lifetime内存为每distinct target有界增长。
- coordinator拥有active augment registry/controller、operation deadline timer/listener disposer与`retiredIo` late-final-stat registry并在任何workspace I/O前登记active；deadline工具结果不等待late stat，但返回前未settled stat已被观察/登记且永不迟到发布。admission、operation abort与process lifetime分离；单一async cleanup严格执行stop admission→offPost→offObserved→abort coordinator operations→await all active promises→await all retiredIo→runtime.dispose，所有operation路径及重复dispose后timer/listener/registry零残留，cleanup后零继续执行。
- 每个session teardown只有shutdown request→exit notification/natural-close wait→`handle.terminate()`（仅仍存活）→await`handle.done`+`waitForExit()`→`processLifetimeController.abort()`一个顺序；terminate是唯一hard-stop，lifetime abort固定为进程树退出后的最后一步。
- eligibility后`renderPath`只由共享sanitizer计算一次；coordinator诊断调度与renderer sections都只使用共享`(renderPath,String(targetKey),canonicalUri)`Unicode code-point comparator，最终输出是调度序的稳定过滤子序列，不存在raw displayPath或第二排序oracle。
- 每exec至多一条deterministic aggregate notice；0-based UTF-16输入转1-based start-end；逐字节grammar只有一个总标题、每保留文件一个section、section间恰一空行、无首尾换行，至少一个保留diagnostic时才有且只有一个全局尾注；global 50 count先省略零行diagnostics section，再构造完整canonical text，最后才应用8000 code-point cap/marker；ignored Diagnostic字段不进入schema或输出。
- `tools/post-execute` listener精确使用真实三参`(exec, _result, next)`；`await next()`唯一且在plugin catch外；只对plugin-owned post-processing failure fail-open且diagnostics error不是tool error；下游异常/caller abort原样由ToolRuntime决定。
- 真实Loader/app/process、actual tools、actual run_code、真实Agent loop durable next-request路径均有测试；Todo6 RED为真实 assertion failure且 early-owner back-repair 可审计。
- Todo 1-8 evidence通过；Todo8 coordinator preflight全绿；routing manifest把每次identity/provider/model/full prompt/round/base与response/commit一一对应。
- 恰好五个只读 acceptance subagent在同一SHA同轮审查、零文件修改、全部APPROVE；tracked fixer或coordinator-only non-code repair后都复用同五 identity 全量重审。
- 所有未来实现、integration repair 与 fixer agent 均固定 `provider=deepseek`、`model=deepseek-v4-flash`；F1-F5 最终验收 reviewer 均固定 `model=gpt-5.6-sol`（与主协调者相同），provider/route 记录实际启动值，且不得使用 `deepseek-v4-flash`。
