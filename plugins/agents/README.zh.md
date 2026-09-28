# @banbolee/dsh-agents

[English](./README.md) | **中文**

用 YAML 定义你自己的 Agent 团队，并在 DSH 里以**具名工具**（`agent_<id>`）显式委派。本插件把自带的 preset 作为 `@deepseek-ai/dsh-agent-preset` 行声明的在 profile 的 `@deepseek-ai/dsh-agent-preset-registry` 上，并在 Web 端的 Plugin Configuration 里提供一张配置页。

设计与决策的完整依据见 [`docs/agents-plugin-plan.md`](../../docs/agents-plugin-plan.md)。

## 当前状态

方案 §16 的 Stage 1–4 已完成，Gate A–E 平台探针全绿：

- **Host 装配**：读取内置 catalog（`catalog/*.yaml`，7 个 Agent）与用户 catalog（`$DSH_HOME/banbo-agents/agents/*.yaml`），受约束合并与全量校验；发布**不可变 ABI generation**，用原子 `current` 指针替换激活；写入 ABI manifest，保护已发布的 `toolName` / `presetId` / main-child 形态 / `child.continuation`。
- **Persona**：用户 `prompts/` 优先、包内 `prompts/` 兜底；严格 UTF-8、双重尺寸上限、末尾单换行归一化。
- **委派 runtime**：`agent_<id>`、`delegate_batch`、授权图与 absolute depth 校验、root Session 并发预算、one-shot/continuable 生命周期、HolderRegistry 与结构化隐私安全日志。
- **CatalogRemote**：只读、启动期固定的 catalog 视图（无 persona、路径、composition、settings）；由官方 Typert generator 生成 Host/客户端 descriptor。
- **Web 设置卡**：占用插件页自己的 `plugins.bundle.config` 座位（按包名作 key），经严格 Typert Remote 读 catalog，用官方共享配置表单 `ctx.configForms.get('banbo-agents')` 读写 enabled/model，而这张表单就是本插件自己 Loader row 的 `Config`。

## 安装

```sh
dsh plugin --profile <profile> add @banbolee/dsh-agents
```

从源码安装：

```sh
dsh plugin --profile <profile> add -w ./plugins/agents
```

安装后重启 profile：catalog 与 generation 在 Host ready 之前完成，坏配置会让启动直接失败并在报错里给出文件路径。

### Preset 声明与自定义预设

本插件把自带的两个 preset（`banbo` 与 `planner`）声明为 [`cordis.patch.yml`](./cordis.patch.yml) 里的两条 `@deepseek-ai/dsh-agent-preset` 行。preset 是**声明**而不是目录：`config.id` 是 Session 保存的 preset 身份，`config.plugins` 是它挂载的 composition。roster 本身属于 profile 的 `agent-preset-registry` 行（config `{ default, selectedDefault }`），DSH Web `0.1.7-rc.2` 以 `default: standard` 插入它；本插件刻意既不声明也不 patch 这一行，所以别的 Bundle patch 它也无法拿走这里的 preset。

要加自己的 preset，把同样形状的行写进你自己的 profile patch —— `$DSH_HOME/profiles/<profile>/cordis.patch.yml` —— 或安装一个自带该行的 Bundle：

```yaml
- insert:
    - id: preset-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review
        name: Review
        description: Reviews changes with the shell only.
        order: 30
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You review software changes.
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
```

要跑本插件某个主 Agent 的 composition 还必须带上两条 runtime 行——`@banbolee/dsh-agents/main-runtime` 与 `@banbolee/dsh-agents/delegation`——每条都把 `config.agentId` 设成那个 Agent。照抄 [`cordis.patch.yml`](./cordis.patch.yml) 里 `preset-banbo` 的 `plugins:` 列表并改掉两个 `agentId` 即可；这个 composition 已经没有生成器替你产出了。

两条要清楚的结果：

- 用户主 Agent 的 YAML 里写了 `main.presetId: my-lead`，就必须有一条 `config.id` 为 `my-lead` 的 preset 行；没有它该 Agent 仍在 catalog（与 ABI）里，但它的 runtime 会拒绝激活并以 `preset mapping mismatch` fail-loud；
- profile 若没有组装任何 `agent-preset-registry` 行，这些 preset 行会一直 pending，本插件也会一直等 `agentPresets` 服务——Web profile `0.1.7-rc.2` 是组装了它的。

## 团队一览

内置 7 个 Agent。`main` 形态出现在官方 Session 的 preset picker 里；`child` 形态只能通过具名工具委派。

| Agent | 形态 | continuation | 可委派给 | maxDepth |
|---|---|---|---|---|
| `banbo` | main | — | planner, research, explorer, implement, review, executor | 2 |
| `planner` | main + child | optional | research, explorer, review | 1 |
| `executor` | child | optional | research, explorer, implement, review | — |
| `implement` | child | optional | research, explorer | — |
| `review` | child | optional | research, explorer | — |
| `research` | child | one-shot | — | — |
| `explorer` | child | one-shot | — | — |

`maxDepth` 是**绝对**深度上限，不是相对层数。`banbo` 的 2 意味着 `Banbo → Executor → Implement` 合法，而 `Implement` 不能再委派第三层。

## 委派语义

- **前台（默认）**：下一步依赖子结果、或会改同一文件时，前台等待。
- **后台**：仅当存在明确无依赖、无冲突的其他工作时才用 `run_in_background: true`。
- **batch**：多个互不依赖的 one-shot 结果都返回后才能继续时用 `delegate_batch`。batch 不接受需要保留对话的 Agent。
- **one-shot**：`research` / `explorer` 是一次性任务，结算后不保留可继续会话；给它们发复用型指令不会有第二次送达。
- **continuable**：`optional` continuation 的 child 在前台调用时仍是 one-shot，只有后台调用才保留可继续会话。需要同一专家继续上下文时，先 `list_agents` 找 idle 的 continuable child，再用 `send_message` 复用。

子 Agent 可能通过 direct message 和 settlement notice **两次**送达同一份结论；按 `childId` 视为同一次完成，不重复行动。

## 部分状态与并发

- `deadline` 到期拿到的是 `partial_timeout`：基于部分结果继续。
- `cancel_requested` 与 `cleanup_deferred` **都不代表任务已完成**。
- **并发超限 fail-fast**：root Session 并发预算用尽时新委派直接失败并说明原因与修复路径，不排队、不静默降级。
- 并发计数**不跨重启**：重启后额度从零开始，历史占用不会被重新计入。

## Persona 与覆盖

内置 persona 按运行形态拆分，固定包含 `Role`、`Responsibilities`、`Non-goals`、`Tool Policy`、`Delegation Policy`、`Collaboration Protocol`、`Output Contract`、`Failure Policy` 八节。lint 会机械校验：节标题唯一、顺序固定、每节非空，且不出现未授权的工具名或通用委派入口。

不要编辑发布包里的 `prompts/`。覆盖有两条路径：

1. **同名自动覆盖**：把与内置文件**同名**的文件放进 `$DSH_HOME/banbo-agents/prompts/`，例如 `prompts/planner-child.md`，它会自动覆盖包内的同名 persona，无需改 YAML。
2. **自定义文件名**：先放文件，再在用户 Agent YAML 里显式引用：

```yaml
main:
  persona: prompts/my-lead-main.md
```

覆盖文件遵守同一 UTF-8、64 KiB 单文件与总量限制；配置修改在下次 profile 启动时生效。

## 设置

Web 端在 **Settings → Plugins** 里选中 `@banbolee/dsh-agents` bundle：它的详情页会在 Plugin Configuration 区块里渲染这张卡（插件页自己的 `plugins.bundle.config` 座位，按包名作 key）。表单的命名空间就是本插件的 Loader row id `banbo-agents`；一次写入落在 profile patch 中该行的 user 层，并被提交进运行中的插件实例而不需要重挂载。

可编辑项：

- `includeDefaults`：是否启用全部**内置** Agent（默认开）。用户自定义 Agent 永远启用。
- 每个 Agent 的 `enabled`：停用可逆，不删除定义。
- child 形态的 `model`：`{ provider, model, reasoningEffort? }` 或 `{ default: true }`。

不可编辑项（会明确说明原因）：

- **main 形态的 model**：主 Agent 的模型只由官方 Session model selector 决定。给 main-only Agent 写 model 会以 `model-on-main-only` 拒绝。
- **已退役（retired）Agent**：只读展示，不能重新启用。

设置卡采用**暂存编辑 + 一次提交**：改动先进入草稿，点提交后用当前 revision 走一次 `mutate`；如果 revision 已过期，会保留草稿并提示冲突，不会覆盖别人的改动。清空 model 使用路径级 `unset`，不会连带删除同 Agent 的其他字段。

YAML/JSON 形状示例：

```yaml
includeDefaults: true
agents:
  planner:
    enabled: false
  implement:
    model:
      provider: default-provider
      model: default-model
```

**live 状态 vs 冻结 descriptor**：`enabled` / `model` 是 live 的，改完对**新建**的子 Agent 生效（main 的模型仍归官方选择器）。而子 Agent 创建时冻结的 `persona` / `toolFilter`（continuable descriptor）不会因为后来改设置而回写；已经存在的 continuable child 继续用创建时的组合。这也是为什么**推荐用 `enabled: false` 而不是删除定义**，以及为什么退役 Agent 会保留同名空壳工具：冷恢复时冻结的 `toolFilter` 里必须仍有那个名字，否则官方 `tools.restrict()` 会直接抛错。

## 数据布局

```text
$DSH_HOME/banbo-agents/
├── agents/*.yaml              你写的 Agent 定义（唯一需要手工编辑的目录）
├── prompts/*.md               你写的 persona；同名文件覆盖包内版本
├── .generated/                Host 生成的 ABI 产物，勿手工编辑
│   ├── generations/<hash>/    不可变的一代：abi.json + complete
│   └── current -> generations/<hash>   原子替换的指针
└── .children/<childId>.json   continuable 子 Agent 的身份 sidecar
```

preset **不在**这里：preset 是插件自带 [`cordis.patch.yml`](./cordis.patch.yml) 或你自己 profile patch 里的一行，永远不是本插件扫描的目录。

`.generated/` 只由本插件写入和清理，且只清理带自己 `complete` 标记的目录；你放进去的其它内容不会被跟随、也不会被删除。指针替换失败时**旧指针原样保留**，编译直接失败并报错，不会出现半激活的一代。

### Sidecar 可移植性

每个 continuable child 一个不可变 JSON 文件，路径是 `.children/<childId>.json`，以 `childId` 为唯一键。写入先把内容落到临时文件，再用 **`link` 原子创建**（create-if-absent）发布：已存在的同名记录**不会被覆盖**——内容完全相同视为幂等重试，内容不同则报 `already-exists`。不支持硬链接的文件系统回退为「先检查再 rename」，拒绝覆盖的语义不变。多 child 并发写不同路径互不冲突。文件内容不含绝对路径，因此：

- 备份/迁移整个 `$DSH_HOME/banbo-agents/` 目录即可保留子 Agent 身份；
- 单独移动 `DSH_HOME` 而带上该目录同样有效；
- 删掉某个 sidecar 只会让对应 child 无法按身份复用，不影响其它 child。

## 卸载与数据保留

```sh
dsh plugin --profile <profile> remove @banbolee/dsh-agents
```

普通卸载**保留** `$DSH_HOME/banbo-agents/` 全部内容（YAML、persona、ABI manifest、身份 sidecar）。重装后 catalog、退役空壳和旧 continuable 子 Agent 的身份都能恢复。卸载只意味着本插件不再挂载到运行时，它的 preset 行随之消失，官方 roster 回到默认状态。

## 破坏性清除（不可逆）

只有手工删除才会真正清除：

```sh
rm -rf "$DSH_HOME/banbo-agents"
```

这会同时删除 YAML、persona、ABI manifest 与退役空壳记录。**删除 ABI manifest 的后果**：旧 continuable 子 Agent 冻结的 `toolFilter` 里那些 `agent_<id>` 名字会消失，冷恢复将无法进行。

## 三条明确的非承诺

1. `send_message` 的复用**不精确计数**：它是尽力而为的会话复用，不保证同一个子 Session 被复用几次。
2. 并发计数**不跨重启**：重启后并发额度从零开始，历史占用不会被重新计入。
3. 删除一个有 `main` 形态的主 Agent 会**连带整棵子树失效**（连带其下全部 continuable 子 Agent，因为冷恢复需要活着的直接父 Session）。这是期望行为，不是缺陷。

因此**推荐用 `enabled: false` 停用 Agent，而不是删除定义文件**：停用随时可撤销；删除会让该 Agent 退役（有 `main` 形态时连带整棵子树失效），虽然把同名文件放回去可以复活，但**要改语义就换新 id**。

### 删除后放回同名 YAML 会复活，但用的是新 composition

删掉定义文件后，那个 id 会**退役**：已经没有东西再声明它的 preset，旧主 Session 走官方 `agent-preset/not-found`。**把同名文件放回去、并在删过 preset 行时重新声明那一行，再重启，这个 id 会复活**——旧 Session 的 preset 解析重新成功，于是按 current-policy resume 语义继续运行。

这条边界要清楚：

- **好处**：误删之后放回原文件即可恢复，是最自然的救回路径；
- **风险**：如果放回的是**改写过的**定义，旧 Session 会在一个新 composition 下继续，历史里可能出现新 composition 做不了的工具调用；
- **推荐**：要改定义语义就**换一个新 id**，不要复用旧 id 改含义。复活的定义仍受 ABI 收窄检查约束——不能删掉已发布的 main/child 形态、不能改 preset id、不能切换 `continuation`，否则启动会明确失败。

## Web 设置卡与构建

Host Remote、Typert descriptor 与 Web client 都有构建产物，源码改动后必须重新构建：

```sh
pnpm --filter @banbolee/dsh-agents build   # node scripts/build.mjs
```

构建会：

1. 先清空 `lib/`；
2. 在临时 workspace 适配层里调用官方 Typert generator，产出 `lib/typert.host.*` 与 `lib/typert.remote-client.*`；
3. 用 `tsc` 产出 Host Remote 与客户端类型（`lib/types/**`）；
4. 用 `tsdown` 产出单文件经典客户端 bundle `lib/client.js`（`window.__ModuleLoader__` 工厂、无代码分割）。

排障：

- **设置卡不出现**：确认构建已跑过且 profile 里存在 `lib/client.js`；再次刷新页面。客户端只在 Remote mount 与 `list()` 成功后才注册 locale 与 slot，任一步失败都会整体回滚。
- **preset picker 里没有 Banbo**：确认 profile 组装了 `agent-preset-registry` 行，且我们的 `preset-banbo` / `preset-planner` 行都在（`dsh --dump-config`）。没有 registry 时这些 preset 行会一直 pending，本插件也不会激活。
- **改了 persona/YAML 没生效**：配置在**下次 profile 启动**时生效；改动的是已有 continuable child 的冻结 descriptor 时，需要新建 child。
- **启动直接失败并给出文件路径**：这是期望的 fail-loud。按报错里的文件与字段修正 YAML；旧 generation 与 `current` 指针保持原样。

## 开发

```sh
env NODE_ENV=development pnpm test                              # 整仓
env NODE_ENV=development npx vitest run --dir plugins/agents    # 只跑本插件
node scripts/build.mjs                                          # 重新构建产物
```

Gate 探针位于 `tests/gates/`，与产品单测分开：

```sh
env NODE_ENV=development npx vitest run --dir plugins/agents    # 只跑本插件普通 lane
env NODE_ENV=development pnpm test:agents:gates                 # Gate + packed lane
```

`tests/packed.spec.ts` 会跑真实 `npm pack` 并断言发布面与纯 ESM 导入，需要先执行一次构建。
