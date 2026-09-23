# Agents 插件实施方案

> 状态：**v1 设计基线**  
> 包名：`@banbolee/dsh-agents`  
> 目标环境：DeepSeek Harness `@deepseek-ai/* ^0.1.5-rc.1`、dsh-tui `0.10.2`  
> 本文是唯一权威方案；正文没有“另一节覆盖本节”的隐含优先级。

## 0. 先看结论

这个插件不是一包提示词，而是一套安装在 DSH 上的 **Agent 团队运行层**：

1. 用户从官方 Agent preset picker 选择一个主 Agent；
2. 主 Agent 只能看见授权给它的具名子 Agent 工具；
3. 每个子 Agent 有自己的 persona、默认模型、普通工具白名单和可调用子 Agent；
4. 单个委派可前台等待或后台运行；`delegate_batch` 像一个轻量 workflow，接受任意有 `child` 形态的目标、把每个 item 都按 **one-shot** 执行并等待它们的 `run.result`，或在唯一 deadline 到期时返回 `partial_timeout`（未收束的资源交给 cleanup registry，不留孤儿）；
5. 用户既可以覆盖内置 Agent，也可以通过 YAML + Markdown 新增主 Agent、子 Agent 或两者兼具的 Agent；
6. Web 第一版只编辑启停和**子 Agent 模型覆盖**；结构、persona、权限图等高级配置由文件管理，重启后生效。

### 决策索引

回答"为什么这样设计"时从这里查，不必翻全文。每条给出**一句话结论**和**权威章节**。

**模型与能力**

| 决策 | 结论 | 章节 |
|---|---|---|
| 主 Agent 模型 | 完全不归本插件管，交给官方 Session 模型选择器；插件不写 `model/selection`、不装第二个 selector | 7.3 |
| 子 Agent 模型 | 只由 settings 覆盖，且**只作用于委派 route**；具体 route 必须完整给 provider + model | 1.2 / 7.2 |
| 工具面 | strict allowlist + 统一 `FORBIDDEN_DELEGATION_TOOLS` 单清单；这是 tool-surface control，**不是**安全沙箱 | 5.2 |

**委派与资源**

| 决策 | 结论 | 章节 |
|---|---|---|
| 递归控制 | 绝对深度（官方 numeric cap 强制）+ root Session **并发**上限；深度管高度、并发管宽度；不做累计启动数 | 10.2 / 10.3 |
| 单个前台委派 | 有 `foregroundDeadlineMs`；超时发协作式 cancel，grace 用尽把 holder 移交 registry | 10.5 |
| 后台 one-shot | 同样有 `backgroundDeadlineMs`（30 分钟）；**没有任何一条委派路径缺少 deadline** | 10.5 |
| `delegate_batch` | 接受任意有 `child` 形态的目标，**每个 item 一律 one-shot 执行**；单一 deadline；未在 grace 内收束的 holder 所有权移交 cleanup registry，绝不产生无人持有的 run | 10.7 |
| continuable 执行模式的批量委派 | v1 明确不做（`subagent/end` + `interrupt` 与 `run.result` + `dispose` 两套生命周期无法共用同一个 waiter） | 10.7.1 |
| `send_message` 并发计数 | **不精确计数**；只保证新建 child 精确计数，该限制写入 README | 10.3 |

**身份、持久化与删除**

| 决策 | 结论 | 章节 |
|---|---|---|
| child 身份 | 分两种载体：continuable 写 sidecar 文件 `$DSH_HOME/banbo-agents/.children/<childId>.json`；one-shot 只进进程内 live map。**不写任何私有 Session event**（Gate A 已证否，见 11.1.1）。禁止用 label / persona 推断身份。**`generation` 只做诊断，绝不作为阻断或授权条件** | 11.1.1 |
| 删除 Agent 定义 | **删除即删除**：连 generated preset 一起移除，旧主 Session 及其整棵子树不可恢复；纯 child 保留 `agent_<id>` 工具名空壳（唯一目的是让旧冻结 toolFilter 不硬失败） | 6.3 / 11.2 |
| 旧 Session 恢复 | current-policy resume；找不到 preset 就明确失败，**不回退到默认 Agent** | 9.4 |
| 想停用而不删 | 用 `enabled: false`；README 必须把它写成推荐做法 | 6.3 / 7.1 |

**工程约束**

| 决策 | 结论 | 章节 |
|---|---|---|
| preset 分发 | 不可变 generation + `current` 指针原子切换；不用"交换非空目录"（Node 无此原语） | 8.6 / 8.7 |
| standard preset 副本 | 包内维护完整副本，并用 `dsh-standard-inventory.json` + CI digest 门禁防止静默漂移 | 8.3 |
| 用户输入边界 | YAML 解析显式收紧（禁 `<<`、禁自定义 tag、限 alias）+ `CATALOG_LIMITS` 资源上限；超限启动失败，不截断 | 6.1.1 / 4.4.1 |
| 可观测性 | 6 类结构事件写 Host logger；**绝不记录 prompt 正文、输出、persona、凭据、绝对路径** | 13.1 |
| Gate 分层 | 阶段 0 只跑平台探针；产品正确性归阶段 2 的四个验收测试 | 15 / 16 |

**Gate A 的已决结论（v1 据此定案）**：§11.1.1 原定的"插件私有持久 Session event"方案已被 Gate A 证否——`Session.append()` 无法写入 `ignorable`，而 persistence 对未知且非 ignorable 的事件类型直接拒绝解释整份日志。v1 因此改用 **sidecar 文件存储**承载 continuable child 的身份，并且**不新增任何私有 Session event**。其余 Gate 失败只调整实现细节。

### v1 已冻结的产品边界

- 一个 Bundle 同时安装到 Web 与 dsh-tui；
- 内置 7 个 Agent：Banbo、Planner、Executor、Implement、Review、Research、Explorer；
- 用户可以新增或修改主/子 Agent；
- 主/子运行形态分开配置，共享授权图；v1 的模型覆盖只作用于子 Agent 委派，主 Agent 使用官方 Session 模型选择器；
- 递归采用**每个主 preset 固定的绝对深度上限**，授权图禁止环；深度只管高度不管宽度，因此每个 root Session 另有一份共享的**并发**上限（`maxConcurrentChildren`，默认 6，clamp `[1, 32]`），防止整棵 Agent 树 fan-out 失控；
- Research / Explorer 固定 one-shot；其他子 Agent 可按调用选择 one-shot 或 continuable；
- `delegate_batch` 接受任意有 `child` 形态的 Agent，每个 item 一律以 one-shot 执行，在唯一 deadline 内并行等待 `run.result`，到期返回 `partial_timeout`；未在 drain grace 内收束的 holder 所有权移交 cleanup registry（10.8），绝不产生无人持有的 run；continuable 执行模式的批量委派留待 v1.1；
- 前台单个委派也有 deadline（默认 30 分钟）：到期发协作式 cancel，drain grace 内收束就返回带标注的部分结果，否则把 holder 交给 cleanup registry 并标注 `cleanup_deferred`；后台 one-shot 同样有 deadline（默认 30 分钟）。**不存在没有 deadline 的委派路径**——那会让一个挂死的 run 永久占住并发槽；
- `send_message`、`list_agents`、`interrupt_agent` 保留；persona 禁止把 `send_message` 当轮询或催促工具；
- settings 不重装正在运行的 Agent，只影响后续动作；
- picker 不因 settings 启停而运行时增删；禁用项若仍显示，选择或调用时明确拒绝；
- 用户定义文件和生成的 preset 清单在重启后生效；**删除即删除**：删掉一个有 `main` 形态的 Agent 定义会同时移除它的 generated preset，该主 Agent 的旧 Session 及其整棵子树不再可恢复（官方按 preset 解析失败拒绝）；不提供 picker 层的 tombstone 灰条目，也不做"回退到默认 Agent"；
- child 业务身份分两种载体，见 11.1.1：**continuable** 写插件侧 sidecar 文件 `$DSH_HOME/banbo-agents/.children/<childId>.json`；**one-shot** 只在进程内 live map 里登记，不落盘。官方 descriptor 继续管 route / persona / toolFilter，两者不互相复制字段；身份缺失或不可识别时 fail-closed：只禁止继续委派，不禁止该 child 的普通能力；
- 已发布 `agent_<id>` 工具名在定义被删除后仍以**空壳**形式保留注册（`RetiredToolShell`，见 4.1），唯一目的是避免旧 continuable child 的冻结 `toolFilter` 因 unknown 名而硬失败；空壳不是授权候选、不出现在 picker、不能被 settings 启用；
- 不承诺每角色独立 session sandbox。Research / Explorer 使用严格工具白名单，文案称 **tool-limited**，不冒充真正的 `read-only` 沙箱。

### v1 明确不做

- 不修改 DSH 内核，不 monkey-patch 官方对象；
- 不注册第二个 `ctx.agentPresets`、`ctx.subagents` 或 LLM registry；
- **不新增任何私有 Session event**，也不改写、伪造或覆盖官方 `subagent/descriptor`：Gate A 已证明私有事件类型会让子 Session 在下次加载时被 persistence 拒绝（11.1.1），身份因此走插件侧 sidecar 文件；
- v1 不做 continuable 执行模式的批量委派：`delegate_batch` 的每个 item 都以 one-shot 执行（`optional` 目标也不例外），`keepSession` 参数整体移除，mixed batch 留待 v1.1（见 10.7.1）；
- 不做 picker 层的已删除 Agent 占位（tombstone 灰条目）：删除一个主 Agent 后它的 preset 干净消失，旧 Session 走官方 preset 解析失败，不做"回退到默认 Agent"，也不伪造迁移；
- 不实现完整 Web Agent Builder；
- 不监听用户 Agent 目录做热更新；
- 不用 `recompose → tools/change` 重装正在运行的主 Agent；
- 在 DSH 工具注册表层面不开放官方通用 `subagent`、`subagent_fork`、`workflow`、`ralph`，只收敛模型可见委派入口；统一禁用清单见 5.2；
- 不实现 ACP、Codex、Claude Code 或 dsh-sdk Provider；v1 只用官方 `spawn`；
- 不保证禁用 Agent 立即从 picker 消失；
- 不实现 `banbo-agents purge` 自动命令；v1 只在 README 说明手工破坏性清理步骤；
- 不允许 LLM 在调用具名 Agent 时任意覆盖 provider/model。

---

## 1. 用户体验

### 1.1 零配置

安装后，用户继续使用官方 picker，不增加新的应用入口：

```text
Standard
Banbo
Planner
```

Banbo 是默认总协调 Agent；Planner 可单独作为主 Agent 使用。其他内置 Agent 默认作为子 Agent。

```sh
dsh plugin --profile web add @banbolee/dsh-agents
dsh plugin --profile dsh-tui add @banbolee/dsh-agents
```

### 1.2 覆盖子 Agent 模型

Web 设置卡或 `settings.yaml` 可以覆盖某个 Agent **作为子 Agent 被委派时**使用的模型：

```yaml
banbo-agents:
  agents:
    review:
      model:
        provider: deepseek
        model: deepseek-v4-pro
        reasoningEffort: high
```

生效边界：

- 新的子 Agent 委派：下一次调用立即读取最新设置；
- continuable 子 Agent：创建时的 route 写入官方 descriptor，后续恢复继续使用该 route；同时在 `$DSH_HOME/banbo-agents/.children/<childId>.json` 写入插件侧身份（11.1.1），恢复时用它确认业务身份后，再按**当前** catalog 判定后续委派授权；one-shot 子 Agent 不落盘，只在存活期间用进程内 live map 记录；
- 已发出的委派请求和已运行子 Agent：不改变；
- 主 Agent Session：v1 不读取这里的模型覆盖，始终使用官方 Session 模型选择器；
- 用户若想改变 Banbo / Planner 等主 Agent 模型，使用官方 Session 模型选择器。

### 1.3 关闭 Agent

```yaml
banbo-agents:
  includeDefaults: false
  agents:
    planner:
      enabled: true
```

含义：内置 Agent 默认全部关闭，但 Planner 单独开启；用户新增 Agent 默认开启。

关闭立即影响后续主 Agent 创建和后续委派，不终止已经运行的会话。picker 第一版保持静态；选择已禁用项时返回明确错误和修复路径。

### 1.4 自定义 Agent

用户在以下目录维护结构定义和 persona：

```text
$DSH_HOME/banbo-agents/
├── agents/
│   ├── my-research.yaml
│   └── planner.yaml
├── prompts/
│   └── my-research.md
└── .generated/           # 插件生成，用户不要手改
    ├── generations/
    │   └── <hash>/
    │       ├── presets/
    │       └── abi.json
    └── current -> generations/<hash>   # 指针，切换即生效
```

- 新 id：新增 Agent；
- 与内置 id 重名：按受约束规则覆盖；
- 带 `main` 配置：重启后出现在 picker；
- 带 `child` 配置：可被授权为具名 Agent 工具；
- 同时带 `main` 和 `child`：既能作主，也能作子。

---

## 2. 核心术语

### Agent 定义

一份静态产品定义，描述 id、模型、persona、普通工具和授权图。它不等同于一个正在运行的 Session。

### 主 Agent

由用户从 preset picker 选择的顶层 Agent。主 Agent 的 `main` 配置决定 preset id、主 persona、普通工具和整棵委派树的绝对深度上限。

### 子 Agent

由 `agent_<id>` 或 `delegate_batch` 创建的 Agent。子 Agent 的 `child` 配置决定 persona、普通工具、用途说明和是否支持 continuable。

### one-shot

执行**一个完整任务**后结束：期间可以有多个 step 与工具调用，结算后不保留可继续的会话。适合一次性调研、探索和无需追问的工作。（不是"只执行一次模型请求"——那是 step，不是 one-shot。）

### continuable

第一轮结束后保留持久 Session id；后续可以通过 `send_message` 冷恢复并继续。

### tool-limited

通过严格工具 allowlist 移除已知写工具和 shell。它降低误操作面，但不等于 OS/文件系统沙箱；新增工具不会自动获得授权。

---

## 3. 包和安装单元

### 3.1 单包

```text
plugins/agents → @banbolee/dsh-agents
```

一个包包含：

- Host catalog、settings、prompt loader、preset compiler；
- main runtime 和 delegation runtime；
- 内置 Agent 定义、prompts、preset 模板；
- Web settings client；
- 面向 Web `agent-presets` 与 dsh-tui `dsh-tui-agent-presets` 两个 roster seat 的同配置 Bundle patch。

2026-09-21 执行 `npm view @banbolee/dsh-agents name version --json` 返回 `E404 Not Found`，当前 registry 中没有该包；发布前仍需重新确认。命名必须继续使用 `@banbolee/dsh-<name>`，不得改为 unscoped 包。

### 3.2 Web 与 dsh-tui

Web 和 dsh-tui profile 安装同一个包。Gate B 已在本机 DSH `0.1.5-rc.2` / dsh-tui `0.10.2` 上确认：Web roster seat 的 id 是 `agent-presets`，TUI seat 的 id 是 `dsh-tui-agent-presets`，不能靠一条 id-target patch 同时覆盖。v1 采用用户确认的**双目标 patch**：同一 Bundle 对两个 seat 写入由一个 YAML anchor 生成的完整相同 config；每个 profile 命中自己的 seat，并对不存在的另一个 seat产生一条可预期的 Loader warning。该 warning 是 include patch 的公开语义，不影响命中 row 激活，也不被静默吞掉。

Gate B 已锁定：

- Web profile 的 row id 为 `agent-presets`，dsh-tui 0.10.2 的 row id 为 `dsh-tui-agent-presets`；
- 两个 target 的完整 config 来自同一个 YAML anchor，测试逐值比较以防漂移；
- Web/TUI 各自通过官方 `composeEntries()` 命中一个 seat，只产生一条 missing-sibling warning；
- TUI row 原有 `disabled` 让位表达式保持不变；卸载 Bundle（移除 overlay）后原始 row/config/disabled 全量恢复；
- 两端运行时都只有命中 seat 提供 `ctx.agentPresets`，最终 roots 顺序相同。

未来 Web/TUI 改 row id 视为 profile ABI 变更，由 Gate B fail-loud；届时再决定追加兼容 seat 或拆分 TUI adapter Bundle。

### 3.3 Manifest 基线

```json
{
  "name": "@banbolee/dsh-agents",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./main-runtime": "./main-runtime.js",
    "./delegation": "./delegation.js",
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "schema.js",
    "catalog.js",
    "prompt-loader.js",
    "preset-compiler.js",
    "main-runtime.js",
    "delegation.js",
    "cordis.patch.yml",
    "catalog",
    "presets",
    "prompts",
    "templates",
    "lib/catalog-remote.js",
    "lib/client.js",
    "lib/types",
    "README.md",
    "README.en.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-settings-plugins",
        "@deepseek-ai/dsh-api-remotes"
      ]
    }
  }
}
```

所有需要共享 runtime identity 的 DSH Service/registry 包必须使用 peerDependency + devDependency；依赖族统一遵守仓库的 `@deepseek-ai/* ^0.1.5-rc.1` 约定。若阶段 0 证明能力只存在于更高版本，先整体升级依赖族、测试断言和文档，不能混装 rc.1/rc.2。

**构建产物边界**：`index.js` / `main-runtime.js` / `delegation.js` / `catalog.js` / `prompt-loader.js` / `preset-compiler.js` 保持纯 JS（与仓库现有插件一致，无需构建）；**承载 Remote 与 Web client 的部分需要构建产物**（`lib/catalog-remote.js`、`lib/client.js` 与 `lib/types/**`），因为官方 Remote 依赖 TS decorator 元数据。具体是引入 TS 构建还是纯 JS 手工挂载 descriptor，由 Gate E 按 12.2 实测决定；无论哪条路线，`files` 白名单必须恰好覆盖**全部**构建产物（Host Remote 与 client 两者都不能漏），且 CI 必须断言打包后两边的 `remoteMethods()` 都返回预期 marker。

---

## 4. Agent 数据模型

### 4.1 唯一结构

```ts
type PromptRef = string

type ModelConfig =
  | { default: true }
  | {
      provider: string
      model: string
      reasoningEffort?: string
    }

type ToolCapability =
  | 'read'
  | 'search'
  | 'web'
  | 'exec'
  | 'write'
  | 'edit'
  | 'skill'
  | 'todo'
  | 'jobs'
  | 'ask-user'
  | 'goal'
  | 'present'
  | 'agent-control'

interface MainSessionBudget {
  maxConcurrentChildren: number       // 默认 6，clamp [1, 32]；按 root Session 整棵树统计同时运行的 child 轮次
  maxBatchWidth: number               // 默认 4，绝对上限 6；单次 delegate_batch 的 one-shot 上限
  foregroundDeadlineMs: number        // 默认 1800000（30 分钟），clamp [60000, 3600000]；单个前台委派的等待边界。§16.10：真实会话里"全文审查"跑满旧的 15 分钟上限且**零产出**，整轮作废，故与后台对齐到 30 分钟
  backgroundDeadlineMs: number        // 默认 1800000（30 分钟），clamp [60000, 7200000]；后台 one-shot 的等待边界
  batchDeadlineMs: number             // 默认 600000（10 分钟），clamp [60000, 1800000]；delegate_batch 的等待边界
  drainGraceMs: number                // 默认 30000，clamp [1000, 300000]；取消后等待收束、再移交 cleanup registry 的宽限
}

interface MainProfile {
  presetId: string
  persona: PromptRef
  tools: readonly ToolCapability[]
  extraTools?: readonly string[] // 第三方 runtime tool name，精确授权
  maxDepth: number // 从这个主 Agent 开始计算的官方绝对深度上限
  budget?: Partial<MainSessionBudget>
}

interface ChildProfile {
  model: ModelConfig // 仅用于作为子 Agent 被委派时；主 Agent 模型走官方 Session 模型选择器
  persona: PromptRef
  guidance: string
  tools: readonly ToolCapability[]
  extraTools?: readonly string[] // 第三方 runtime tool name，精确授权
  continuation: 'one-shot' | 'optional'
}

interface AgentDefinition {
  id: string
  displayName: string
  description: string

  // 主、子共用
  allowedChildren: readonly string[]

  // 存在即表示支持该运行形态
  main?: MainProfile
  child?: ChildProfile
}

interface RetiredToolShell {
  id: string
  toolName: string
  presetId?: string // 仅当该 Agent 曾有 main 形态
  retiredReason: 'definition-file-missing'
  authorized: false // 恒定 false：空壳永远不是授权候选
}
```

不保留 `identity: main | child | both`，避免 identity 与实际字段不一致。身份直接由 `main` / `child` 是否存在推导。

`RetiredToolShell` 不是第二份存储，而是 `AgentAbiRecord{retired:true}`（见 11.2）的**运行时投影**：

```text
AgentAbiRecord{retired: true, …}   唯一持久形态，写在 generations/<hash>/abi.json
        │  投影出工具定义所需的最小字段
        ▼
RetiredToolShell                    standing scope 里的空壳工具描述，不落盘
```

字段一一对应，不新增语义：`id` / `toolName` / `presetId` 直接来自 ABI 记录，`retiredReason` 来自 `AgentAbiRecord.retiredReason`，`authorized: false` 是投影时写入的常量。**两边不得出现同名不同义的字段**，ABI 记录里也不得再存第二份"空壳"。

`RetiredToolShell` 的作用**只有一个**：让曾经发布过的 `agent_<id>` 工具名继续存在于 managed standing scope，使旧 continuable child 冻结的 `toolFilter` 不会因为 `tools.restrict()` 遇到 unknown 名而抛错（该 API 对未知工具名是硬失败，不是警告）。它不参与能力合并、不出现在 picker、不作为授权候选、不能被 settings 重新启用。

术语区分（强制）：本节拒绝的是“用 `identity` 字段描述 main/child/both 形态”。§11.1.1 的身份记录（sidecar 文件 / live map）是**运行时 child 的业务身份**（哪个 AgentDefinition、属于哪棵树），与形态字段无关。两者不得共用同一个名字表达两件事；定义文件里不得出现 `identity` 字段。

### 4.2 为什么主/子配置分开

同一个 Planner：

- 作主时需要完整主 persona、picker preset 和顶层工具；
- 作子时需要精简 persona、用途说明和更窄工具面；
- 授权图共享，避免两份定义漂移；模型只属于子形态，主形态继续使用官方 Session 模型选择器。

### 4.3 模型 `default` 的精确定义

`{ default: true }` 表示子 Agent 委派时“不强制一条独立 route”：

- 子 Agent：不传 `agentOptions` route，使用官方语义继承调用者当前 route；
- 具体 route 必须完整配置 provider + model；
- 主 Agent：v1 不读取 Agent 定义里的模型配置，始终使用官方 Session 模型选择器。

### 4.4 校验规则

启动时必须一次性校验：

1. agent id 必须匹配 `^[a-z][a-z0-9-]{0,57}$`（最长 58 字符，给 `agent_` 前缀保留 64 字符工具名预算）；preset id 还必须通过目标 DSH 的 `PRESET_ID` 校验；
2. 工具名由 `agent_${id.replaceAll('-', '_')}` 生成，并在编码后再次检查全局唯一；
3. 每个 Agent 至少有 `main` 或 `child`；
4. `allowedChildren` 只引用存在且具有 `child` 的 Agent；
5. 授权图是 DAG，拒绝 A → B → A；
6. 每个 `main.maxDepth` 是非负安全整数；`main.budget` 字段若存在也必须是正安全整数，并满足 `1 <= maxConcurrentChildren <= 32`、`maxBatchWidth <= 6`；四个时间预算（`foregroundDeadlineMs` / `backgroundDeadlineMs` / `batchDeadlineMs` / `drainGraceMs`）必须是正安全整数且落在各自 clamp 区间内，非法值让 Host 启动失败；
   `maxConcurrentChildren <= 32` 是**护栏保真**要求，不是性能考虑：这个字段存在的唯一目的是约束宽度（见 10.3），允许配成 10000 等于让护栏消失，所以必须有绝对上限。32 已远高于任何真实委派宽度（`maxBatchWidth` 才 6）；确有更大需求时应当通过拆分主 preset 而不是放宽单棵树的宽度；
7. 从某主 Agent 可达的最长图路径可以超过 maxDepth；wrapper 在**每次**具名 Agent / batch 执行时按当前 `delegationDepth` 和当前主 preset `maxDepth` 重新校验，`remainingDepth <= 0` 即使旧 descriptor 仍显示该工具也要拒绝；**同一条 `remainingDepth > 0` 规则也作用于顶层主 Agent（它的 `delegationDepth` 为 0）**，因此 `maxDepth: 0` 的主 Agent 根本看不到任何 `agent_*` 与 `delegate_batch`，而不是"看得见但一调就失败"；创建新 child 时还从其 toolFilter 移除所有下一层 Agent 工具和 `delegate_batch`，官方 numeric cap 是最终强制边界；Web/README 展示该主 preset 的实际最大层数；
8. provider/model 必须成对且非空；reasoningEffort 若存在必须非空；
9. persona 路径和内容符合安全规则；
10. ToolCapability 能映射到目标 DSH 版本的真实工具；映射缺失时 fail-loud；
11. `extraTools` 中每个名字非空、不是保留的 `run_code` / `delegate_batch` / `agent_*`，也不在唯一 `FORBIDDEN_DELEGATION_TOOLS` 清单内，并且在目标 standing composition 中是可 restrict 的 global/ancestor tool；缺失时主 Agent 创建回滚；
12. preset id 不得与 shipped、官方 user root、包内其他 preset 或另一用户 Agent 冲突；
13. 内置 preset id 不可覆盖；用户 Agent 的已发布 preset id、toolName、已发布 main/child 形态和 child.continuation 写入 ABI manifest 后按兼容规则保护：允许新增缺失形态，禁止在文件仍存在时删除已发布形态或改变生命周期语义，破坏性修改必须换新 id；**整个定义文件被删除是唯一例外**，按 6.3 的删除语义处理（转 `RetiredToolShell` + 移除 generated preset）。

运行时 `enabled` 不参与图结构校验。被禁用 Agent 的稳定工具仍保留，调用时明确拒绝；这样重新启用不需要重启，也不会破坏旧 descriptor。

#### 4.4.1 资源上限（`CATALOG_LIMITS`）

上面 13 条是**语义**校验。语义全部合法、但规模失控的配置同样会让 Host 起不来，因此另有独立的资源上限。**超限一律让 Host 启动失败并指出文件与字段，不做截断**——截断会让用户以为配置生效了。

```ts
const CATALOG_LIMITS = {
  maxAgentCount: 128,                  // 用户 + 内置总数
  maxYamlBytes: 256 * 1024,            // 单个 YAML 文件
  maxAgentsDirBytes: 4 * 1024 * 1024,  // agents/ 目录总量
  maxPersonaTotalBytes: 1024 * 1024,   // 所有 persona 总量（见 6.2）
  maxAllowedChildren: 64,              // 单个 Agent 的出边数
  maxExtraTools: 64,                   // 单个 Agent 的 extraTools 数量
  maxGraphEdges: 1024,                 // 全图边数
  maxDisplayNameBytes: 128,
  maxDescriptionBytes: 512,
  maxGuidanceBytes: 2048,
}
```

每条上限的推导理由（**改这些数字前必须重新推导，不能拍脑袋调**）：

| 上限 | 依据 |
|---|---|
| `maxAgentCount: 128` | 每个 managed preset 的 standing scope 要注册**全部** ABI 工具名（含 `RetiredToolShell`），工具表长度与 Agent 数成正比；128 已远超任何真实团队规模 |
| `maxAllowedChildren: 64` | 单个 child 的 toolFilter 长度 ≈ 自身工具数 + 出边数；而 `maxBatchWidth` 才 6、`maxConcurrentChildren` 才 6，64 条出边不可能被有效利用 |
| `maxGraphEdges: 1024` | DAG 校验与 depth 计算是 O(V+E)；1024 条边保证毫秒级完成 |
| `maxDisplayNameBytes: 128` | Web 卡是单行显示，超出必然被截断，不如启动时拒绝 |
| `maxYamlBytes: 256 KiB` | 配合 6.1.1 的 `maxAliasCount: 100`，把展开后的最坏内存占用钉在有界范围 |
| `maxPersonaTotalBytes: 1 MiB` | persona 参与每次 system prompt 组装；单文件 64 KiB 挡不住"128 个文件各 64 KiB" |

**读取顺序强制**：字节数检查必须发生在解析之前（先 `stat`，再 `read`，再 `parse`）。先解析再检查大小等于把解析器本身暴露成攻击面。

---

## 5. 默认团队

### 5.1 授权矩阵

| Agent | 默认形态 | allowedChildren | 主 preset 深度 | 子会话模式 |
|---|---|---|---:|---|
| Banbo | main | Planner、Research、Explorer、Implement、Review、Executor | 2 | — |
| Planner | main + child | Research、Explorer、Review | 1 | optional |
| Executor | child | Research、Explorer、Implement、Review | — | optional |
| Implement | child | Research、Explorer | — | optional |
| Review | child | Research、Explorer | — | optional |
| Research | child | 无 | — | one-shot |
| Explorer | child | 无 | — | one-shot |

说明：

- `maxDepth` 属于主 preset，不属于每个中间 Agent；
- Banbo 的 cap 2 允许 Banbo → Executor → Implement；Implement 此时不能继续到第三层；
- Planner 作主的 cap 1 只允许一层子 Agent；
- 用户新增主 Agent 时自行指定整棵树 cap；
- 所有具名委派工具必须使用该主 preset 的同一个绝对 cap；不允许某一条边偷偷使用更宽的 `provider-managed`。

### 5.2 默认普通工具

主 Agent 使用标准 coding 能力，但在 DSH 工具注册表层面只暴露本团队的具名委派入口，不暴露官方通用创建入口。唯一 `FORBIDDEN_DELEGATION_TOOLS` 清单包含目标 DSH 版本中 `subagent`、`subagent_fork`、`workflow`、`ralph` 的全部真实 runtime tool names；catalog validator、preset 模板和 `extraTools` 共用这份清单，不允许各写一份。

这只是 **tool-surface control**，不是全局安全沙箱：如果某个主/子 Agent 被授予 `exec`、`web`、MCP 或第三方 `extraTools`，这些能力本身可能访问外部系统或启动别的进程。本插件不承诺阻止所有进程级、网络级或第三方工具级绕过；这些风险由普通工具白名单、profile sandbox、MCP 配置和用户信任边界承担。

子 Agent 使用显式 allowlist。建议基线：

| Agent | 普通工具能力 |
|---|---|
| Planner（子） | read、search、web、skill、todo、jobs、agent-control |
| Executor | read、search、web、exec、write、edit、skill、todo、jobs、agent-control |
| Implement | read、search、web、exec、write、edit、skill、todo、jobs、agent-control |
| Review | read、search、exec、skill、todo、jobs、agent-control |
| Research | read、search、web、skill、todo |
| Explorer | read、search、skill、todo |

规则：

- `goal`、`present` 只给主 Agent；
- 子 Agent 默认不直接 `ask-user`，问题发给父 Agent；
- `agent-control` 包含 `list_agents`、`send_message`、`interrupt_agent`；默认只给可能长期协作的 optional 子 Agent；Research / Explorer 固定 one-shot，默认不授予 agent-control，避免误导其尝试续聊或管理长期 child；
- Research / Explorer 没有 shell、write、edit，也没有 agent-control，因此是 tool-limited；
- Review 有 exec 用于测试和检查，不能称 read-only；
- `exec` 在目标 profile 中解析为实际可见 shell：优先 fish，否则 bash，否则 pwsh（Windows）；**恰好授予一个**（profile 同时注册多个 shell 不会因此放宽工具面）；一个都没有时，依赖它的 Agent 装配失败；
- allowlist 编译为真实 runtime tool names；新增 Host 工具不会自动获得授权；
- 高级用户可用 `extraTools` 精确授予 codegraph、MCP 等第三方最终 runtime tool name；只接受精确字符串，不支持 glob/前缀/别名；不得授予 `FORBIDDEN_DELEGATION_TOOLS` 中的 DSH 通用委派入口；按 profile 在主 Agent 创建时解析，缺失就回滚，不静默忽略；第三方工具后装或改名需要重启，第三方 schema、安全边界和外部副作用不属于本插件保证；
- PTC 的 `run_code` 是保留传输名，不直接进入 filter；过滤它调用的最终能力工具。

`allowedChildren` 是显式能力委派。子 Agent 的工具面由自己的定义决定，不是简单继承父 Agent 的 persona 或工具表。高级用户可以给 one-shot 自定义 Agent 显式加入 agent-control，但这不会把它变成 continuable；它仍然在本轮结束后 dispose，`send_message` 只能用于其可见的其他 continuable 关系。

### 5.3 内置 persona 规范

v1 不把完整 persona 正文写进本文，但必须固定默认 persona 的文件布局、必备段落和验收标准，避免阶段 3 写成一批风格不一、会越权或误用工具的 prompt。

包内默认 persona 文件位于发布包 `prompts/` 下，用户覆盖仍走 `$DSH_HOME/banbo-agents/prompts/`：

```text
prompts/
├── banbo-main.md
├── planner-main.md
├── planner-child.md
├── executor-child.md
├── implement-child.md
├── review-child.md
├── research-child.md
└── explorer-child.md
```

规则：

- 一个运行形态一份 persona；Planner 同时支持 main 和 child，因此有 `planner-main.md` 与 `planner-child.md`；
- persona 正文只描述角色、流程和输出契约，不写 provider/model，不写真实文件路径，不写不可验证的 sandbox 承诺；
- 包内 persona 也按 prompt loader 的 UTF-8、64 KiB、单换行和只读快照规则测试；
- 用户覆盖内置 persona 时仍必须通过 `persona` 字段显式指向 `$DSH_HOME/banbo-agents/prompts/*.md`，不能编辑包内文件。

每份内置 persona 必须包含以下稳定标题，顺序固定，便于测试和后续审阅：

```md
# Role
# Responsibilities
# Non-goals
# Tool Policy
# Delegation Policy
# Collaboration Protocol
# Output Contract
# Failure Policy
```

各段含义：

- `Role`：一句话说明该 Agent 是谁，不写营销话术；
- `Responsibilities`：列出负责事项，必须和默认工具面、授权图一致；
- `Non-goals`：列出不负责事项，防止 Review 抢实现、Research/Explorer 声称改代码；
- `Tool Policy`：说明何时使用自身可见普通工具；不得提到不可见工具；
- `Delegation Policy`：只有能看见 `agent_*` / `delegate_batch` 的主或 optional 子 Agent 才写具体委派策略；Research / Explorer 默认写“不可继续委派”；
- `Collaboration Protocol`：说明 `list_agents` / `send_message` / `interrupt_agent` 的正确用途；无 agent-control 的 Agent 明确不写这些工具名；
- `Output Contract`：规定最终回答/中间报告格式，必须短、可合并、带证据；
- `Failure Policy`：说明权限不足、并发超限、deadline、partial_timeout、空结果、不确定时如何返回，不编造执行结果。

主 Agent persona 额外必须写团队协议：

1. 先理解任务，再决定自己做、单个委派、batch 并行或复用 continuable；
2. 需要同一专家继续上下文时，先 `list_agents` 找 idle continuable child，再 `send_message`，不要重复新建；
3. `delegate_batch` 只用于相互独立、可并行的任务，**其中的 item 一律以 one-shot 执行、不支持保留会话**；deadline 到期后基于 partial result 继续，不把 `cancel_requested` / `cleanup_deferred` / timeout 当 completed；需要保留对话的委派一律用单个 `agent_<id>`；
4. 合并多 Agent 结果时按 childId 去重 direct message 与 settlement notice，不重复行动；
5. 并发超限时减少 batch、复用已有 child 或向用户解释下一步，不静默排队。

### 5.4 委派纪律（每一份能委派的 persona 都必须写）

§5.1 里**七个 Agent 中有五个能委派**，对应 **6 份 persona**：`banbo-main`、`planner-main`、`planner-child`、`executor-child`、`implement-child`、`review-child`。它们除了"找谁"，还必须写清"怎么派"。这些条款来自一次真实会话的失败复盘（§16.9）：协调者委派之后**自己把同一件事又做了一遍**、用 `list_agents` 盯梢、因为"跑太久"中断审查者，而一个因 provider 过载**已经死掉**的子 Agent 在 `ready` 状态上被忽略。

| 规则 | 内容 | 出处 |
|---|---|---|
| **D1 一事一主** | **同一件事只有一种做法：要么自己做完，要么派出去——不许既派出去、又自己再做一遍。** 派出去之后你的工作只剩：写清 prompt、等结果、判断、合并、汇报 | §16.9 现象 ① |
| **D2 本职定义** | 你的本职是子 Agent 做不了的事：跨结果判断、取舍、与用户沟通、给出最终结论 | 同上 |
| **D3 后台门槛** | `run_in_background: true` 的**唯一**理由是"我接下来要做的事与它完全无关"；**"我自己也把它做一遍"不算并行的理由** | §16.9 现象 ② |
| **D4 后台必须收割** | 用后台就必须在结束本轮前拿到结论，或明确说明为什么没拿到 | 同上 |
| **D5 禁止盯梢** | `list_agents` 只在"要复用某个 child 的上下文"时查一次，**不是进度轮询工具** | §16.9 现象 ③ |
| **D6 `ready` 语义** | `ready` 只说明对方本轮已结束——**可能成功、也可能失败或被中断**；**没收到结论就算没完成**：去要结果、重新委派，或明确说明没拿到。**不许静默跳过** | §16.9 现象 ④ |
| **D7 中断门槛** | 只有它明显跑偏、在重复无效操作、你已从别处拿到足够结论，或用户/父 Agent 要求停止时才中断；`interrupt_agent` 只是请求，**不当作硬杀** | §16.9 现象 ⑤ |
| **D8 时长不是理由** | **"跑得久"本身不是理由**：审查类任务通常需要**数分钟到十几分钟**，这是正常的 | 同上 |
| **D9 先问后断** | 中断前先 `send_message` 要一份"基于你已有证据的结论"，**并等它回复**；确认不需要了再中断。**发完消息等几秒、它还没回就中断，不算问过** | 同上 |
| **D10 中断要交代** | 中断之后必须说明哪部分没查完 | 同上 |
| **D11 不喂结论** | 委派给 `agent_review` 时**不要把自己的结论写进 prompt**；让它从原始材料（diff、文件、命令输出）独立判断；要验证假设就写成**待验证的问题**，而不是"我已确认 X"。喂结论只会换来一个橡皮图章 | §16.9 现象 ⑥ |

**适用范围**：D1–D10 对**所有** 6 份可委派 persona 生效（措辞按主/子调整：主 Agent 对用户负责，子 Agent 把结论写进最终回答交给父 Agent）。**D11 只对能委派 `agent_review` 的 4 份生效**（`banbo-main`、`planner-main`、`planner-child`、`executor-child`）——`implement` 与 `review` 的 `allowedChildren` 里没有 review。

**D5–D10 在四份 continuable 子 persona 中必须是逐字节一致的共享段落**（各自只保留一句角色相关的 lead-in），由既有测试锁住，避免只改一份而让某个 Agent 学到不同协议。

**lint**：`builtin-catalog.spec.ts` 逐条断言上述关键词出现在每一份适用 persona 中，并断言覆盖面（≥6 份、D11 恰好 4 份）。规则被删掉会红，不会静默消失。

子 Agent persona 最小职责边界：
| Agent | persona 边界 |
|---|---|
| Planner（child） | 拆解任务、识别风险、给执行计划；不直接大规模改代码 |
| Executor | 执行命令、验证、做明确的小范围机械修改；报告命令/结果/失败原因 |
| Implement | 做聚焦代码修改；不擅自扩大范围；修改后说明变更点和待验证项 |
| Review | 审查风险、正确性、测试覆盖和设计缺口；默认不抢实现 |
| Research | 查资料/外部信息/方案背景；不声称本地代码已修改 |
| Explorer | 阅读和搜索本地代码结构；不修改文件，不声称运行了 shell |

persona 禁止承诺工具层做不到的事：

- 不写“独立 sandbox / read-only 文件系统 / 可硬杀任意进程”；
- 不写“settlement notice 一定已被父模型消费”；
- 不写“主 Agent 可由本插件指定模型”；
- 不写“禁用 Agent 会立即从 picker 消失”；
- 不写“deadline 会硬杀同进程代码”。

验收标准：

- 每个内置 persona 文件都包含固定标题，且没有禁止短语；
- persona 中出现的工具名必须是该 Agent 默认可见工具或主 Agent 具名委派工具；
- Research / Explorer persona 不出现 `send_message`、`list_agents`、`interrupt_agent`、shell、write/edit 承诺；
- 主 persona 覆盖复用 continuable、batch deadline、并发超限和去重协议；
- README 只展示简短节选和覆盖方法，不复制完整 persona 正文。

---

## 6. 用户定义与合并

### 6.1 文件格式

```yaml
# $DSH_HOME/banbo-agents/agents/my-research.yaml
id: my-research
displayName: My Research
description: 针对内部资料做一次性调研
allowedChildren: []

child:
  model:
    default: true
  persona: prompts/my-research.md
  guidance: 当任务需要检索和归纳资料、且不需要修改代码时使用。
  tools: [read, search, web, skill, todo]
  continuation: one-shot
```

自定义主 Agent：

```yaml
# $DSH_HOME/banbo-agents/agents/my-lead.yaml
id: my-lead
displayName: My Lead
description: 我的项目协调 Agent
allowedChildren: [my-research, implement, review]

main:
  presetId: my-lead
  persona: prompts/my-lead-main.md
  tools: [read, search, web, exec, write, edit, skill, todo, jobs, ask-user, goal, present, agent-control]
  maxDepth: 2

child:
  model:
    default: true
  persona: prompts/my-lead-child.md
  guidance: 需要持续协调一个子项目时使用。
  tools: [read, search, web, skill, todo, jobs, agent-control]
  continuation: optional
```

### 6.1.1 YAML 解析约束（安全边界，不是风格选择）

用户 YAML 是**不可信输入**（可能由用户手写，也可能由某个 Agent 代写）。解析必须显式收紧，不能依赖库的宽松默认值。

使用仓库既有的 `yaml`（eemeli，`^2.8.0`，与 `plugins/codegraph-mcp` 一致）：

```ts
import { parse } from 'yaml'

const doc = parse(text, {
  version: '1.2',
  schema: 'core',          // 只接受 YAML 1.2 core 标量：str/int/float/bool/null
  merge: false,            // 显式关闭 `<<` 合并键（1.2 默认即 false，此处显式声明并被测试锁定）
  uniqueKeys: true,        // 重复 key 报错（默认已是 true，显式声明）
  maxAliasCount: 100,      // 允许取值复用，同时挡住嵌套 alias bomb
  customTags: [],          // 不接受任何自定义 tag
  resolveKnownTags: false, // 拒绝 !!binary !!omap !!pairs !!set !!timestamp
})
```

逐项作用：

| 选项 | 挡住什么 |
|---|---|
| `schema: 'core'` | 非 JSON 形状的标量类型 |
| `merge: false` | `<<` 合并键：与本插件 6.3 自有的合并语义叠加会造成"哪个先生效"的歧义 |
| `uniqueKeys: true` | 重复 key 静默取最后一个值 |
| `maxAliasCount: 100` | 指数级 alias 展开（billion laughs）。**不用 `0`**：那会连 `tools: *commonTags` 这类正常取值复用一起禁掉 |
| `customTags: []` | 任何第三方 tag |
| `resolveKnownTags: false` | `!!timestamp` 等 YAML 1.1 显式 tag；且 Date 不是无损 JSON，会污染后续 descriptor/identity |

**明确不受影响的三种"引用"**（避免误伤）：

1. `cordis.patch.yml` 里的 `!!js new URL(...)` / `dshHomePath(...)` —— 由 **Cordis loader 自己的解析器**处理，与本节无关；`!!js` 不是标准 YAML tag，本节任何配置都不可能让它在我们这里执行；
2. 取值复用 `commonTools: &t [...]` + `tools: *t` —— alias 是语法特性，`schema: 'core'` 不影响它，`maxAliasCount: 100` 也允许它；
3. `persona: prompts/my-research.md` —— 普通字符串字段，文件解析与 realpath 校验由 6.2 的 loader 负责。

**`<<` 必须给专门错误**，否则用户看到"unknown field `<<`"、而旁边的 `*t` 又能用，会非常困惑：

```text
banbo-agents: 不支持 YAML 合并键 `<<`（agents/my-a.yaml:7）；
修复：把要复用的字段直接写全，或用 `*别名` 做取值复用
```

**未知字段一律拒绝**（不是忽略）：`<<`、拼错的字段名、未来版本新增的字段都应显式报错，并指出文件、行号和字段名。静默忽略会让用户以为配置生效了。

读取顺序：**先做字节数检查，再解析**。不能先解析再检查大小，否则解析本身就是攻击面。

### 6.2 persona 路径

路径统一相对于 `$DSH_HOME/banbo-agents/`：

```yaml
persona: prompts/my-research.md
```

约束：

- 必须是 UTF-8 Markdown；
- 单文件最大 64 KiB；
- 结尾规范化为恰好一个换行；
- 禁止绝对路径；
- 禁止 canonical realpath 越出 `prompts/`；
- symlink 最终目标也必须位于 `prompts/`；
- 启动时读取为不可变快照，运行中不重新读取；
- **所有 persona 文件总量 ≤ 1 MiB**：单文件上限不够，因为 128 个 Agent × 64 KiB 会带来 8 MiB 常驻内存并参与每次 system prompt 组装。超限时 Host 启动失败并列出占用最大的文件。

### 6.3 受约束字段覆盖

有效 catalog 的合并顺序：

```text
包内默认 Agent
→ 用户 YAML（启动时）
→ settings 的 enabled / child.model 覆盖（按后续操作读取）
```

同 id 覆盖规则：

- 标量字段：用户值替换；
- `allowedChildren`、`tools`、`extraTools`：整个数组替换，不做追加；
- `child.model`：整个对象替换；主形态没有本插件模型字段；
- 已存在的 `main` / `child`：内部按字段覆盖；原定义没有该槽位时，新增槽位必须提供完整对象；
- 不支持 `null` 或隐式 delete；
- 内置已发布 id 和已经发布的 main/child 形态不可通过覆盖规则删除；用户删除已发布定义文件是允许的，但后果是**退役**（见下一条），不是 ABI 层面的"占位保留"。**"不可逆"指的是这个 id 的 ABI 身份**：它的 `toolName` 与 `presetId` 一旦发布就固定，永远不会被回收给另一个 Agent；`retired: true` 标记本身只在定义缺失期间存在——把定义文件放回去会让这个 id 复活（§12.1），那时该记录被重新计算成一条正常记录（`computeAbiManifest` 让新记录胜出），复活后的定义仍受下面所有收窄检查约束；
- 可以给原本 child-only 的内置 Agent 新增 `main`，或给 main-only Agent 新增 `child`；
- v1 的 settings `enabled` 作用于整个 Agent，不支持 main/child 分别启停；一个 both Agent 开启时，主形态可选、子形态在被授权时可委派；若只想停止某条委派，修改父方 `allowedChildren` 并重启；独立形态开关留待后续 schema 版本；
- 新 id 必须给出一份可独立校验的完整定义；
- **删除语义（v1）**：删除用户 Agent 定义文件后，重启时
  1. 从 active catalog 移除该 Agent：不再是授权候选、不再出现在 picker、settings 中的历史条目被强制忽略；
  2. 若它有 `main` 形态，同时删除它的 generated preset 目录。该 preset 的旧主 Session 在恢复时被官方 preset 解析拒绝（`agent-preset/not-found`），**其下所有 continuable child 一并不可恢复**（冷恢复需要活着的直接父 Session）；
  3. 若它曾有 `child` 形态，在 managed standing scope 继续注册 `agent_<id>` 空壳（`RetiredToolShell`），调用时返回“该 Agent 的定义已被删除；修复：重新提供 YAML 并重启”。这是**唯一**的保留项，纯粹为了让旧 continuable child 的冻结 `toolFilter` 不触发 `tools.restrict()` 的 unknown-name 硬失败；
  4. 不做 picker 占位、不做回退到默认 Agent、不改写任何历史 Session 的已记录 preset；
- 想停用但保留可恢复性，用 `enabled: false`，不要删文件；README 必须把这条写成推荐做法；
- v1 不实现 prune/migration：删除后 ABI 里的工具名与 preset id 永不回收，破坏性演进一律新增版本化 id；
- 已发布 Agent 的 ABI shape 不允许破坏性修改：不能删 main/child 形态，不能改 presetId/toolName，不能在 `one-shot` 与 `optional` 之间切换 continuation；需要新行为时新增版本化 id。

局部覆盖示例：`planner.yaml` 只写 `child.tools: [read, search, web, agent-control]` 时，Planner 原有 `child.persona`、`guidance`、`continuation` 和整个 `main` 均继承；若给原本 child-only 的 Implement 新增 `main`，则 `presetId/persona/tools/maxDepth` 必须一次给全。

### 6.4 生效时机

| 变化 | 生效时机 |
|---|---|
| 用户 YAML、persona、授权图、工具表、main/child 形态 | 重启后影响新主 Session、新 child、以及冷恢复后的旧主 Session；旧 continuable child 的 persona/toolFilter/route 保持创建快照 |
| 新增主 Agent picker 项 | 重启 |
| 删除有 `main` 形态的用户 Agent 定义 | 重启后 preset 目录一并删除；picker 干净消失；该主 Agent 的旧 Session 官方解析失败，其整棵子树不可恢复 |
| 删除纯 `child` 形态的用户 Agent 定义 | 重启后从授权候选消失；`agent_<id>` 保留为空壳，仅保证旧 child 的冻结 toolFilter 不硬失败 |
| 停用已发布主 Agent | settings 生效，但 picker 项保留并在选择时拒绝 |
| enabled | 后续主 Agent 创建 / 后续委派 |
| 子 Agent 模型覆盖 | 下一次委派 |
| 主 Agent 模型 | v1 不由本插件覆盖；使用官方 Session 模型选择器 |
| 已运行 Session | 不自动重装或中断 |

文档不得再笼统宣传“全部热生效”。准确说法是：**settings 影响后续动作；结构文件重启生效。**

---

## 7. Settings 模型

```ts
interface BanboAgentsSettings {
  includeDefaults?: boolean // 默认 true
  agents?: Record<string, {
    enabled?: boolean
    model?: ModelConfig // 仅覆盖该 Agent 作为 child 被委派时的 route
  }>
}
```

### 7.1 启用规则

```text
内置 Agent：agents[id].enabled ?? includeDefaults ?? true
用户新增 Agent：agents[id].enabled ?? true
```

- `includeDefaults: false` 不删除 preset 或工具，只改变是否允许后续使用；
- `agents.<id>.enabled: true` 可单独重新开启内置 Agent 或存在完整定义的用户 Agent；**已删除定义的 Agent 不能靠 settings 复活**，必须重新提供 YAML 并重启；settings 中残留的已删除 id 条目保留但被强制忽略（effectiveEnabled=false、model=undefined），并写 Host warning，而不是让 Host ready 失败；
- 禁用主 Agent：新的 Session 在同步首轮前激活门中拒绝，并由官方创建链回滚已进入 registry 的临时对象；给出启用路径；
- 禁用子 Agent：具名工具仍存在，但执行立即拒绝；
- 已运行 Agent 不强制终止；
- picker 第一版不随 settings 动态增删。

### 7.2 Settings 生命周期与模型规则

插件直接用官方 `ctx.settings.register('banbo-agents', Schema, { base, validate })`，不自造第二套保存层或 last-good store：

1. `base` 提供 `includeDefaults: true` 和空 overrides；schema 用 record 校验通用 JSON 形状；
2. owner `validate(resolved)` 按 startup catalog 校验未知 agent id、只有具备 `child` 形态且定义仍存在的 Agent 才能配置 model、provider/model 配对和跨字段规则；已删除 Agent 的历史 settings 条目允许保留但运行时强制 ignored，避免删除 YAML 后因为旧 settings 把 Host 卡死；
3. Web 通过官方 settings revision API 写入并携带 `expectedRevision`；候选值经 schema + owner validate 后才持久化、commit 和触发 `settings/updated`；失败直接返回 Web，不出现“UI 显示已保存、runtime 没采用”；
4. 外部文件编辑由官方 provider watcher 重载；合法值 commit；非法值会先换入 provider 的 raw document，但该 namespace 的 resolved `value` 与 revision 保持 last-good，不触发 `settings/updated` / `settings/document-updated` 并记录 Host warning；`describe().user` 在 schema-invalid 时可能缺失、在 owner-validate-invalid 时可能来自当前非法 raw section，所以 Web 只把 `value` 当运行中权威值，不把 `user` 当 last-good，也不虚构官方 descriptor 没有的错误状态；
5. 注册时已有非法 section 会让 namespace 注册和 Host ready 失败；重启不会带着未知 last-good 猜测继续；
6. SettingsView 只是对 `scope.get()` / descriptor 的薄只读封装，不拥有独立状态。

模型规则：

- `model: { default: true }` 恢复子 Agent 默认/继承语义；
- 具体 route 必须完整给 provider + model；
- model 只作用于具备 `child` 形态的 Agent；对 main-only Agent 配置 model 会被 owner validate 拒绝；
- 模型目录或 Provider 错误在下一次真正需要该 route 时、创建任何 child 之前 fail-loud；
- Host 启动可对文件中固定 child route 做预检，但不能把外部 Provider 暂时不可用变成静默模型替换；
- `modelSelectionSettings` 固定为 false；LLM 调用具名子 Agent 时不能自行填写 provider/model；
- 主 Agent 模型不走本 namespace，完全由官方 Session 模型选择器负责。

### 7.3 主 Agent 与官方模型选择器

API Session Controller 已经安装并拥有官方 Session 模型选择器。已核对的 rc.2 公共面以及仓库当前 rc.1 类型中，均没有“按 preset/Agent 提供主 Session 默认模型”的公开 seam：`SessionCreateRequest` 只有 workspace/cwd/sessionId/agentPreset；当前 model selector 的优先级是 pending `model/selection` → 历史 request header → deployment-wide `agentDefaultModel`。

因此 v1 明确不实现主 Agent 模型覆盖：

1. Banbo、Planner 或用户新增 main Agent 作为主 Session 启动时，模型完全由官方 Session 模型选择器决定；
2. 本插件不调用第二次 `installModelSelection()`，不另挂 `agent/request` / `system-prompt/assemble` 路由 listener，不直接 append `model/selection`，也不竞态调用 `sessionController.selectModel()`；
3. settings 中的 `agents.<id>.model` 只用于该 Agent 作为 child 被 `agent_<id>` / `delegate_batch` 委派时的 route；
4. Web 必须把 main-only Agent 的模型编辑置灰并说明“主 Agent 模型请使用官方 Session 模型选择器”；
5. 如果未来 DSH 官方提供 per-preset session default model seam，再以 schema 版本升级方式增加主形态模型覆盖，不在 v1 内伪造。

---

## 8. Preset 分发与编译

### 8.1 两类 preset root

1. 包内 `presets/`：内置主 Agent，trust = system；
2. `$DSH_HOME/banbo-agents/.generated/current/presets/`：用户新增主 Agent 的受控编译产物，trust = system；root 路径固定且永远有效，实际内容由 `current` 指针决定（见 8.6）。

这两个 root 不是通过 `package.json.dsh.configTrees` 自动进入运行时；`configTrees` 只属于 deployment-image packer 语义，不能当插件安装后的 picker 注册入口。v1 必须通过本 Bundle 的 `cordis.patch.yml` 整体覆盖官方 `agent-presets` row，并用 Cordis `!!js` 表达式解析路径：包内 root 通过 profile `baseUrl` 下的 installed package 路径定位，generated root 通过官方注入的 `dshHomePath()` 定位。

generated root 采用**不可变 generation + 稳定指针**：`current` 之外的目录写完即不可变，切换只替换一个 symlink。用户只编辑 `agents/*.yaml` 和 `prompts/*.md`。generated root 标为 system 不是把源配置冒充内置内容，而是防止官方 preset authoring 把它选成第一个可写 user root；Web 仍通过 CatalogRemote 把来源展示为 user file。

**generated root 是当前 catalog 的完整镜像，不是增量累积**：每一代只包含当前仍有 `main` 形态的用户 Agent。上一代存在、本代已删除的 preset 目录**不会**出现在新 generation 中（这实现了 6.3 的"删除即删除"）。generation 目录里任何"历史保留"都是 bug，不是兼容性。

### 8.2 为什么要编译用户主 Agent

DSH picker 识别的是官方 preset 目录，不识别本插件 YAML。包内已存在的主 preset（如 Banbo、Planner）只由 MainRuntime 读取合并后的定义，不重复生成；只有有效 `main.presetId` 不在包内 preset manifest 中时，PresetCompiler 才转换为：

```text
.generated/current/presets/<preset-id>/
├── preset.yml
└── agent.cordis.yml
```

生成的 `agent.cordis.yml` 来自包内固定模板，并用安全 YAML emitter 序列化，只允许填入经过校验的 agent id、显示信息和本包插件配置。用户 YAML 不能注入任意 Cordis plugin 名、`!!js` 或文件路径。

### 8.3 Preset 组成

**当前 rc.2 源码证据**没有“继承 standard 再 patch”的 preset 语法；Gate B 必须在仓库实际解析的 rc.1 包上复核。验证成立时，包内模板维护一份与目标 DSH 版本兼容的完整 composition：

- standard 普通工具行；
- 按唯一 `FORBIDDEN_DELEGATION_TOOLS` 收敛 DSH 工具面，去掉官方通用 subagent/subagent_fork/workflow/ralph 创建入口；
- 加入 `@banbolee/dsh-agents/main-runtime`；
- 加入 `@banbolee/dsh-agents/delegation`；
- preset runtime 按 agent id 读取有效定义，只安装主 persona、工具策略和具名 Agent 工具；不安装或修正主 Agent 模型 route。

每次升级 DSH 必须对照新版 standard preset 做契约差异检查。**"检查"必须是机器可执行的，不能只写在文档里**：

```text
templates/dsh-standard-inventory.json
  记录生成当前模板时的：
  - dshVersion          依赖族版本（如 0.1.5-rc.1）
  - standardDigest      官方 standard composition 规范化后的摘要
  - rows[]              每个 row 的 { id, name, isolate?, config?, disabled? }
  - tools[]             该 composition 暴露的最终 runtime tool 名清单
```

CI 门禁（属于平台探针，放 `agents:gates` lane）：

1. 读取当前依赖族里 `@deepseek-ai/dsh-agent-presets` 的 `presets/standard/agent.cordis.yml`，按同一规则算 digest；
2. 与 `dsh-standard-inventory.json` 比对，**任何 row 的增删、改名、`isolate` realm 变化或 config 变化都 fail**，并把差异逐条打印；
3. 只有人工确认差异并更新 inventory 之后才能通过；`tools[]` 与模板实际暴露的工具名也必须一致。

理由：包内模板是 standard 的**完整副本**，DSH 侧任何一次 standard 变更（新增工具、realm 调整、row 改名）都会让我们的副本静默过期——过期后不是报错，而是"少了一个官方新工具"或"多了一个已删除的工具"，属于最难发现的一类漂移。锁定 digest 把它变成一次显式的、必须在 PR 里处理的差异。

### 8.4 Roster patch

`AgentPresets` roots 在构造时固定，但 `list()` / `resolve()` 每次重新扫描目录。因此 patch 只需提供两个稳定 root 路径，PresetCompiler 在 Host ready 前生成用户目录。

Patch 必须完整保留：

- `default: standard`；
- `includeShippedRoot: true`；
- `includeUserRoot: true`；
- 包内 root；
- generated root。

目标 patch 形态（两个 target 共用同一 config anchor）必须类似：

```yaml
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config: &banbo-agent-presets-config
    default: standard
    includeShippedRoot: true
    includeUserRoot: true
    roots:
      - path: !!js process.getBuiltinModule('node:url').fileURLToPath(new URL('node_modules/@banbolee/dsh-agents/presets/', baseUrl))
        trust: system
      - path: !!js dshHomePath('banbo-agents', '.generated', 'current', 'presets')
        trust: system

- id: dsh-tui-agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config: *banbo-agent-presets-config
```

必须使用 `fileURLToPath()`，不能读取 URL `.pathname`：后者在含空格的 profile 路径中保留 `%20`，在 Windows 还会产生 `/C:/...`。generated root 的路径常量包含 `current` 指针（8.6）：字符串固定不变，实际内容随指针切换，因此**不需要**在每次重新生成后改动 patch 或重启才能生效。

Gate B 已用官方 `composeEntries()`、真实 Web/TUI profile dump 和官方 `AgentPresets` 构造器证明：`ctx.agentPresets.roots` 依次包含 official shipped root、包内 root、generated root 和 official user root；`baseUrl/node_modules` 在两端成立，且无运行时 monkey-patch。

Cordis patch 对 config 是整对象替换，不是深合并。v1 明确把当前 profile 的 roster seat 当作独占集成点：

- 安装另一个覆盖同一 Web/TUI seat 的 Bundle 可能互相覆盖；
- Host 启动时检查自己的两个 root 都出现在 `ctx.agentPresets.roots`，否则 fail-loud；
- README 明确“不兼容另一个 roster-owner Bundle，除非手动合并 roots”；
- 双目标 patch 在每个 profile 会对不存在的 sibling seat 产生一条可预期 Loader warning；不静默吃掉 warning 或别人的 roots；Gate B 记录 Web 和 TUI 原始完整 config。

### 8.5 Preset id 冲突

扫描所有 root 后，任何重复 preset id 都作为配置错误处理，即使 DSH 默认采用 first-root-wins。错误必须列出两个来源路径，禁止静默遮蔽。

唯一例外是 8.7 的指针降级方案：当且仅当两个 generated root 中存在一个**已被 `current` 标记为失效**的 generation 时，该代不参与冲突检测。除此之外不存在例外。

### 8.6 生成时序：不可变 generation + 稳定指针

**为什么不能"原子替换固定目录"**：Node 没有"交换两个非空目录"的原语。`fs.rename(target, ...)` 在目标非空时于 POSIX 报 `ENOTEMPTY`、Windows 报 `EPERM`。若采用"删掉旧目录再改名"的写法，中间会出现一个 `presets/` 不存在的窗口：另一个共享同一 DSH home 的进程正好扫 roster 就会看不到任何用户主 Agent，而改名失败会让路径永久损坏。因此 v1 不使用目录交换。

**目录结构**：

```text
$DSH_HOME/banbo-agents/.generated/
├── generations/
│   ├── <hash-a>/            # 不可变；写完不再修改
│   │   ├── presets/
│   │   │   ├── my-lead/
│   │   │   └── my-other/
│   │   └── abi.json
│   └── <hash-b>/
│       ├── presets/
│       └── abi.json
└── current                  # 唯一可变项：指向某个 generation 的 symlink
```

generated root 的路径常量因此是 `.generated/current/presets`：字符串固定、永远存在、永远指向一个完整 generation。

**激活**：

```js
await fs.symlink(genPath, tmpLink)   // 先写临时链接
await fs.rename(tmpLink, currentLink) // 覆盖 current：POSIX 下原子
```

**生成流程**：

1. Host catalog init 阶段完成用户文件加载、合并与校验；
2. 计算 generation hash（输入见下），若 `generations/<hash>/abi.json` 已存在且校验通过 → **直接复用，不写盘**；
3. 否则写入 `generations/<hash>/` 全新目录：先写 presets 与 `abi.json`，全部落盘后再写一个 `complete` 标记文件；
4. 通过 `complete` 标记判定该 generation 完整；缺少标记的目录视为半成品，永不激活，启动时清理；
5. 原子替换 `current` 指向新 generation；
6. 切换成功后，删除除 `current` 与最近 1 个（用于回滚）之外的 generation；删除失败只记 warning。

**generation hash 输入**（任一变化都必须产生新 generation）：规范化后的有效 catalog（含每个 Agent 的 ABI shape 与 `RetiredToolShell` 记录）、包内 preset 模板字节、`@banbolee/dsh-agents` 自身版本、目标 DSH 依赖族版本。**不包含**宿主绝对路径与用户名，避免同一配置在不同机器上产生不同 hash。

**为什么不再需要跨进程锁**：

- 写新 generation 是互不干扰的（不同 hash 落在不同目录），两个进程同时写同一 hash 也会写出相同内容；
- 唯一需要串行的动作是替换 `current`，而 symlink 覆盖 rename 本身是原子的；
- 半成品由 `complete` 标记识别，不依赖锁或 stale-lock 恢复。

因此原草案的"有界跨进程锁 + 锁内重读源文件 hash + 崩溃恢复状态机"整体删除。

**崩溃语义**：

| 崩溃位置 | 后果 |
|---|---|
| 写 generation 中途 | `complete` 标记不存在 → 该目录永不激活；`current` 仍指旧代；启动时清理残留 |
| 替换 `current` 前 | 旧代继续有效，行为同上一行 |
| 替换 `current` 中 | `rename` 原子：要么旧代要么新代，不存在"两者都不"或"半残" |
| 切换后清理旧代时 | 只影响磁盘占用，不影响运行 |

**启动要求**：

1. Web/TUI 第一次请求 roster 前 Host 已 ready 并完成 generation 准备；
2. 即使 roster 服务先构造，官方 unmemoized scan 仍能看到 `current/presets` 下的内容；
3. compiler 只管理 `.generated/` 下带自身 `complete` 标记的内容；目录权限 0700、文件 0600；不跟随用户放入其中的 symlink；不删除没有本插件标记的目录；
4. `current` 缺失（首次启动）时，必须**先建立它再让 Host ready**；建立失败则 Host 启动失败并给出明确路径。

**删除语义的落地**：删除一个有 `main` 形态的 Agent 会改变 catalog → 产生新 hash → 新 generation 的 `presets/` 里没有它。旧 generation 目录不会被修改，因此**在旧进程中运行的 Session 完全不受影响**；新进程只看到新 generation。原草案第 8 条要求的"MainRuntime 校验 active generation 并拒绝 stale preset"因此**不再需要**，运行时少一条 fail-closed 分支。

### 8.7 指针机制的降级顺序

Gate B 必须在真实 Web/TUI profile 上实测下列顺序，取第一个可用的：

1. **symlink**（首选）：POSIX 原生；Windows 需要开发者模式或管理员权限；
2. **junction**（Windows 目录联接）：不需要管理员权限，只能指向目录 —— 正好符合需求；
3. **双路径根 + 失效标记**（最后手段）：`roots` 同时挂 `.generated/current-a/presets` 与 `.generated/current-b/presets`，用标记文件决定哪一代有效。

第 3 条会让两个 root 在同一个 roster 里并存，因此必须同步 8.5 的冲突规则：**同一 preset id 若只出现在被标记为失效的那一代，忽略而不报错**。这是 8.5 唯一允许的例外，并且只在降级到第 3 条时生效。

若三条都不可用，**停止实现并回到本方案**：固定路径 + 原子切换在目标平台不成立，整个 generated root 设计需要重做。不得用"先删后改名"的写法绕过。

**实现状态（如实记录）**：

- **第 1 层 symlink：已实现并实测**（macOS，Gate B + `preset-compiler.spec.ts` 的 POSIX 指针探针）；
- **第 2 层 junction：已实现**（`createPointerLink` 在 symlink 报 `EPERM/ENOTSUP/ENOSYS/EACCES` 时改用 `symlinkSync(generationDir, temp, 'junction')`，junction 存绝对目标，故传入已解析的 generation 目录）；由 Windows CI job `agents-windows` 中的 Windows-only 探针验证，macOS 上该探针**跳过而非假装通过**；
- **第 3 层（双路径根 + 失效标记）：经用户决策不实现**。理由与代价已在评审中说明：它会让两个 root 在同一个 roster 里并存，需要同步改 §8.5 冲突规则（即给"重复 id 一律报错"这条安全保证开例外）与 `cordis.patch.yml` 的 roots 组成——而那份组成正是 Gate B 已实测的对象。在 Windows 上 junction 无需管理员权限且 NTFS 均支持，POSIX 上 symlink 恒可用，因此第 3 层在实践中不可达。当第 1、2 层都失败时，实现选择 **fail-loud 报错并保留旧指针**，绝不静默降级。
  **用户已确认此取舍（保持现状）**：不做第 3 层。若将来确有平台同时缺少 symlink 与 junction，需先回到本节重新设计、重跑 Gate B，并重新评估 §8.5 例外带来的风险，而不是就地补一个降级。

---

## 9. 运行时架构

### 9.1 组件

```text
BanboAgentsService（Cordis service key：banboAgents）
├── CatalogLoader        # 默认定义 + 用户定义 + prompts
├── CatalogValidator     # id / graph / tools / models / paths
├── PresetCompiler       # 用户 main → 官方 preset 目录
├── SettingsView         # 对官方 settings scope/descriptor 的薄只读封装
└── CatalogRemote        # Web 只读展示 startup catalog（独立 service key：banboAgentsCatalog，模块 lib/catalog-remote.js，见 12.2）

MainRuntime（每个主 preset standing scope）
├── 同步首轮前激活门（agent/created 内只做同步装配）
├── 顶层 Agent enable gate
├── 主 persona
├── 主普通工具 restriction
└── 安装后可见工具自检

DelegationRuntime（每个主 preset standing scope）
├── 稳定 agent_<id> 工具
├── delegateOne()
├── delegate_batch（item 一律 one-shot）
├── 固定绝对 maxDepth
├── child identity 读写（11.1.1：continuable 写 sidecar 文件 / one-shot 走 live map）
├── HolderRegistry（10.8：超时/取消后未收束资源的唯一 owner）
└── presetId → mainAgentId 映射 fail-closed guard（generation 仅作诊断字段，不参与判定，见 11.1.1）
```

### 9.2 启动流程

```text
Host 启动
→ 读取包内 catalog
→ 读取用户 YAML / Markdown
→ 受约束合并
→ 校验 Agent DAG、工具映射、prompt 和 preset id
→ 生成/复用不可变 generation 并原子切换 current 指针
→ 注册 settings 和只读 catalog Remote
→ Host ready
```

异步文件读取和生成必须在 Cordis 可等待的 init 生命周期完成。失败回滚 owning fiber，不暴露半就绪 service。

### 9.3 主 Agent 创建

```text
用户选择 preset
→ 官方 API Session Controller 按官方模型选择器创建 Session / Agent
→ 官方 AgentPresets mount standing composition
→ MainRuntime 在同步 agent/created 中识别该 preset 的顶层 Agent
→ 同步校验 enabled / generation，并在 agent 自己的 scope 安装主工具 restriction / persona / guard
→ 立刻自检可见工具集合；不符合预期则同步抛错，让官方创建链 dispose 临时 Agent
→ 成功后进入 agent/session-start 并等待第一轮
```

这里使用 `agent/created` 不靠猜测子 Agent 身份：每个 MainRuntime 实例已经由 preset config 绑定 agent id，并且只处理该 composition 下 `origin !== subagent` 的顶层 Agent。

`agent/created` 不是发布前 setup seam，v1 不再宣称主 Agent 对同进程 trusted listener 完全不可见。它的产品边界是**同步首轮前激活门**：在 `agent/session-start`、首轮 prompt assembly 和任何模型工具执行前，MainRuntime 必须同步完成 enabled 判定、`presetId → mainAgentId` 映射校验、persona、tool restriction、guard 安装与可见工具自检。同步 listener 中不做文件 I/O；所有数据已在 Host init 预加载。禁止在 listener 中 `await` 后再装权限。同步异常会让官方创建链 dispose 已进入 registry 的临时 Agent，并向用户返回明确创建失败；它不是 OS/进程级安全隔离。

### 9.4 主 Session 冷恢复

v1 对主 Session 采用 **current-policy resume**：旧主 Session 冷恢复后直接绑定当前 active catalog/settings，不保存也不回放创建当时的主结构快照。历史消息不改写；后续可见工具、persona、allowedChildren、maxDepth 和 enabled 判断都按当前新配置执行。

恢复流程必须 fail-closed：

1. 官方 API Session Controller 先按持久化的 preset 选择解析 preset。**这一步在插件之前**：preset 已被删除时官方直接抛 `agent-preset/not-found`，插件没有介入点，也不会改写历史或回退到默认 preset；
2. preset 解析成功后，MainRuntime 用当前 active manifest 反查 `presetId → mainAgentId`；
3. 反查失败（当前 manifest 没有该 `presetId` 的映射）、service not-ready，或该主 Agent 已被 `enabled: false` 停用时，在激活门拒绝新 prompt，并提示启用路径或完成重启。**`generation` 不是这里的判定条件**：它在同一进程内固定，任何配置编辑只影响**下一个**进程的 generation，用它是无效检查（理由同 11.1.1）；
4. 找得到且可用时，按当前配置安装主 persona、tool restriction、delegation guard 和可见工具自检；
5. 降权、删边、降低 depth 或停用 child 后，旧主 Session 继续存在，但后续委派按当前 guard 拒绝；
6. 不承诺 historical-policy replay，不为主 Session 新增私有结构 snapshot event，**也不做"定义已删除就回退到默认 Agent"**：Session 的 composition 在创建时固定，官方 `recompose` 明确只允许尚未产出内容的 Agent 换 preset，中途换工具会让历史里的工具调用变成新 composition 做不了的事。删除定义的正确后果是明确失败 + README 指引重新提供 YAML，而不是静默换身份。

### 9.4.1 删除一个有 main 形态的 Agent 时，整棵子树一起失效

continuable child 的冷恢复需要**活着的直接父 Session** 做授权校验（官方 descriptor 只负责重建 child 的 route/persona/toolFilter，授权仍要求 exact live parent）。因此：

```text
删除 my-lead 的 preset
├── my-lead 的旧主 Session          → 官方 not-found，无法恢复
├── 其下所有 continuable child       → 无法恢复（父 Session 不存在）
└── 其下所有 one-shot 历史           → 只读历史，本来就不能继续
```

这是**期望行为**，不是缺陷：它保证不会留下"父已死、子还半活"的残状态。README 必须写明这一点，让用户知道删除主 Agent 的影响范围是整棵树，而不只是那个 Agent 本身。

### 9.5 不使用 tools/change 重装

v1 不监听 `tools/change` 作为装配入口，也不在 settings 保存后调用 recompose。

原因：

- 避免 recompose → tools/change → 再装配的重入环；
- 避免运行中删除/改名工具破坏当前上下文；
- settings 的子 Agent 模型和 enabled 可在下一次执行读取，无需重装；
- 结构文件本来就约定重启生效。

---

## 10. 委派与递归

### 10.1 静态 standing 工具图

每个 managed 主 preset 在 standing scope 预注册 startup catalog 与 ABI manifest 中**全部稳定的** `agent_*` 工具，而不是只注册当前授权图的传递闭包。MainRuntime 再给顶层 Agent 应用严格 allowlist：顶层 Agent 的 `delegationDepth` 为 0，因此它的 `remainingDepth = maxDepth - 0 = maxDepth`，只有 `maxDepth > 0` 时才看得见 `allowedChildren` 的直接子节点；多注册的工具只是兼容底座，不会自动可见：

```text
agent_planner
agent_research
agent_explorer
agent_implement
agent_review
agent_executor
agent_<每个用户或历史 ABI id>
delegate_batch
```

每个子 Agent 创建时，官方 `applyChildComposition`：

1. 直接 join 父 Agent 当前 standing preset；
2. 用目标 Agent persona shadow 主 persona；
3. 在未发布 setup 事务内应用目标 child 的严格 toolFilter。

目标 child allowlist 只保留：

- 该 child 的普通 ToolCapability；
- 当 `remainingDepth > 0` 时，该 child `allowedChildren` 对应的 `agent_<id>`；
- 当 `remainingDepth > 0` 且有子节点时的 `delegate_batch`；
- 该 child 的 ToolCapability 显式包含 `agent-control` 时，才保留 `list_agents` / `send_message` / `interrupt_agent`。

wrapper 用公开 `delegationDepthOf(parent) + 1` 计算即将创建的 childDepth，再计算 `remainingDepth = main.maxDepth - childDepth`。这样达到 cap 的子 Agent 根本看不见下一层工具，而不是看见后调用失败；官方 `resolveChildDepth` 仍是最终安全检查。continuable descriptor 会冻结这次计算得到的 toolFilter。

这条路径不再依赖：

- `agent/created` 猜子 Agent 角色；
- 按当前授权闭包增删 standing 工具；
- 运行中动态注册下一层工具；
- 用 label、persona 或工具集合**启发式推断**角色（角色身份改用 11.1.1 的显式持久记录）；
- 每角色相对深度换算；
- 每角色 session sandbox 注入。

### 10.2 绝对深度

所有 `agent_<id>` 和 `delegate_batch` 调用官方 `ctx.subagents` 时，都先从该 live scope 的 DelegationRuntime config 读取 `presetId/mainAgentId/generation`，并与 Host active catalog 映射核对，再传当前主 preset 的同一 numeric `maxDepth`。调用者是 child 时（continuable 或 one-shot），还必须先按 11.1.1 解析自己的身份（continuable 读持久 event，one-shot 读 live map），并按**当前** catalog 重算它到目标的边授权。映射缺失、身份缺失或版本不支持、service not-ready、main 定义缺失、当前 `allowedChildren` 不含目标、目标是 `RetiredToolShell` 空壳、或 maxDepth 无法解析时一律 fail-closed，提示恢复定义/完成重启；不得回退到默认深度，也不得因为旧工具白名单仍可见就放行。**`generation` 不在这个列表里**：它只写进 13.1 的日志和错误文案（见 11.1.1）。

注意 `RetiredToolShell` 在这条链上的角色：它的存在只保证 `tools.restrict()` 不会因为 unknown 名而抛错，从而让旧 child 能恢复；它**不**提供任何授权。命中空壳即拒绝，且错误信息必须说明定义已被删除。

官方 `delegationDepth` header 是持久化单调 floor，continuable 冷恢复不会把深度重置为 0。

授权图仍拒绝环。即使绝对 cap 能阻止无限递归，允许 A ↔ B 也会造成无意义往返和难以解释的行为。

### 10.3 主 Session 级并发上限

**为什么需要它**：授权图管"谁能调谁"，`maxDepth` 管树有多**深**，但两者都**不管宽度**。`maxDepth = 2` 只保证深度不超过 2；Banbo 可以在一个回合里连续调用 `delegate_batch`，每层各自展开 6 路，宽度没有任何上限。唯一约束宽度的护栏就是这个并发计数。没有它，一条用户消息可以让几十个 Agent 同时运行、同时改同一个仓库。

每个主 Session 维护一份**进程内**运行时计数，整棵 Agent 树共享。树的根用身份里的 `rootSessionId` 定位（continuable 读 11.1.1 的持久 event，one-shot 读 live map）：顶层主 Session 的 root 就是它自己，任何 child 用自己身份里的 `rootSessionId` 找到同一份计数。**不通过逐级爬 `parentSession` header 推断根**——那条链在恢复时可能不完整。

```ts
interface MainSessionBudgetState {
  runningChildren: number   // 当前正在运行的 child 轮次数
}
```

保留的字段（都在 `main.budget` 下）：

| 字段 | 默认值 | 语义 |
|---|---:|---|
| `maxConcurrentChildren` | 6（clamp `[1, 32]`） | 当前 root Session 下**同时运行**的 child 轮次数上限。**新建 child（含后台 one-shot）计入**；复用 continuable child 的轮次**不计入**（见下方"v1 明确不做"，此处与那一节保持一致，不得写成"都计入"） |
| `maxBatchWidth` | 4 | 单次 `delegate_batch` 可并发启动的 one-shot item 上限；绝对上限 6（纯 schema 校验，不是运行时状态） |

执行规则：

1. **原子占位**：检查与增加必须在**同一个同步块**内完成，中间不得出现 `await`：

   ```ts
   if (runningChildren + n > maxConcurrentChildren) throw new BudgetError(...)
   runningChildren += n   // 同步，天然原子
   ```

   JS 单线程保证同步块的原子性；竞态只会在"先 await 再占位"的写法下出现，那是实现纪律问题，不需要 lease/lock 机制。
2. **一次性占位**：`delegate_batch` 必须在启动任何 child **之前**同步占满全部 N 个槽；不足则整个调用拒绝，不做部分启动。
3. **释放**：child 轮次结算（完成 / 失败 / 取消 / deadline / dispose）时同步递减，并保证幂等——重复释放不报错、不把计数减成负数。释放路径必须覆盖 dispose 与 interrupt 同时到达的情况。
4. 后台 one-shot 同样占用 `runningChildren`，不设独立字段。
5. 并发超限 fail-fast，**不排队**；错误信息给出修复路径：等待现有子任务完成、复用 idle continuable child、减少 batch 数量，或在 main YAML 提高 `maxConcurrentChildren` 后重启。

**v1 明确不做（并如实写入 README 与 persona 文案）**：

- **不精确计数 `send_message` 复用的轮次**。官方 `send_message` 是 `dsh-tool-subagent-control` 提供的工具，插件不替换、不 monkey-patch；精确计数需要 `tools/execute` wrapper 包装官方工具、解析消息方向、管理 lease 生命周期，成本高且竞态多。v1 只保证**新建 child 精确计数**，复用已有 continuable child 的轮次不保证被并发上限拦住。这条限制必须写在 README，不得宣传成"完整并发控制"；上方字段表的"不计入"就是这条限制的准确表述。
- **不做 `maxTotalStartedChildren`**：不持久化就只是"本回合上限"（价值弱），要持久化就得写 Session 日志或私有 projection（成本远超收益）。并发上限已经提供"跑完一个再起一个"的宽度约束。
- **不做独立的 `maxConcurrentBackgroundJobs`**：后台 one-shot 本身就是 child 轮次，已被 `maxConcurrentChildren` 覆盖。
- **计数不跨 Host 重启**：v1 的预算是**本次 root activation**的护栏，不是计费系统。重启后从 0 开始。这是刻意取舍，README 必须写明，避免用户以为它是配额。

主 persona 必须指导 LLM：需要同一专家继续上下文时，先 `list_agents` 找 idle continuable child，再用 `send_message` 复用，不要为同一任务反复新建 child。禁用某个 Agent 后不允许新建；已有 continuable child 默认可继续 `send_message`，但它后续再委派仍受当前 enabled、`allowedChildren`、并发上限和 depth guard 约束。

### 10.4 薄 wrapper

不直接为每个 Agent 配置一份静态 `tool-subagent.apply()`；实现一个薄策略 wrapper：

```ts
delegateOne(parent, agentId, prompt, mode)
```

它只负责：

1. 验证调用者当前是否看得见目标 `agent_<id>`；
2. 检查目标 enabled；
3. 检查并占用并发槽；
4. 读取目标最新模型设置；
5. 校验 live presetId/mainAgentId/generation 与 active catalog 一致，再根据公开 delegationDepth 计算 remainingDepth，组装 persona、toolFilter、agentOptions、统一 maxDepth，并登记本次身份写入（11.1.1：continuable 进 pending 表待写持久 event；one-shot 留待 `start()` 返回后写 live map）；label 只作人类可读展示，格式为 `<agentId>: <description>`，**不得**作为权限判定依据；
6. 把本次 holder 登记进 HolderRegistry（10.8），再调用官方 `ctx.subagents.start()` 或 `startContinuable()`；continuable 必须在 child 首次模型请求前完成持久写入，one-shot 在 `start()` 返回后用 `run.id` 建立 map 条目；
7. 在完成、失败、取消、deadline 或 dispose 后释放对应 running 槽，收束 holder 并从 registry 注销，最后标准化错误和返回；grace 内未收束时把 holder 留在 registry 并如实标注。

它不负责：

- 创建 Agent 或 Session；
- 复制 `applyChildComposition`；
- 修改官方 registry；
- 改写、伪造官方 `subagent/descriptor`（身份只写插件侧 sidecar，绝不写 Session 日志）；
- 自己管理 holder 生命周期（交给 10.8 的 registry）；
- 自己实现深度算法；
- monkey-patch spawn Provider。

### 10.5 单个具名工具

建议 schema：

```ts
interface DelegateArgs {
  prompt: string
  description: string
  run_in_background?: boolean // 默认 false
}
```

行为：

| child.continuation | run_in_background | 行为 |
|---|---:|---|
| one-shot | false | 前台 one-shot，父工具调用等待结果；受 `foregroundDeadlineMs` 约束：正常路径 await dispose，grace 用尽则移交 HolderRegistry（见下方与 10.8） |
| one-shot | true | 后台 one-shot，由插件通过官方 jobs service 注册父 Agent 所有的 Task，Task 接管 run/result/dispose 并在完成后通知；不能 send_message 续聊 |
| optional | false | 前台 one-shot，父工具调用等待结果；约束同上 |
| optional | true | continuable，立即返回 childId，可 send_message |

Research、Explorer 的 `continuation` 固定 one-shot。Planner、Executor、Implement、Review 默认 optional。若 `run_in_background: true` 但 jobs service 不可用，必须在创建 child 前拒绝；插件不得启动一个无人持有、无人 dispose 的 one-shot run。

**前台 deadline（新增，与 batch 同源）**：前台 one-shot 不能无限期挂起父工具调用，规则与 10.7 完全一致：

1. `foregroundDeadlineMs` 来自 main preset budget，默认 1800000（30 分钟），clamp 到 `[60000, 3600000]`；
2. 到期后 wrapper 对 run 发 cancel，并给 `drainGraceMs`（默认 30000）等待 `run.dispose()` 收束；
3. grace 内收束：返回已获得的部分输出，并明确标注本次调用为 `cancel_requested`，**不得**把部分输出当作完整结果；
4. grace 用尽仍未收束：holder 所有权移交 cleanup registry（10.8），返回状态标注 `cleanup_deferred`，不谎称资源已释放。

工具定义自身的 `timeoutMs` 必须严格大于 `foregroundDeadlineMs` 上限加 `drainGraceMs`，否则外层超时会先于本工具自己的结构化返回触发，模型拿到的是通用 `TOOL_TIMEOUT` 而不是可解释的取消结果。

后台 one-shot 生命周期固定为：

1. 工具先向官方 jobs service 注册一个父 Agent 所有的 Task，并返回 `jobId`、agentId 和状态；
2. Task 使用自己的 AbortController 调用 `ctx.subagents.start()`，保留返回的 `SubagentRun`；
3. Task await `run.result`，把 stopReason/output 映射为一次官方 jobs completion/failure 通知；它不是 continuable child，不发送 subagent settlement notice，也不返回 childId；
4. 无论完成、错误或取消，`finally` 都 await `run.dispose()` 后才让 Task terminal；
5. **后台同样受 `backgroundDeadlineMs` 约束**（默认 1800000 / 30 分钟，clamp `[60000, 7200000]`）：到期对 Task signal 发 cancel，并给 `drainGraceMs` 等待 `run.dispose()` 收束。grace 内收束 → Task 以 `killed` terminal；grace 用尽仍未收束 → holder 留在 HolderRegistry 并记 `cleanup_deferred`，Task 以 `failed` terminal 并在 detail 里注明"清理已移交 registry"。**后台路径不能没有 deadline**——没有它，一个挂死的后台 run 会永久占着 `maxConcurrentChildren` 的一个槽，最终耗尽该 root Session 的全部委派容量；
6. jobs cancel、父 Agent / Host dispose 都 abort Task signal 并等待 dispose；若 start 尚未 publish，由同一 signal 清理 partial resources；Provider remove 只阻止新的 start，已发布 run 继续由持有它的 jobs Task 收束，插件不自造 provider→run 全局索引；
7. Task 通知只发一次；`subagent/end` 是遥测，不再作为第二份模型结果注入父 Agent。

三条路径（前台 one-shot / 后台 one-shot / batch item）**一律各有 deadline**，同一个 grace + registry 收束机制（10.8）。不存在"没有超时"的委派路径。

### 10.6 父 Agent 行为规则

主 persona 必须明确：

1. 默认 `run_in_background: false`；
2. 下一步依赖子结果，或会改同一文件/资源时，前台等待；
3. 只有存在明确无依赖、无冲突的其他工作时，才使用后台；
4. 后台后不轮询、不催促、不重复委派、不亲自做同一任务；
5. 需要同一专家继续上下文时，先 `list_agents` 找已有 idle continuable child；能复用就用 `send_message`，不要重复新建；
6. 父 Agent 的 `send_message` 只用于补充新信息、回答子 Agent 问题、纠正方向或追加新任务；子 Agent 可以用它发送提前发现、问题和最终结果；官方 settlement notice 仍可能再次携带 closing message，主 persona 必须按 childId 把两者视为同一次完成，不重复行动；
7. 多个互不依赖的结果都返回后才能继续时，用 `delegate_batch`（它的 item 一律 one-shot，跑完即终结）；需要保留对话的委派一律走单个 `agent_<id>`。

代码无法可靠判断两段自然语言任务是否重复，所以“不要自己做同一任务”属于 persona 约束；权限、生命周期、batch 屏障和超时收束由代码强制。

### 10.7 delegate_batch

**v1 边界：batch 接受任意有 `child` 形态的 Agent，每个 item 一律以 one-shot 执行。** 目标自己的 `continuation` 不进入 batch 契约：`delegateOne` 只在 `runInBackground === true && continuation === 'optional'` 时才走 continuable 路径，而 batch item 固定传 `runInBackground: false`，因此一个 `optional` 目标在 batch 里的执行与一次前台单个 `agent_<id>` 调用是同一条 `startOneShot` 路径。v1 不做的是**在 continuable 执行模式下混合批量**，理由和 v1.1 需要补什么见 10.7.1。

参数：

```ts
interface BatchItem {
  agentId: string
  prompt: string
  description: string
}

interface BatchArgs {
  tasks: BatchItem[]
  deadlineMs?: number // 可选；默认 600000（10 分钟），clamp 到 [60000, 1800000]
}
```

注意 `BatchArgs` **没有** `run_in_background` 字段：batch 永远是前台工具调用。早期草案里"前台 10 分钟 / 后台 30 分钟"两套默认值属于从 10.5 误抄，已删除。

规则：

- 任务数必须在 `1..maxBatchWidth` 之间（默认 4，绝对上限 6；纯 schema 校验，与 `maxConcurrentChildren` 不是同一个量）；
- 参数校验分**两级**，语义不同，不得混用（这是唯一的拒绝粒度规则）：
  - **契约级 → 整个调用拒绝，不启动任何 child**：任务数不在 `[1, maxBatchWidth]`、`deadlineMs` 非法、item 引用了不存在或已退役的 agentId、item 缺必填字段。这些是"模型误解了工具契约"，必须整体拒绝才能教会它正确用法，部分执行只会掩盖误解；
  - **授权级 → 该项失败，其他合法项继续**：item 指向的 Agent 不在调用者当前 `allowedChildren` 内。这是运行期动态判定，合法项没有理由陪葬，`Promise.allSettled` 会如实回报每一项；
- `continuation` **不是** batch 的契约关注点：每个 item 都以 one-shot 执行，目标是否支持续聊不改变这次执行的任何一步，因此这里没有可拒绝的东西（早期版本曾整体拒绝 `optional` 目标，理由见 10.7.1 的纠正）；
- 两个 `agentId` 是否合法（存在、未退役、有 `child` 形态）属于契约级；它是否**被授权给当前调用者**属于授权级。前者是定义事实，后者是调用上下文事实；
- `deadlineMs` 是 batch 的**唯一等待边界**；0、负数、NaN、非数字、超上限一律拒绝整个调用，不做静默截断（调用方需要知道自己拿到的是什么语义）；
- one-shot 使用 `ctx.subagents.start()`；每个 item 一个 holder，`run.dispose()` 在全路径恰好调用一次（由 batch 或 cleanup registry 之一完成，见 10.8）；
- `Promise.allSettled`：部分失败不取消其他任务；deadline 到期时停止等待未完成任务；
- batch 调用本身消耗父 Agent 当前的一次工具调用，每个 child 消耗一层 delegationDepth；
- 所有 one-shot start 使用 item AbortController 与 batch tool `exec.signal` 融合后的 signal，它是官方启动前后的统一取消通道；
- batch 工具定义自身的 `timeoutMs` 必须严格大于 `deadlineMs` 上限加 `drainGraceMs`，否则外层超时会先于 batch 的结构化返回触发，绕过 `partial_timeout`。

结算流程（三步，顺序固定，不得合并）：

1. **等待**：`Promise.allSettled` 等待全部 holder 的 `run.result`，或 `deadlineMs` 到期，或父 `exec.signal` abort，或 Host/parent dispose —— 四者先到者生效；
2. **收束**：对每个未完成 holder 发 cancel，并给 `drainGraceMs`（默认 30000）等待其 `run.dispose()` 收束；
3. **交接**：grace 内收束的 holder 记 `cancel_requested`；grace 用尽仍未收束的 holder **所有权移交 cleanup registry**（10.8）并记 `cleanup_deferred`，随后 batch 立即返回。

第 3 步是这套设计的关键：batch 之所以能"到点就返回"，是因为未完成的资源**有了明确的新 owner**，而不是被丢在后台。任何时候都不存在无人持有的 run。

返回：

```ts
interface BatchResult {
  status: 'completed' | 'partial_failed' | 'partial_timeout' | 'cancelled'
  deadlineMs: number
  items: BatchResultItem[]
}

interface BatchResultItem {
  agentId: string
  status:
    | 'completed'        // run.result 的 stopReason=completed 且有输出
    | 'empty'            // stopReason=completed 但输出为空
    | 'failed'           // 非 completed 的 stopReason，或 start/运行期错误
    | 'cancel_requested' // deadline/cancel 后已确认 dispose 收束
    | 'cleanup_deferred' // deadline/cancel 后 grace 用尽，holder 已移交 cleanup registry
  result?: string   // completed 时的最终文本
  stopReason?: string
  error?: string
}
```

**batch 的 child 一律一次性，`BatchResultItem` 刻意不带 `childId`。** batch 的语义是"本轮把 N 件独立的事跑完并拿到结果"，它不承诺留下任何可继续的会话；需要保留 child 做后续追问时，用**单个后台 `agent_<id>`**（后台 + `optional` → 持久 childId）。因此本节**不得**重新引入"batch 拒绝 continuable 目标"的守卫：那条守卫拒绝的是 **Agent 身份**，而真正成立的边界是"每个 item 都是 one-shot 执行"，它拦不住任何误用（batch 本来就不会走 continuable），只会切掉本来正确的用法。

聚合规则（逐条实现，不靠推断）：

| items 的实际状态 | `BatchResult.status` |
|---|---|
| 全部 `completed` / `empty`，无超时 | `completed` |
| 全部 `completed` / `empty`，存在任意 `cancel_requested` 或 `cleanup_deferred` | `partial_timeout` |
| 存在 `failed`，无超时 | `partial_failed` |
| 存在 `failed`，且有超时 | `partial_failed`（failed 的优先级高于 timeout） |
| 父 `exec.signal` abort | `cancelled`（已完成项保留自己的终态，不会被改写） |

真值表是穷尽的：`cancelled` 只决定顶层 `status`，不覆盖任何已完成项的 `BatchResultItem.status`。父 abort 与 deadline 同时到达时，`cancelled` 优先。

`empty` 计入成功项，不计入 failed；这是全文**唯一**允许把空输出视为成功的位置。

返回文本必须让父模型能分辨"完成"和"没等到"：`cancel_requested` 与 `cleanup_deferred` 的项一律附上"本次调用到期时该子任务未返回结果，已请求取消"，不得用任何措辞暗示它已完成或失败。

batch 不做"部分结果拼接"：`result` 只来自对应 holder 自己已结算的 `run.result`，wrapper 不跨项合并、不推断、不补写。

阶段 2 产品验收必须验证（**不属于阶段 0 平台 Gate**——这些断言需要 batch 实现存在才能运行）：

- batch 在 deadline 内等待时父 Agent 不会开启下一次模型思考；deadline 到期后父 Agent 必须拿到 `partial_timeout`，不能永久挂起；
- 取消或 deadline 到期时 one-shot 的融合 signal 触发 stop/dispose；
- **不合作 provider 探针**：构造一个忽略 abort、`dispose()` 永不结算的 run，证明 grace 用尽后 holder 被 cleanup registry 接手、batch 仍按时返回 `cleanup_deferred`、Host dispose 时 registry 能 drain，全程无 orphan（平台侧的 `dispose()` 行为由 Gate D 探针先行确认）；
- Host dispose、父 Session cancel 都能释放等待器；Provider remove 后不接收新 start，已发布 run 按现有 holder 收束；
- one-shot 卡死、`start()` 中途失败、deadline 与父 cancel / registry 清理交错，都返回可解释 terminal，不把空结果或 timeout 记成 completed；
- batch 工具自身的 `timeoutMs` 大于 deadline 上限，证明模型拿到的是结构化 `partial_timeout` 而不是通用 `TOOL_TIMEOUT`。

若"不合作 provider 探针"这一条不成立，暂停实现并回到产品决策：那说明"到点返回"和"资源有主"无法同时满足，不得自动降级。

### 10.7.1 v1.1 候选：continuable 执行模式的 batch（v1 明确不做）

**v1 只保留 one-shot 执行模式的 batch。** continuable 执行模式的批量委派（早期草案的 mixed batch）在 v1 移除，根因是**两套生命周期无法塞进同一个等待器**：

- continuable child 由官方 continuation manager 直接持有 Activation，batch 若要在这个模式下等它，barrier 只能等配对的 `subagent/end`，而不是 `run.result`；
- 清理也只能走 `interrupt`（停止当前轮、保留可恢复 Session），没有对应的 `dispose`。

一个 waiter 同时面对"会 `dispose` 的 run"和"只能 `interrupt` 的 Session"，deadline 语义必然自相矛盾。v1 只保留单个 `agent_<id>` 的 continuable 委派（10.5），批量场景用多个 `agent_<id>` 调用或后台 one-shot 覆盖。

**纠正一句旧说法**：本节早期版本写的是"continuable child 没有 `SubagentRun`"——这句话**只对 continuable 执行路径成立**。一个 `continuation: optional` 的 Agent 经 `startOneShot` 执行时**有** `SubagentRun`，batch 因此能够、并且现在确实接受 `optional` 目标作为 one-shot item（见 10.7 与 16.10）。"没有 `SubagentRun`"不是拒绝某个目标的理由，只是"不能在同一等待器里混合两种收束方式"的理由。

v1.1 若要做，必须先立最小设计：

1. 为 continuable 定义与 `SubagentRun` 对等的 holder 抽象和可观测收束契约；
2. 两层 deadline：`softReturnMs`（返回给模型）与 `hardDrainMs`（强制收束）；
3. 明确 `interrupt` 只停当前轮、不 dispose Session，并保证 registry drain 不会误删可恢复 Session；
4. 复用 10.8 的 registry，不新造第二套所有权模型。

### 10.8 Holder 所有权与 cleanup registry

10.5 的前台 deadline 和 10.7 的 batch deadline 共用同一个收束机制。它是本方案里唯一负责"资源有主"的组件。

```ts
interface Holder {
  readonly label: string          // '<agentId>: <description>'，仅用于诊断
  cancel(reason: string): void    // 协作式取消，幂等
  settle(): Promise<void>         // 等到底层释放，可能永不 resolve
}
```

规则：

1. registry 由插件建在 Host/agent service 的 effect scope 上；`ctx.effect(...)` 的 disposer 负责 drain 全部在册 holder；
2. 登记必须在创建 holder **之前或同一同步段内**完成，避免"已启动但还没入册"的窗口；
3. 正常路径下 holder 由发起方（单个工具或 batch）自己 await 收束并从 registry 注销，registry 只是兜底；
4. 超时或取消后 grace 用尽的 holder 仍留在 registry，直到 `settle()` 真正完成或 Host dispose；
5. `cancel()` 幂等：重复调用不得抛错、不得产生副作用；
6. registry 不承诺硬杀同进程代码。它的承诺只有两条：**资源必有 owner**，以及 **Host dispose 会等待全部 holder 收束或明确报告哪些没收束**；
7. registry 在 `drain()` 超过 `drainGraceMs` 仍未收束时，向 Host 日志写明确的未收束清单（含 label 和登记时长），不静默吞掉；
8. 插件不自造 provider→run 全局索引：registry 只保存 holder 本身，不遍历官方 provider 内部状态。

---

## 11. 持久化与兼容 ABI

### 11.1 官方 descriptor

continuable descriptor 由 DSH 持久化：provider、label、agent route、persona、toolFilter。冷恢复重新应用这些字段。官方 descriptor 不承载业务身份，插件因此把身份放进**插件侧 sidecar 文件**（见 11.1.1；私有 Session event 路线已被 Gate A 证否）。本方案**不新增任何私有 Session event**，sidecar 是唯一允许的私有持久化扩展。

官方 descriptor 不保存：

- 自定义 agent id；
- maxDepth；
- maxTokens（因此 v1 不把它作为按 Agent 持久配置）；
- allowedChildren；
- 本插件 catalog revision。

因此：

- persona、route、toolFilter 对已创建 child 冻结；授权图或 child tools 的结构变更只影响新建 child，旧 continuable child 恢复后仍保留创建时可见的 `agent_*`；
- 每个 standing preset 必须继续注册 ABI manifest 中的历史 `agent_*`，否则旧 descriptor 的 allowlist 会因 unknown tool 无法恢复；
- 后续 child 再委派时，wrapper 按 11.1.1 的身份（continuable 持久 / one-shot 内存）解析调用者与目标，并与当前 catalog 比对边授权、enabled、depth 和并发上限；旧 filter 显示工具不代表执行授权。`generation` 只用于错误解释与 stale 诊断，**不参与授权判定**；因此降低 cap、停用目标、删除边或已退役目标（`RetiredToolShell`）都会在执行时被拒绝；
- 升级不能删除旧 descriptor 的 filter 仍引用的工具名。

### 11.1.1 插件私有 child 身份（sidecar 存储）

**问题**：官方 descriptor 不保存自定义 agent id，`delegationDepth` 只表达层数。一个 continuable child 冷恢复后，插件能确认“它有哪些工具”，却无法权威确认“它是哪个 AgentDefinition”。而“旧 filter 显示工具不代表执行授权”（见 10.2 / 11.1）要求按**当前** `allowedChildren` 判定边授权，这必须以调用者的 Agent id 为前提。仅凭 label、persona 或工具集合推断身份属于不可用于权限判定的启发式，v1 明确禁止。

**为什么不能写私有 Session event（Gate A 已证否，rc.1 / rc.2 行为一致）**：

1. `Session.append(type, data, ...opts)`（`dsh-session/lib/index.js:1170`）自行拼装事件信封，**没有任何参数能写入 `ignorable: true`**；
2. 而 persistence 的读取路径（`dsh-session-persistence/lib/index.js:184`）对"不在 `KNOWN_SESSION_EVENT_TYPES` 内且未标 `ignorable`"的事件类型**直接抛错并拒绝解释整份日志**；
3. `KNOWN_SESSION_EVENT_TYPES` 是仓库内生成的内置集合，其文档明写 out-of-repo 插件事件天然不在其中。

三者合起来意味着：追加任何插件私有事件类型，都会让该子 Session **下次无法加载**——比"禁止委派"严重得多。因此 v1 **不新增任何私有 Session event**。

**方案**：身份改用**插件侧 sidecar 文件存储**，并按生命周期分两套载体：

| 生命周期 | 身份载体 | 理由 |
|---|---|---|
| **continuable** | sidecar 文件 `$DSH_HOME/banbo-agents/.children/<childId>.json` | 会冷恢复；恢复后必须重新确认角色才能判定它的委派授权 |
| **one-shot** | **进程内 live map**：`childSessionId → 身份` | 永不冷恢复；身份只在本轮存活期间被读取，没有落盘的必要 |

这个拆分不是优化，而是必须的：batch 会**并发**启动最多 6 个 one-shot。若 one-shot 也落盘，同一个父 Agent 在同一时刻会有多条待写身份，`agent/created` 触发时无法判断新发布的 child 对应哪一条。内存 map 完全不需要关联——`SubagentRun.id` 对 in-process run **就是已发布的 child session id**，`start()` 一返回键就到手。

身份结构（continuable 落盘、one-shot 同形但只在内存）：

```ts
interface BanboChildIdentityV1 {
  version: 1
  agentId: string        // 本 child 的 AgentDefinition id
  mainAgentId: string    // 所属顶层主 Agent id
  presetId: string       // 所属 managed preset id
  rootSessionId: string  // 所属主 Session id，同时是并发计数的归属键
  generation: string     // 创建时的 catalog generation，仅用于诊断，不单独决定授权
}
```

**sidecar 的存储契约**（与 8.6 的 generation 目录同一套思路：不可变、原子、无锁）：

```text
$DSH_HOME/banbo-agents/.children/
├── <childId-1>.json      # 写完即不可变，一个 child 一个文件
└── <childId-2>.json
```

1. **文件名即键**：`<childId>.json`。continuable 的 childId 由调用方预留，因此在调用 `startContinuable()` **之前**就知道写哪个文件；
2. **写入原子**：写临时文件 → `fs.rename` 覆盖目标。目标文件此前不存在（childId 唯一），因此不存在"改坏已有记录"的窗口；
3. **不加锁、不做读改写**：每次创建写的是新文件，两个进程并发创建不同 child 落在不同文件上，天然无冲突。这是刻意选择——方案刚刚在 8.6 删掉了跨进程锁，sidecar 不得把它请回来；
4. **写入失败必须让该 child 的创建整体失败并回滚**：不允许出现"身份未知但已经在运行的持久 child"；
5. **读取**：冷恢复时按 childId 直接读该文件。文件缺失、JSON 损坏、`version` 不支持 → 身份未知（fail-closed，见下）；
6. **不 GC**：v1 不删除历史身份文件。它们体积极小（几百字节），且删除会直接破坏旧 child 的可恢复性；`.children/` 与其它用户数据一样受 11.3 的卸载保留规则保护；
7. **权限**：目录 0700、文件 0600，与 8.6 的 generation 目录一致。

**这个选择的已知代价（必须写进 README）**：

- 身份**不随 Session 走**。把子 Session 复制到另一台机器或另一份 `$DSH_HOME`，sidecar 不会跟着过去，那些 child 冷恢复后按"身份未知"处理；
- 删除 `$DSH_HOME/banbo-agents/` 会连带删除全部身份，效果同上；
- 普通卸载（`dsh plugin remove`）**保留**该目录，因此重装后旧 continuable child 仍能被识别——这是期望行为，与 11.3 一致。

**写入时机**：

1. **continuable**：`delegateOne` 走 continuable 执行路径时，在调用 `startContinuable()` **之前**写 sidecar（batch item 永远是 one-shot，不写 sidecar）。写入失败 = 创建失败，不进入下一步；
2. **one-shot**：**不落盘**。在 `await ctx.subagents.start()` 返回后，用 `run.id`（= 已发布的 child session id）作为键写入 live map。`start()` 返回时 child 的 `followup` 刚被提交、prompt 组装尚未完成，而身份只在 child 执行 `agent_*` 工具时才被读取——中间隔着至少一次模型往返，时序余量是 step 级而非微秒级；若 Gate A 探针发现该余量不足，改为在 child 的首次 `agent/pre-step` 上补齐；
3. **live map 必须及时回收**：条目在该 child 的 run 结算时（与并发槽释放同一处、同一同步段）删除。map 的存活集合因此恒等于"当前活着的 one-shot child 集合"，不随会话历史增长。一个 root Session 生命周期内可以连续创建很多 one-shot；若不在结算时删除，条目会无界累积成内存泄漏。测试必须断言"全部 child 结算后 map.size === 0"；
4. 身份（sidecar 或内存）可用是 child 后续可以继续发起 `agent_*` 委派的必要条件。

**Gate A 必须验证的 sidecar 前置能力**：

- `$DSH_HOME` 的解析路径可由公开的 `dshHomePath()` 得到，且 `.children/` 可创建、可写、可原子 rename；
- 同一 `$DSH_HOME` 下两个进程并发写不同 childId 不冲突、不产生半成品文件；
- 冷恢复路径能按 childId 读回身份，且读取失败时可被识别为"身份未知"而不是抛错中断恢复。

**冷恢复与失败策略（fail-closed，但不连坐普通能力；只适用于 continuable，one-shot 永不走这条路径）**：

1. 官方先按 descriptor 恢复 Session；
2. 插件按 childId 读 sidecar，取回 `agentId` / `mainAgentId` / `presetId` / `rootSessionId`；
3. 当该 `agentId` 在当前 active catalog 中查不到（已删除或已退役）、已 disabled，或身份文件缺失、损坏、版本不支持时：

   - **禁止**该 Session 发起任何 `agent_*` 或 `delegate_batch` 委派；
   - **不禁止**它继续使用自己的普通工具（读、写、执行等）和正常对话；
   - 返回明确错误：`banbo-agents: 无法确认此子 Agent 的身份，已禁止继续委派（agent: <id>）；修复：恢复对应 YAML 后重启，或重新创建该子 Agent`；

4. 身份有效时，一律按**当前** catalog 判定目标 enabled、`allowedChildren` 边授权、`remainingDepth` 与并发上限；身份中的 `generation` 只用于错误解释和 stale 诊断。

**`generation` 绝不是阻断条件（强制）**：它不得出现在上面第 3 条的判定里。`generation` 的输入是整个 catalog（见 8.6），任何一次配置编辑都会让它变化；若拿它做阻断条件，用户改一个 Agent 的 tools 列表就会**冻结全部历史 continuable child**，与 9.4 的 current-policy resume 直接冲突。

`generation` 的唯一用途是回答"这条身份是哪一代写的"：写进 13.1 的 `delegation/rejected` 日志和错误文案，帮助定位 stale 状态。**它不参与任何授权或阻断判定**——判定只看 `agentId` 是否仍在当前 catalog、是否 retired、是否 disabled，以及当前 `allowedChildren` 是否含该边。

**明确不做**：身份不是安全沙箱，不是 approval 凭据，不能让 child 获得当前 catalog 之外的能力；它只回答“你是谁、你属于哪棵树”。身份不写 `label`、不写 persona、不改写官方 descriptor——官方展示字段保持人类可读，不被复用为机器协议。

### 11.2 工具名稳定性

`agent_<id>` 是持久兼容 ABI：

- 内置和用户 ABI 工具发布后不改名、不删除；每个 managed preset 都预注册完整稳定工具全集，再由 agent allowlist 裁剪；
- 每个 generation 目录内的 `abi.json` 记录该代的 generation hash、完整 managed `presetId → mainAgentId → maxDepth` 映射，以及每个 Agent 的 ABI shape；它与同目录的 `presets/` 天然同代（同属一个不可变 generation），不存在分别提交的可能；
- 用户删除定义文件后，ABI 记录**不删除**，转为 `RetiredToolShell`：该 `agent_<id>` 仍在 standing scope 注册为空壳，调用时报“定义已被删除”；它不出现在 picker（因为对应 preset 目录已随 generation 消失）、不作为授权候选、不能被 settings 启用。**保留空壳的唯一理由是 `tools.restrict()` 对 unknown 工具名是硬失败**，若名字消失，旧 continuable child 冻结的 `toolFilter` 会让整个 child 无法冷恢复；
- 若被删除的 Agent 曾有 `main` 形态，它的 `presetId` 从当前 generation 的映射中移除，旧主 Session 因此走官方 `agent-preset/not-found`；这是刻意的，不做占位 preset；
- v1 不实现 prune：ABI id 与工具名永不回收，破坏性演进新增版本化 successor，不复用旧名字表达不同能力；
- 升级测试用旧 descriptor fixture、`RetiredToolShell` fixture 和 sidecar 身份 fixture 冷恢复。

ABI shape 最小记录：

```ts
interface AgentAbiRecord {
  id: string
  toolName: string
  presetId?: string
  hasMain: boolean
  hasChild: boolean
  childContinuation?: 'one-shot' | 'optional'
  toolCapabilityNames: string[]
  allowedChildren: string[]
  retired?: boolean        // 定义文件已删除；工具名保留为空壳（RetiredToolShell 的持久来源）
  retiredReason?: 'definition-file-missing'
  definitionHash?: string
  // 以下是 retired 行在 Web 卡上唯一还能显示的信息源：
  // 定义文件已删除后，displayName / description 只在 ABI 里留存。
  // 两者都受 4.4.1 的 CATALOG_LIMITS 约束，成本可忽略。
  displayName: string
  description: string
}
```

**为什么 ABI record 必须存 `displayName` / `description`**：§12.1 要求 Web 卡为 retired Agent 渲染一行（含名称与"定义已删除"提示），但此时定义文件已不存在，`AgentCatalogRow.displayName` / `description` / `retiredReason` 没有别的来源。ABI record 是这些字段在退役后唯一可读的载体；不存就意味着 retired 行无法渲染。这两字段的写入受 `CATALOG_LIMITS` 的 `maxDisplayNameBytes` / `maxDescriptionBytes` 约束，无额外成本。

兼容规则：

- 新增 Agent、为未发布 id 生成新 toolName、给已发布 Agent 新增原先不存在的 main/child 形态：允许，但新增形态一经发布也进入 ABI shape 保护；
- 修改 displayName、description、persona 文案、child.model、tools、allowedChildren：允许，按生效时机和 current-policy guard 规则处理；
- 修改已发布 `toolName` / `presetId`：拒绝，必须换新 id；
- 删除已发布 main 或 child **形态**（即在文件仍存在时改写 YAML 抽掉该槽位）：拒绝；若源定义文件整体缺失，则允许，并按 6.3 的删除语义处理（转 `RetiredToolShell` + 移除 generated preset）；
- `child.continuation` 在 `one-shot` 和 `optional` 之间互改：v1 视为破坏性，拒绝并要求换新 id，避免旧会话误判是否可保留 Session；
- 删除或改名已发布 `allowedChildren` 中的目标不会改写旧 descriptor，但后续执行按当前 guard 拒绝；manifest 记录旧 shape 只用于兼容判断和错误解释，不用于放宽权限。

普通 DSH 工具名也会进入 toolFilter。支持的 DSH 版本范围必须锁定；升级前验证旧 allowlist 的所有名字仍是可 restrict 的 ancestor tool。缺失时禁止发布升级，除非提供迁移或兼容别名。

### 11.3 uninstall 与 purge 边界

普通卸载指 `dsh plugin remove @banbolee/dsh-agents`。它只移除插件运行时接入点：package link、Cordis patch row、Web client module、runtime registration 和 generated root 在 `agent-presets` 配置里的挂载；卸载后 TUI 官方默认 roster 恢复，本插件不再加载，也不会再注册 `agent_*` 工具。

普通卸载**默认保留用户数据与历史 ABI 数据**：

```text
$DSH_HOME/banbo-agents/agents/
$DSH_HOME/banbo-agents/prompts/
$DSH_HOME/banbo-agents/.generated/
ABI manifest（含 retired 空壳记录）
```

原因是这些文件属于用户配置和历史兼容数据；保留它们可以让用户重装后恢复 catalog、`RetiredToolShell` 和旧 descriptor 兼容。普通卸载测试不得把“用户数据目录仍在”判为残留失败，只能断言它不再被运行时挂载。

身份 sidecar 位于 `$DSH_HOME/banbo-agents/.children/`，因此**普通卸载会保留它**：重装插件后旧 continuable child 仍能被识别（期望行为）。代价是身份**不随 Session 走**——把子 Session 复制到另一台机器或另一份 `$DSH_HOME` 时那些 child 会按"身份未知"处理；README 必须写明这一点。彻底清除身份属于显式 purge：删除 `$DSH_HOME/banbo-agents/` 即可，不需要像旧设计那样额外删除 Session 日志。

彻底删除属于显式 purge / destroy，不属于普通 uninstall。v1 可以不实现 `banbo-agents purge` 命令，但 README 必须给出手工删除 `$DSH_HOME/banbo-agents/` 的破坏性说明：这会删除 YAML、prompt、generated presets、ABI manifest 和 retired 空壳记录；删除 ABI manifest 会让旧 continuable child 的冻结 `toolFilter` 因工具名消失而无法冷恢复。

### 11.4 approval 和 sandbox

官方子 Agent 继承父 Session 的 sandbox override，并把 approval 固定为 `never`。插件保留这一行为。

v1 不尝试根据 Agent id 给 child 强制写入不同 sandbox mode，因为公开 start request 和 descriptor 没有该字段。真正的每角色 sandbox 等上游提供可持久化的公开 composition 字段后再设计。

---

## 12. Web 设置界面

### 12.1 v1 范围

Web 卡标题：**Banbo Agent**。

每个 Agent 显示：

- displayName、description；
- 主 / 子 / 两者；
- enabled 开关；
- 子形态 model：default 或 provider/model/reasoningEffort；main-only Agent 显示“主 Agent 模型由官方 Session 模型选择器控制”；
- allowedChildren 和工具能力的只读摘要；
- 来源：built-in / user file / retired（定义文件已删除，工具名保留为空壳）；
- 高级配置目录和“修改后重启”提示。

可编辑项只有：

- `includeDefaults`；
- 定义仍存在且非 retired 的 Agent 的 enabled；retired 行只显示状态与恢复指引，不能通过 settings 重新启用；
- 具备 `child` 形态、定义仍存在且非 retired 的 Agent 的 model override。

retired 行的文案按形态区分：

- 曾有 `main`：`定义已删除（agent: <id>）；该主 Agent 的旧 Session 及其整棵子树不再可恢复；如需恢复请重新提供 YAML 并重启`；
- 仅 `child`：`定义已删除（agent: <id>）；不再可被委派；已有 continuable child 仍可恢复，但对它的新委派一律拒绝`。

不在 v1 Web 中编辑：persona、main/child 结构、工具、授权图、preset id、main budget；Web 只读展示预算摘要和“修改 YAML 后重启”提示。

**删除后再放回同名 YAML 会"复活"旧 Session，但用的是新 composition**：generated preset 目录重新生成后，旧 Session 的 preset 解析会成功，于是按 9.4 的 current-policy resume 语义继续运行。这既不是 bug 也不是兼容承诺：

- 好处：用户误删后放回原文件即可恢复，是最自然的救回路径；
- 风险：如果放回的是**改写过的**定义，旧 Session 会在一个新 composition 下继续，历史里可能出现新 composition 做不了的工具调用；
- README 必须明确这条边界，并推荐"要改定义就换新 id，不要复用旧 id 改语义"。

### 12.2 只读 CatalogRemote：接口契约

settings schema 只保存 enabled/child-model override，无法告诉 client 启动时加载了哪些自定义 Agent。Host 必须发布一个最小只读 Remote，Web 卡用它展示当前 startup catalog 并据此决定哪些字段可编辑；保存仍走官方 settings revision API。

**Host 侧定义（v1 唯一 Remote 方法）**：

```ts
// 模块：lib/catalog-remote.js（构建产物，与非 TS 的 index.js 分离）
// Cordis service key：banboAgentsCatalog
class BanboAgentsCatalog extends TypertRemoteService {
  static inject = ['banboAgents']   // 依赖本插件在 index.js 里注册的 catalog service

  constructor(ctx: Context)

  @Remote('list')
  list(): Promise<AgentCatalogView>
}

interface AgentCatalogView {
  agents: AgentCatalogRow[]
  generation: string   // 当前 generation hash；Web 端用它做缓存失效
}

interface AgentCatalogRow {
  id: string
  displayName: string
  description: string
  forms: ('main' | 'child')[]
  source: 'built-in' | 'user-file' | 'retired'
  retiredReason?: string
  enabled: boolean
  modelEditable: boolean   // 仅 child 形态且未 retired 时为 true
  currentModel?: { provider: string; model: string; reasoningEffort?: string }
  allowedChildren: string[]      // 只读摘要
  toolCapabilities: string[]     // 只读摘要
  mainBudgetSummary?: Record<string, number>
}
```

**宿主要素必须齐全，缺一即静默失效**：

| 要素 | 值 | 落在哪 |
|---|---|---|
| 类所在模块 | `lib/catalog-remote.js` | 必须出现在 3.3 的 `files` 白名单里，否则发布的包缺少 Host Remote |
| 自身 service key | `banboAgentsCatalog` | 由 `TypertRemoteService` 构造时注册 |
| 依赖的 Host service key | `banboAgents` | 由 `index.js` 在 Host init 阶段注册（对应 9.1 的 `BanboAgentsService`） |
| 实例化位置 | `index.js` | 在 catalog 校验与 generation 就绪之后、Host ready 之前 |

Remote 用 TS decorator 实现（理由见下），因此它**不可能**与纯 JS 的 `index.js` 同文件产出；这正是它必须单独进 `files` 白名单的原因。

**明确不返回**：persona 正文、绝对路径、generated composition 文本、任何可写句柄。也不提供任意路径读写 Remote —— 浏览器永远不能直接写用户 YAML。

**构建路线必须在 Gate E 定死**。DSH 的 Remote 依赖 decorator 写入 prototype 的版本化 descriptor，Gateway 通过运行时反射读取：

```ts
remoteMethods(service: object): readonly RemoteMethodMarker[]
```

这意味着两件事：

1. 这套机制是 **TypeScript decorator**，而本仓库现有 5 个插件全部是纯 JS，没有 TS 构建链；
2. decorator 一旦在构建/打包中被擦除，Remote **不会报错**，只是方法在浏览器里调不到 —— 属于最难定位的一类失效。

因此 Gate E 必须在下列两条路线中实测选定一条：

| 路线 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 引入 TS 构建（`tsdown`/`tsc`）产出 `lib/`，与官方 Remote 包结构一致 | 仓库首个 TS 构建插件，需要新增构建链与 CI 步骤 |
| B | 保持纯 JS，手工构造并挂载 decorator 所需的 prototype descriptor | 等于把官方内部实现细节抄进本仓库，升级 DSH 时容易失效 |

**CI 必须包含 decorator marker 断言**（这是打包问题，不是产品问题，因此属于平台探针）：

```ts
const markers = remoteMethods(new BanboAgentsCatalog(ctx))
expect(markers.map(m => m.method)).toEqual(['list'])
```

该断言必须运行在**打包后的产物**上，而不是源码上。没有它，decorator 被擦掉时不会有任何红点。

**client 侧类型来源**：`package.json` 的 `exports['./client']` 指向 `lib/client.js`，类型声明走 `lib/types/client/index.d.ts`，由构建产出。Web 端不得使用 `any` 承接 Remote 返回值。

### 12.3 保存提示

Web 卡必须逐项说明：

- 子 Agent 模型：下一次委派生效；
- 主 Agent 模型：v1 不由本插件设置，请使用官方 Session 模型选择器；
- enabled：后续创建/委派生效；
- 当前运行 Session 不改变；
- 结构配置和 main budget 需要编辑文件并重启。

### 12.4 Client 生命周期

- client id 唯一；
- HMR 不重复注册卡片或 style；
- style 使用带 `data-plugin="@banbolee/dsh-agents"` 的标签；
- dispose 只删除本插件标签和注册；
- 最小 `window.__ModuleLoader__` 仿真、真实 Web materialization 和 HMR replacement 都要测试。

---

## 13. 错误处理

统一格式：

```text
banbo-agents: <条件>（agent: <id>）；修复：<具体路径或动作>
```

关键错误：

| 条件 | 行为 |
|---|---|
| 用户 YAML 语法错误 | Host 启动失败，指出文件和行列 |
| 用户 YAML 使用了 `<<` 合并键 | Host 启动失败，指出文件行号，提示改用 `*别名` 或写全字段 |
| 用户 YAML 含重复 key | Host 启动失败，指出重复的 key 与位置 |
| 用户 YAML / persona 超出 4.4.1 或 6.2 的上限 | Host 启动失败，指出具体文件、字段名、实测值与上限值；一律不截断 |
| 未知字段（含拼错的字段名） | Host 启动失败，指出文件、行号与字段名；不静默忽略 |
| 已删除定义的 Agent 被调用（命中 `RetiredToolShell`） | 工具调用拒绝：`banbo-agents: 该 Agent 的定义已被删除（agent: <id>）；修复：重新提供 YAML 并重启` |
| 旧主 Session 的 preset 已被删除 | 官方抛 `agent-preset/not-found`，插件不介入；README 说明这是删除主 Agent 的预期后果，并说明其整棵子树一并不可恢复 |
| 旧 continuable child 因工具名消失而无法冷恢复 | **不应发生**：`RetiredToolShell` 的存在就是为了避免它；一旦出现，视为 ABI 回归并 fail-loud |
| persona 越界 / 过大 / 非 UTF-8 | Host 启动失败，指出 agent id 和路径 |
| preset id 冲突 | Host 启动失败，列出两个来源 |
| 授权图悬空或有环 | Host 启动失败，打印完整边路径 |
| ToolCapability 无法映射 | Host 启动失败，列出目标 DSH 可用工具 |
| 主 Agent 已禁用 | 创建事务回滚，提示 enabled 路径 |
| 子 Agent 已禁用 | 工具调用拒绝，不创建 child |
| 子 Agent 模型 route 无 Provider / model | 子委派前失败，不创建 child，不替换模型 |
| 超过 maxDepth | 原样保留官方深度错误，加 agent/preset 上下文 |
| child identity 写入失败（continuable） | child 创建整体回滚，不发布身份未知的持久 child；one-shot 的 live map 写入是同步内存操作，不引入失败路径 |
| continuable child 的身份缺失 / 损坏 / 版本不支持 | 禁止该 Session 继续 `agent_*` 与 `delegate_batch`；普通工具和对话照常；错误提示恢复 YAML 或重建 child。one-shot 不走这条路径（无持久身份可缺失） |
| child 身份有效但当前 `allowedChildren` 已删除该边 | 该次委派拒绝；不使用身份中的 generation 放宽权限 |
| batch item 指向不存在的 agentId（`batch-target-invalid`） | **契约级**：整个调用拒绝，不启动任何 child；文案按本节统一格式给出修复路径（换一个存在的 agentId，或把该任务交给单个 `agent_<id>`），不只陈述"目标无效" |
| batch item 指向已退役的 agentId（`batch-target-retired`） | **契约级**：整个调用拒绝，不启动任何 child；文案指出定义已被删除、需恢复 YAML 后重启（同 11.2） |
| batch item 目标不在调用者当前 `allowedChildren` 内 | **授权级**：该项失败并附原因，其他合法项继续；不启动被拒项 |
| batch 超过当前 `maxBatchWidth` 或绝对上限 6（`bad-batch-width`） | **契约级**：整个调用拒绝，不启动任何 child；文案给出当前上限，并指出修复路径（拆成多次调用，或复用已有 child） |
| batch `deadlineMs` 非法（0 / 负数 / NaN / 非数字 / 超上限，`bad-batch-deadline`） | **契约级**：整个调用拒绝，不做静默截断；文案给出合法区间 `[60000, 1800000]`，而不是只说"非法" |
| batch deadline 到期 | 返回 `partial_timeout`；未完成项记 `cancel_requested` 或 `cleanup_deferred`，明确提示"该子任务未返回结果，已请求取消" |
| 后台 one-shot 超 `backgroundDeadlineMs` | 按 10.5 第 5 条收束：grace 内收束记 `killed`，否则记 `failed` + "清理已移交 registry"；并发槽在结算时释放，不永久占用 |
| 前台委派超 `foregroundDeadlineMs` | 返回带标注的部分结果；grace 内收束记 `cancel_requested`，否则记 `cleanup_deferred`，不把部分输出当完整结果 |
| holder 在 grace 内未收束 | 所有权移交 cleanup registry，记 `cleanup_deferred`；Host dispose 时 drain，超时则记录未收束清单，不静默吞掉 |
| 并发超限 | fail-fast，不排队；提示等待现有子任务完成、复用 idle child、减少 batch 数量或调高 YAML `maxConcurrentChildren` 后重启 |
| 另一个 Bundle 覆盖 roster roots | Host 启动失败，指出 `agent-presets` 冲突 |
| 不支持的 dsh-tui 版本 | composition smoke 失败，不带 warning 发布 |

settings 外部编辑产生非法结构时，官方 settings service 保留 last-good resolved value 并写 Host warning；Web v1 仍显示最后已提交值，不声称能展示这次外部解析错误。用户结构文件只在启动读取，错误时没有新 runtime，因此不需要热回滚。

### 13.1 运行时可观测性

没有这一节，用户遇到"Batch 跑了 42 秒然后返回 partial_timeout"时无法回答任何问题：哪几个子 Agent 起来了？是模型慢还是 provider 挂了？为什么一直撞并发上限？本插件不做自己的追踪系统，只在**官方已有遥测**（`subagent/start`、`subagent/end`、`agent/status`、jobs 生命周期）之上，补一组最小结构事件。

#### 13.1.1 记录什么

全部写入 **Host logger**，不进 Session 日志、不进模型上下文：

| 事件 | 字段 |
|---|---|
| `delegation/start` | `rootSessionId`、`childId`、`agentId`、`mode`（`one-shot` / `continuable`）、`depth`、`background`。**发出时机按模式不同**：continuable 在 `startContinuable()` 接受首轮后即可发出；one-shot 的 `childId` 只有 `start()` 返回后才知道，因此与 live map 写入同一步发出 |
| `delegation/end` | 上列字段 + `stopReason`、`durationMs`、`outcome`（`completed` / `failed` / `empty` / `cancel_requested` / `cleanup_deferred`） |
| `delegation/rejected` | `agentId`、`reason`（见 13.1.3） |
| `batch/settled` | `rootSessionId`、`itemCount`、聚合 status、`deadlineMs` |
| `holder/orphaned` | `label`（=<agentId>: <bounded description>）、`registeredMs`、`graceMs` |
| `catalog/generation` | `generation` hash、agent 数、是否命中已有 generation 目录（复用 or 新写） |

#### 13.1.2 绝不记录什么

```text
❌ prompt 正文，以及任何子 Agent 的输入
❌ 子 Agent 的输出内容
❌ persona 正文
❌ 凭据、token、API key
❌ 文件绝对路径（只记 agentId 与 preset id）
```

理由是子 Agent 的 prompt 由父模型生成，可能包含用户粘贴的任意内容（代码、密钥、内部资料）。日志系统的保留与导出策略通常比 Session 日志宽松，写进去就很难收回。**这条是硬边界，不因调试方便而放宽**；需要排查具体内容时，用 Session 历史本身，不要复制到日志。

`holder/orphaned` 的 `label` 含 `<description>`，它是唯一一处可能带模型生成文本的日志字段。约束：**截断到 128 UTF-8 字节**，且只允许出现在这一条事件里——它是排障必需（否则无法回答"哪个 holder 没收束"），而该文本本身已经由官方 descriptor 持久化，进日志不构成额外暴露。`delegation/start` 与 `delegation/end` **不携带** description。

#### 13.1.3 拒绝原因必须区分

`delegation/rejected.reason` 必须记录**具体原因**，不能是笼统的 `denied`。当前有六条独立的拒绝路径：

```text
disabled          目标 Agent 被 settings 关闭
edge-denied       当前 catalog 的 allowedChildren 不含该边
depth             remainingDepth <= 0
budget            并发上限已满
retired           命中 RetiredToolShell（定义已删除）
identity-missing  调用者身份缺失 / 损坏 / 不支持的版本（后者只可能出现在 continuable）
```

用户遇到"为什么我的 Agent 不工作"时，这六种对应六种完全不同的修法；合并成一条等于没记。

#### 13.1.4 为什么是 Host logger 而不是 Session event

| | Host logger | Session event |
|---|---|---|
| 影响持久化 ABI | 否 | **是**（需版本化并处理历史 Session，同 11.1.1 的复杂度） |
| 隐私暴露面 | 低（本地日志） | 高（随 Session 一起被读取、导出、同步） |
| 实现成本 | 低 | 中 |

v1 选择 Host logger。若未来需要把路由与成本数据**展示在 Web UI**，再按 11.1.1 的方式引入一条版本化 projection —— 届时需求明确，也知道该展示什么。**不得**为了"先记下来"而把结构事件塞进 Session 日志。

#### 13.1.5 不承诺什么

- 不做独立的 tracing / metrics 后端，不上报任何远端；
- 不承诺采样率或保留期，那属于部署方日志系统的职责；
- 不把 token 成本做成结构化字段：本插件不持有计量器，成本查询走官方已有的 token meter。

---

## 14. 测试与验收

### 14.1 单元测试

1. Agent schema、主/子推导、受约束覆盖、数组/对象替换、完整新增槽位、整体 enabled 和 null 拒绝、未知字段拒绝；
2. DAG、悬空 child、preset/tool/id 冲突、每次调用重算的绝对 maxDepth、main budget 全部字段的默认值/上限/非法值拒绝（含 `maxConcurrentChildren` 的 `[1, 32]` 边界）；
3. **YAML 解析边界**：`<<` 合并键给出专门错误、重复 key 报错、自定义 tag 被拒、`!!timestamp` 被拒、alias 取值复用仍可用（`tools: *t` 应通过）、嵌套 alias bomb 被 `maxAliasCount` 挡住、未知字段报错包含文件与行号；
4. **`CATALOG_LIMITS` 逐项**：每一项的边界值通过、超一字节/超一个元素即启动失败、错误信息含实测值与上限值、确认**不截断**；字节数检查发生在解析之前（用超大文件断言解析器未被调用）；
5. prompt realpath、symlink、UTF-8、64 KiB、persona 总量 1 MiB、缓存快照，以及内置 persona 固定标题/禁止短语/工具名可见性 lint；
6. settings owner validate、includeDefaults、显式 enabled、child default/concrete model、main-only model 拒绝、revision 冲突、保存前拒绝；外部 schema-invalid 与 owner-validate-invalid 两类 section 都断言 resolved value/revision last-good、无 updated/document-updated，并分别断言 describe.user 的真实行为；注册时坏 section 失败；
7. ToolCapability / extraTools → runtime tool name 编译、精确名、profile 缺失、exec fish/bash 解析、strict allowlist；
8. delegateOne 授权、禁用、model preflight、并发占用/释放、one-shot/continuable 选择；
9. 后台 one-shot jobs Task 的单次通知、cancel/Host dispose、`backgroundDeadlineMs` 到期后的 cancel + grace + registry 交接、以及 finally run.dispose；Provider remove 阻止新 start，既有 run 由原 Task 收束；断言挂死的后台 run 不会永久占用并发槽；
10. delegate_batch `maxBatchWidth`、`optional` 目标按 one-shot 执行（不再整体拒绝，且返回值里没有 `childId`）、root Session 并发超限、allSettled、以 `run.result` 为唯一 terminal、deadline、聚合状态真值表、取消和清理；
11. cleanup registry：`cancel()` 幂等、登记早于启动、正常路径自行注销、超时路径被接管、`drain()` 超时记录未收束清单、Host dispose 后无残留 holder；
12. preset compiler：generation hash 稳定性（同输入同 hash、路径无关）、已存在 generation 复用不写盘、`complete` 标记缺失的目录永不激活、指针切换原子性、切换后旧 generation 不影响运行中的进程、清理保留 current + 最近 1 代、重复 id 检测（含 8.7 降级下的唯一例外）、**删除后 generated preset 不再出现在新 generation**、`RetiredToolShell` 空壳保留与执行报错、破坏性 ABI shape 修改拒绝；
13. child identity：**continuable** 在调用 `startContinuable()` 之前把 sidecar 写到 `.children/<childId>.json`，写入原子（temp + rename）、失败导致创建整体回滚；文件缺失 / JSON 损坏 / `version` 不支持 → 身份未知；缺失或损坏的身份只禁止继续委派、不禁止普通工具；身份与官方 descriptor 字段不重复、不同步漂移；**one-shot 不写任何文件**（断言 `.children/` 不因 one-shot 增长），其身份只在 live map 中且 `start()` 返回后立即可查；**batch 并发启动 6 个 one-shot 时，每个 child 的 map 条目必须指向它自己的 agentId**（这是本项的核心回归断言）；**任何路径下断言 Session 日志中不含插件私有事件类型**（Gate A 证否的回归锁）；
14. **`generation` 只做诊断的回归断言**：编辑 catalog（新增一个无关 Agent）使 generation 变化后，一个未受影响的旧 continuable child **仍可继续委派**；反向断言 generation 变化本身不产生任何拒绝。这条锁定 11.1.1 的"generation 绝不是阻断条件"，防止实现者把它当成版本兼容检查；
15. 四个时间预算（`foregroundDeadlineMs` / `backgroundDeadlineMs` / `batchDeadlineMs` / `drainGraceMs`）的默认值、clamp 边界和非法值拒绝；且断言**没有任何一条委派路径缺少 deadline**（前台 / 后台 / batch 三者各有其值）；
16. 可观测性（13.1）：六类结构事件按 13.1.1 的字段发出；`delegation/rejected.reason` 六种原因可区分；**断言日志中不出现 prompt 正文、子 Agent 输出、persona 正文、凭据和绝对路径**（用含敏感标记的 fixture 输入，断言这些标记不出现在捕获的日志里）；Host logger 不产生 Session event。

### 14.2 Bundle 契约测试

- package name、exports、files、patch；
- `npm pack --dry-run` 精确白名单；
- `@deepseek-ai/*` 版本族一致；
- 纯 Node ESM imports 不依赖 workspace-only 路径；
- 唯一 `FORBIDDEN_DELEGATION_TOOLS` 被 catalog validator、preset template 与 extraTools 校验共同导入，没有三份漂移清单；
- patch 只产生一个统一 roster；
- package 和 generated roots 都存在；
- client 模块注册、dispose、HMR；
- **打包产物同时含 Host Remote（`lib/catalog-remote.js`）与 client（`lib/client.js`）**：分别断言 `remoteMethods()` 返回 `['list']` 与非空 marker；缺任一侧时包不可发布（源码通过但构建产物被 `files` 漏掉，是唯一的红点；详见 3.3 与 12.2）；
- client 类型声明可被 `exports['./client'].types` 解析，Web 端不用 `any`；
- Host unload 后 service、Remote、settings namespace、tools 和 prompt sections 全部移除。

### 14.3 真实 composition 测试

在隔离 DSH home 中分别启动：

```text
Web profile + @banbolee/dsh-agents
dsh-tui 0.10.2 profile + @banbolee/dsh-agents
```

至少验证：

1. 两端出现相同内置主 Agent；TUI 自带 roster 自动让位；内置 persona 文件按 5.3 固定标题和禁止承诺 lint 通过；
2. 用户新增 main YAML 后重启出现在两端 picker；删除该定义后重启，picker 里干净消失、Host 不失败、旧主 Session 走官方 `not-found`、其 continuable child 一并不可恢复；对纯 child Agent 的删除只保留 `agent_<id>` 空壳且调用报"定义已删除"；改用 `enabled=false` 可安全停用且保留可恢复性；修改已发布 presetId/toolName、在文件仍存在时删除已发布 main/child 形态或切换 continuation 会被明确拒绝；
3. preset 冲突和另一 roster-owner 冲突 fail-loud；
4. 主 Agent 不接管官方模型选择器：创建 Banbo/Planner/用户 main preset 时不写 `model/selection`、不改 deployment default；Web 中 main-only Agent 的模型编辑置灰；
5. 主 Agent 在 `agent/session-start` 前完成同步首轮前激活门：enabled 判定、`presetId → mainAgentId` 映射校验、persona、tool restriction、guard 全部安装，可见工具自检通过；主 Agent 只看见当前配置的直接 allowedChildren；旧主 Session 冷恢复后绑定当前配置，降权/删边/disabled/main 缺失时 fail-closed；所有 managed preset standing scope 同时注册用户和历史 ABI 工具，但未授权工具不可见、不可执行；
6. child 严格 allowlist 生效，不能直接执行隐藏工具；extraTools 在不同 profile 精确解析；
7. Banbo 深度 2 和 Planner 深度 1 被 wrapper 每次重算 + 官方 header/cap 双重强制；旧 descriptor 即使显示历史下一层工具，在降低 cap 后也执行拒绝；
8. Research / Explorer one-shot 且默认不可见 agent-control；其他 optional Agent 后台 continuable 可 `send_message`；单个后台 one-shot 返回 jobId、只通知一次并总是 dispose；新建 child（含后台 one-shot）占用并发槽并在结算后幂等释放；前台单个委派超 `foregroundDeadlineMs`、后台 one-shot 超 `backgroundDeadlineMs` 时分别按 10.5 收束，都不无限期占用并发槽；
9. `delegate_batch` 的 item 一律 one-shot（目标可以是任意有 `child` 形态的 Agent）：并行、部分失败、`maxBatchWidth`、root Session 并发超限 fail-fast、deadline `partial_timeout`、聚合状态真值表逐条覆盖；`optional` 目标作为 batch item 时走与前台单个 `agent_<id>` 相同的 one-shot 路径，且结果项不含 `childId`；
10. cleanup registry：不合作 holder（忽略 abort 且 `dispose()` 不结算）在 grace 用尽后被接管、batch 按时返回 `cleanup_deferred`、Host dispose 时 registry drain 并记录未收束清单；`cancel()` 重复调用幂等；任何路径下 `run.dispose()` 恰好一次且无 orphan；
11. settings 正常保存、revision 冲突和 owner validate 拒绝；外部坏配置只保留 last-good + Host warning；改模型后新委派生效，现有 continuable route 不变；
12. 禁用不删除工具但调用拒绝；当前会话不被中断；both Agent 不支持分形态启停；
13. 旧 descriptor fixture 在升级后可冷恢复；用户 Agent 定义被删除后 `RetiredToolShell` 保证旧 continuable child 的冻结 `toolFilter` 仍能通过 `tools.restrict()` 并成功冷恢复，但命中该工具的委派执行时明确拒绝；continuable child 冷恢复后，身份缺失时普通工具仍可用、`agent_*` 一律拒绝，身份有效但当前 `allowedChildren` 已删除该边时同样拒绝；**两次启动之间编辑一次无关 catalog 使 generation 变化后，未受影响的旧 continuable child 仍可继续委派**（14.1 第 14 项的端到端复现）；
14. compiler 崩溃 kill-point fixture：在"写 generation 中途""写 `complete` 之前""替换 `current` 之前/之中""清理旧代时"四个点分别中断，验证 `current` 始终指向一个完整 generation、半成品目录永不激活、Host 启动路径不被破坏；并验证指针机制在目标平台可用（symlink / junction / 双路径根按 8.7 顺序）；
15. 普通卸载后无 runtime/plugin 残留：package link、client module、Cordis patch 和 agent-presets 挂载消失，TUI 默认行为恢复；用户数据目录、generated root、ABI manifest（含 retired 空壳记录）默认保留但不再被挂载；
16. 可观测性：一次真实委派后，Host 日志能答出"哪几个 child 起来了、各自 outcome、耗时、为什么被拒"；六种 `delegation/rejected.reason` 均可区分；**用带敏感标记的 fixture 断言日志中不出现 prompt 正文、子 Agent 输出、persona 正文、凭据与绝对路径**；确认这些事件不产生任何 Session event；
17. 全部使用确定性 adapter、模型目录和 Agent loop fixture，不访问网络。

### 14.4 用户验收

用户只读 README 能完成：

1. 在 Web 和 TUI 安装并选择 Banbo；
2. 为 Review 覆盖模型；
3. 新增一个 child Agent；
4. 新增一个 main Agent 并在重启后从 picker 选择；
5. 用 `includeDefaults: false` 只保留自己的团队；
6. 看懂前台等待、后台 continuable、batch（item 一律 one-shot、不可续聊）、并发超限和 `send_message` 复用的区别；看懂"部分结果 / 已请求取消 / 清理已移交"三种终态的含义，不把后两者当成功；
7. 看懂旧主 Session 重启后使用当前新配置继续运行，而旧 continuable child 保持创建时 descriptor；
8. 看懂删除 Agent 的后果（主 Agent 连整棵子树失效、纯 child 只留空壳），知道想停用应该用 `enabled: false` 而不是删文件；并根据错误提示修复一个悬空授权、坏 persona 路径或并发超限。

---

## 15. 阶段 0：必须先过的技术门槛

阶段 0 只做最小原型，不写正式 persona。预计 **6–9 个工程日**。若任一 Gate 失败，需要先回到本方案修订，不计入后续实现排期。

**Gate 只回答平台问题，不回答产品问题。** 区分标准：

```text
平台 Gate（阶段 0）    "DSH 能不能做 X？"        → 几十行探针脚本，跑完即弃
产品验收（阶段 2 内）  "我们的 X 实现对不对？"   → 随产品代码一起写的普通单测
```

阶段 0 的每个 Gate 只验证 **DSH 公开面的事实**：API 是否存在、签名如何、事件顺序、错误行为。

**Gate 不得验证产品行为**。命名工具、授权图、depth 计算、并发计数、batch 状态机、identity 读写逻辑、`RetiredToolShell` 语义都属于产品实现，它们的正确性由阶段 2 的验收测试负责（见 16. 阶段 2 退出条件），**不是**进入阶段 2 的前置条件。这样可以避免"同一批功能在阶段 0 当 Gate 写一遍、在阶段 2 当产品再写一遍"。

### Gate A：目标版本平台能力 —— **已执行，16 项全绿**

探针文件：`plugins/agents/tests/gates/gate-a-target.spec.ts`。命令：

```sh
env NODE_ENV=development npx vitest run plugins/agents/tests/gates/gate-a-target.spec.ts
```

只回答：**目标版本有没有这些能力、签名是什么、边界行为如何**。

**已确认的平台事实**：

| # | 事实 | 影响 |
|---|---|---|
| A1 | 依赖族已整体升级到 `0.1.5-rc.2`；lock 中零 rc.1、524 处 rc.2 | `^0.1.5-rc.1` 在预发布版上会漂到 rc.2，因此族内统一必须靠"整体升级 + 锁文件断言"，不能靠 caret |
| A2 | `@deepseek-ai/dsh-subagent` 的公开导出与 `SubagentRuntime` 方法（`start` / `startContinuable` / `registerProvider` / `getProvider` / `list` / `sendMessage` / `interrupt`）齐全；**`completions` 不存在**（早期草案的笔误，已删除并加负向断言） | §10.4 / §10.5 |
| A3 | `tools.restrict()` 对未知工具名**抛错**而非警告 | `RetiredToolShell` 存在的唯一理由（§4.1 / §11.2） |
| A3b | `ToolRuntime` 依赖 `systemPrompt` 服务：不先挂载它时 `ctx.plugin` **正常返回、不抛错**，但 `ctx.tools` 永远是 `undefined` | 任何组装工具注册表的代码必须先挂 prompt 服务，否则得到静默空注册表 |
| A4 | `Session.append()` 拼装的信封是 `{type,seq,time,data,surfaceOp?,sourceEventSeqs?}`，**没有任何途径写入 `ignorable`**；`validateStoredEvents()` 对未知且非 ignorable 的类型**抛错拒绝解释整份日志**；仓库内已知的 log-only 类型（如 `sandbox/mode`）通过同一校验 | **证否了"私有 Session event 承载身份"的原设计**，改用 sidecar（§11.1.1） |
| A5 | sidecar 契约可用纯 `node:fs` 实现：temp+rename 原子、24 路并发写不同 childId 零冲突零残留、缺失与损坏都归约为"身份未知"而不抛错、0700/0600 权限位可设 | §11.1.1 |
| A6 | `delegationDepthOf` 取 `options.subagentDepth` 与 `session.header.delegationDepth` 的**最大值**（持久 header 是单调下界）；`resolveChildDepth` 超 cap 抛 `SubagentDepthError` | §10.1 / §10.2 |
| A7 | `agent/created` 是**可否决**的发布边界：干净派发时 agent 进入 registry 并收到 created；某个同步监听抛错时整次创建失败、registry 中查不到该 agent | §9.3 的激活门必须同步完成且要么全成、要么不发布 |
| A8 | 用官方 `dsh-agent-loop-testkit` 装配**生产 AgentLoop**（`mountAgentLoopTestDependencies` + `mountAgentLoopTestHarness`，不需要注册 adapter、不联网）后，`agent/created` 在 `agent/session-start` **之前**发出 | §9.3：同步激活门跑在 startup-driving 扩展点之前，因此 persona/restriction 一定在首轮之前生效 |
| A9 | 官方 `dsh-subagent-spawn-in-process`（`access: public`，注册名 `spawn`）产生的是 **local run**，且 `run.id === run.localAgent.session.id === run.localAgent.id`；`start()` 返回时 child 已发布但日志中**尚无任何 `tool/call`**，随后 `dispose()` 正常收束不挂起 | §11.1.1：one-shot 用 `run.id` 作 live map 键，且 `start()` 返回后确实存在写入窗口 |

**Gate A 覆盖边界（如实记录）**：下列事实**已由其它 Gate 或产品测试覆盖**，不再挂在 Gate A 名下——`ctx.jobs` 的真实签名与生命周期归 Gate D，`ctx.settings` 的 revision/last-good 行为归 Gate E，`dshHomePath()` 参与的真实路径表达式求值归 Gate B。

A8/A9 所需的两个官方包（`@deepseek-ai/dsh-agent-loop-testkit`、`@deepseek-ai/dsh-subagent-spawn-in-process`）与 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-subagent-in-process-driver` 均为同族 `0.1.5-rc.2` 公开包，**只作 devDependency，不进 peer/runtime，也不进发布内容**；探针全程无网络、无真实模型。

**Gate A 结论**：原设计的唯一硬性前置（私有 event 写入）被证否，方案已按 §11.1.1 的 sidecar 路径修订；其余所需的公开 API 全部存在且行为符合设计假设。**Gate A 通过（A1–A9 全绿），两项时序事实已由 A8/A9 实测确认。**

### Gate B：Preset root 与双端 roster 平台行为 —— **已执行，6 项全绿（macOS）**

探针文件：`plugins/agents/tests/gates/gate-b-roster.spec.ts`。命令：

```sh
env NODE_ENV=development npx vitest run plugins/agents/tests/gates/gate-b-roster.spec.ts
```

只回答：**patch 里写的路径表达式在两个真实 profile 里解析成什么、官方 roster 怎么反应**。

**已确认的平台事实**：

- DSH Web seat 为 `agent-presets`，dsh-tui 0.10.2 seat 为 `dsh-tui-agent-presets`；用户确认采用双目标 patch，每端命中自己的 row，并通过官方 `composeEntries()` 观察到一条 missing-sibling warning；
- 包内 root 由 `fileURLToPath(new URL('node_modules/@banbolee/dsh-agents/presets/', baseUrl))` 定位；`.pathname` 会在含空格路径留下 `%20` 且在 Windows 产生盘符问题，已由红灯探针证伪并替换；generated root 由 `dshHomePath('banbo-agents', '.generated', 'current', 'presets')` 定位；不依赖 `package.json.dsh.configTrees`；
- 官方 `AgentPresets.roots` 的精确顺序/trust 为 shipped/system → package/system → generated/system → user/user；generated 不会成为 authoring writable root；
- `AgentPresets.list()` 每次扫描；同一实例能看到后写目录，并在 `current` 原子切到新 generation 后保持 root 字符串不变、立即看到新代且旧代消失；
- 真实 `dsh web --dump-config --patch ...` 与 `dsh --profile dsh-tui --dump-config --patch ...` 均 exit 0、命中正确 row、保留 TUI 原有 disabled 表达式，并各产生唯一已知 warning；移除 overlay 后官方 composer 恢复原始 row；
- 本机 macOS 指针机制选择 §8.7 第 1 层 symlink，官方 roster 能穿透到 `presets/`；Windows 必须在 Windows CI 单独验证 symlink/junction，macOS 结果不冒充 Windows 结论；
- Host 启动的 `verifyRosterRoots` 能检测 package/generated root 被其它 Bundle 覆盖。

**Gate B 结论**：Web/TUI 双 profile 的 roster seat、路径表达式、roots 顺序/trust、unmemoized scan、指针稳定性和卸载恢复均符合修订后的双目标设计；macOS Gate B 通过。打包后裸 specifier 与真实 profile install/remove 的端到端验证并入 Stage 5 packed lane，Windows 指针层级保留为平台 CI 门禁。

### Gate C：工具作用域与深度平台行为

只回答：**官方 scoped tool 机制在边界情况下的实际行为**。

- `tools.restrict({ allow })` 在 child 的 scope 上作用于**继承**的工具（global + ancestor），不作用于 child 自己的注册；
- 构造一个"冻结 filter 里含一个已不存在的工具名"的场景，确认 `restrict()` 抛错；再确认"同名空壳仍注册"时不再抛错——这条证明 `RetiredToolShell` 的机制成立，不证明产品实现正确；
- `delegationDepthOf()` 在 cold resume 后不重置，官方 `resolveChildDepth` 在超过 numeric cap 时抛 `SubagentDepthError`；
- `applyChildComposition` 在官方未发布 setup 内被调用，且 persona/toolFilter 在发布前已生效；
- `agentPresets.composeFrom` 的父 composition join 是同步的。

### Gate D：生命周期与清理平台行为

只回答：**官方 run/jobs 在异常路径下的真实行为**。

- `run.dispose()` 的行为边界：正常完成、已 cancel、以及**provider 不合作（忽略 abort 且 dispose 永不 resolve）**三种情况下，`run.result` / `dispose()` 各自的可观测状态；这条决定 10.8 HolderRegistry 是否必要以及是否够用；
- `run.result` 的 settlement 是否恰好一次；`subagent/end` 与 `run.result` 的先后关系；
- `ctx.jobs.start` 能否接住一个由工具自己 abort 的 Task，以及 jobs cancel / owner dispose 时的传播路径；
- `tools/execute` wrapper 能替换 `exec.signal`，且注册表会把替换与上游 signal 融合；
- Provider remove 后新 start 被拒、已发布 run 仍归原 holder；
- **不验证**任何 batch 聚合状态、并发计数或产品级 deadline 语义——那些是阶段 2 的验收内容。

### Gate E：settings 与 Web client 平台行为

只回答：**官方 settings Remote 与第三方 Web card 的接入方式**。

- 官方 settings revision API 的写入路径、`expectedRevision` 冲突行为、外部非法 section 的 last-good 行为与 rc.1 实现一致；
- main preset 创建时官方模型选择器**不**被插件触碰（探针只观测 `model/selection` 与 deployment default 是否被写）；
- 第三方 Web card 能 materialize、调用 Remote、dispose 和 HMR；
- **Remote 构建路线实测**：确认 `remoteMethods()` 在**打包后的产物**上仍返回预期 marker（12.2 路线 A 或 B 二选一，并记录选择理由）；若两条都不可行则停止并回到本方案；
- client 侧类型声明产出路径与 `exports['./client']` 一致，Web 端不使用 `any` 承接 Remote 返回值。

**Gate C 结论（实测，`tests/gates/gate-c-scope-depth.spec.ts`，5 项全绿）**：

- `tools.restrict()` 过滤的是**继承层**（global + ancestor），scope **自身**注册的工具不受影响；本探针同时确认 ancestor 层会被过滤，而 own 层仍可见；
- 冻结 filter 里的名字在没有任何注册时抛 `unknown global tool`；注册同名空壳后不再抛错——`RetiredToolShell` 的机制成立；
- `applyChildComposition()` 同步完成：先 `composeFrom`，再 delegation context，再 persona section，最后 `restrict`，返回时四步都已生效；
- `delegationDepthOf()` 取持久化 header 与 runtime stamp 的较大值，冷恢复不重置；`resolveChildDepth()` 超限抛公开的 `SubagentDepthError`。

**Gate D 结论（实测，`tests/gates/gate-d-lifecycle.spec.ts`，9 项全绿）**：

- `SubagentRun.result` 恰好结算一次，且 `subagent/end` 在调用方的 result continuation 之前发出；
- `SubagentRuntime` 不包装 provider 的 `dispose()`：provider remove 后新 `start` 抛 `NO_PROVIDER`，已返回的 run 仍归原 holder；
- 不合作 provider 的边界由官方 `subprocessRunHandle()` 定义：`dispose()` 先移除 abort listener、再 settle 本地 cancellation、然后等待 backend teardown；teardown 永不 resolve 时 `result` 已结算而 `dispose()` 保持 pending——这正是 HolderRegistry 必须存在且必须够用的平台依据；
- `LocalJobRegistry`（官方 process-local provider）接住 producer 自主 abort 的 Task，`kill` 把 reason 原样传给 `cancel`，owner scope disposal 走 `owner disposed` 并移除记录；
- `tools/execute` wrapper 可替换 `exec.signal`；registry 会把替换值与原始 caller signal 融合成第三个 signal 交给 body，**任一侧 abort 都选中 canonical `ABORTED` 结果**。

**Gate E 结论（实测，`tests/gates/gate-e-settings-web.spec.ts`，5 项全绿）**：

- 官方 settings 的 revision fencing 成立：`mutate(ops, expectedRevision)` 在 stale revision 上抛 `SettingsConflictError`（`code: SETTINGS_CONFLICT`），且不落盘；
- 外部非法 section 经 `publish()` 进来时保留 last-good resolved value 并 warn；
- **构建路线选定 12.2 路线 A**：官方 Typert generator 产出 Host/client descriptor，Host service 上 `remoteMethods()` 返回预期 marker，客户端消费生成的 strict descriptor，**不调用 `remoteMethods()`**；
- classic 客户端 bundle 能 materialize、调用 Remote、dispose，并在替换后不累积 Remote/slot/locale/listener/style 状态；
- 插件不注入也不写入官方 model-selection 表面（manifest inject、Host、client bundle 三处都有负向断言）。

阶段 0 的五个 Gate 现在都有可运行的平台探针，且各自写下了结论与对本文的修订。

### 15.1 Gate 测试与阻断矩阵

| Gate | 建议测试文件 | 只证明（平台事实） | 阻断点 |
|---|---|---|---|
| A | `plugins/agents/tests/gates/gate-a-target.spec.ts` | 从 lockfile 记录精确 `@deepseek-ai/*` 版本（当前为 `0.1.5-rc.2` 统一族，lock 中零 rc.1）；公开 import 与签名；`agent/created` 发布/同步否决语义（A7）；`agent/created` 先于 `agent/session-start`（A8）；one-shot `run.id` = child session id 且 `start()` 返回后 child 尚未有 `tool/call`（A9）；`restrict()` 对 unknown 名抛错；**sidecar（temp+rename 原子、并发不冲突、缺失可识别）**；**反向探针：追加私有事件类型后 persistence 加载必须抛错**；depth 取持久化下界 | 阶段 1 开始前 |
| B | `plugins/agents/tests/gates/gate-b-roster.spec.ts` | Web/TUI 隔离 profile、`!!js` root path 实际解析值、官方 roster roots 组成、system-trust generated root、裸 specifier 解析、后写入目录可被后续 list 看到、让位与卸载恢复 | 阶段 1 开始前 |
| C | `plugins/agents/tests/gates/gate-c-scope-depth.spec.ts` | restrict 作用于继承层而非自身注册；unknown 名抛错与"空壳存在则不抛错"；depth 在 cold resume 后单调；numeric cap 抛 `SubagentDepthError`；`applyChildComposition` 在 setup 内生效；`composeFrom` 同步 | 阶段 2 开始前 |
| D | `plugins/agents/tests/gates/gate-d-lifecycle.spec.ts` | `run.dispose()` 在正常/已 cancel/**不合作 provider** 下的可观测状态；`run.result` settlement 次数；`subagent/end` 与 result 先后；`ctx.jobs` 接住自 abort Task 与 cancel/dispose 传播；`tools/execute` signal 替换；Provider remove 边界 | 阶段 2 开始前 |
| E | `plugins/agents/tests/gates/gate-e-settings-web.spec.ts` | 官方 settings revision/冲突/last-good 行为；模型选择器未被触碰；第三方 Web card materialize / Remote 调用 / dispose / HMR；**打包后 `remoteMethods()` marker 断言**与 12.2 构建路线结论 | 阶段 1 开始前；打包子项在阶段 2 前复跑 |

CI 提供单独的 `agents:gates` lane，不能把 Gate 混在普通单测中靠"总体绿色"代替。阶段 0 PR 只提交探针、fixtures 和对本文的结论更新；A/B/E 未绿不得合入阶段 1，C/D 未绿不得合入阶段 2。每个测试同时断言根 `AGENTS.md` 的包名、依赖族、无 monkey-patch、确定性测试和联动清单约束。

阶段 0 退出条件：五个 Gate 都有可运行的平台探针，且每个 Gate 都写下了"结论 + 对本文的修订"。任何 Gate 失败都先修改本方案，不进入正式实现。

**当前状态：Gate A–E 全部已执行并全绿**（A 20 项、B 6 项、C 5 项、D 9 项、E 5 项）。Gate 探针常驻 `plugins/agents/tests/gates/`，与产品单测分开运行。

**Gate 与产品验收的边界（强制）**：如果一条断言需要"我们的产品代码已经存在"才能运行，它就不属于 Gate，必须移到阶段 2 的产品验收测试里。违反这条会把阶段 0 变成一个提前实现的阶段 2。

---

## 16. 实施阶段

### 阶段 1：包骨架、catalog 和 compiler（5–8 日）—— **已完成**

已完成：

1. ✅ `plugins/agents` 骨架与 manifest（`@banbolee/dsh-agents`、exports、files、`dsh.bundle.patch`）；
2. ✅ 依赖族整体升级到 `0.1.5-rc.2`（6 个插件 + lock + AGENTS.md + README + 契约测试同步；lock 零 rc.1）；
3. ✅ Gate A 探针 16 项全绿（`tests/gates/gate-a-target.spec.ts`）；
4. ✅ `schema.js`：YAML 解析边界（§6.1.1）、单定义校验（§4.4）、预算解析、`CATALOG_LIMITS`（§4.4.1）—— 41 项测试；
5. ✅ `identity.js`：sidecar 身份存储（§11.1.1）—— 21 项测试；
6. ✅ `prompt-loader.js`：persona 两层解析（用户 root → 包内 root）、realpath 包含、严格 UTF-8、双重尺寸上限、单换行归一化 —— 24 项测试；
7. ✅ `catalog.js`：§6.3 受约束合并、跨定义图校验（唯一性 / DAG / presetId / 上限）、§11.2 已发布 ABI 保护 —— 39 项测试；
8. ✅ 内置 catalog：7 个 Agent 定义 + 8 份 persona 骨架，并有集成测试锁定 §5.1 授权矩阵、§5.2 工具面与 §5.3 标题结构 —— 13 项测试；
9. ✅ `presets/` + `templates/`：内置主 preset 的完整 composition、`dsh-standard-inventory.json` 与 digest 门禁（§8.3）—— 含 31 行 standard 行清单的规范化摘要；
10. ✅ `preset-compiler.js`：模板渲染、standard 清单摘要、不可变 generation + `complete` 标记 + 原子 `current` 指针 + `abi.json` + 退役记录携带（§8.4 / §8.6 / §11.2）—— 30 项测试；
11. ✅ `index.js` + `cordis.patch.yml`：Host 侧装配（catalog → generation → roster 自检 → `banboAgents` service）、roster row 整体覆盖（§8.4）—— 18 项测试；
12. ✅ §17 联动：`tests/package-shape.spec.ts` bundle expectation、根 `README.md` 插件表/安装/卸载/数据保留、`scripts/qa/lib/profile.mjs` 映射、插件中英 README 初版。

**阶段 1 结束时插件内合计 202 项测试，全绿；当时整仓 892 passed / 5 项既有失败（§17 末尾）/ 35 skipped。**（阶段 5 的当前总量见该节末尾。）

退出条件（"用户新增 main/child fixture 能生成合法 preset，坏配置在 Host ready 前失败"）已由 `tests/host.spec.ts` 覆盖：写一个 main + child fixture 后 `current/presets/<id>/` 生成且 composition 保留 `{{cwd}}`/`{{model}}`；坏 YAML、缺失 persona、悬空 child 都会在 `initialiseCatalog` 抛出，并且**旧 generation 及其 `complete` 标记原样保留**。

实现过程中由测试暴露并已修正的设计缺口：

- **persona 必须两层解析**：内置定义引用的 persona 在包内，而用户覆盖走 `$DSH_HOME/banbo-agents/prompts/`。§5.3 只说了两处都存在，没说解析顺序；集成测试逼出了这条规则（用户 root 优先，包内兜底）。
- **尺寸 ceiling 量归一化后的文本**，不是磁盘字节：trailing-newline 归一化会让计数正负差 1 字节，而真正常驻内存并进入 prompt 的是文本。
- **`yaml` 对未解析 tag 只告警不抛错**，必须用 `parseDocument` 捕获 `TAG_RESOLVE_FAILED` 升级为错误；alias bomb 的抛错点在 `doc.toJS()` 而非 `doc.errors`。
- **§11.2 的 `validateAbi` 原本把"已发布 Agent 从 catalog 消失"一律判为 `abi-form-removed`**，与 §6.3 / §1569 的"用户删除定义文件是允许的，后果是不可逆退役"直接冲突。修正为按来源区分：**用户**定义的 id 消失 → 允许退役（由 ABI manifest 携带空壳记录）；**包内**定义的 id 消失 → 仍是硬失败（没人能"故意删除"内置 Agent，它消失意味着安装被破坏）。`loadCatalog` 因此把 `builtinIds` 传给 `validateAbi`。
- **`compilePresets` 的 generation hash 必须只吃内容**：模板字节摘要 + ABI 记录（含 `definitionHash`）+ 自身版本 + 依赖族范围，不含宿主绝对路径与用户名，否则同一配置在不同机器上会生成不同 hash（§8.6）。
- **半成品 generation 与"不删非自己内容"的调和**：§8.6 第 4 条要求启动时清理半成品，而同节启动要求第 3 条要求不删除没有本插件标记的目录。做法是给未完成的一代使用 `.partial-` 前缀并在 rename 前写 `complete`，于是"有 `complete` 标记"与"`.partial-` 前缀"就是可证明的所有权，其它目录一律不动。

### 阶段 2：MainRuntime 与 DelegationRuntime（8–12 日）—— **已完成**

1. 实现同步首轮前激活门：顶层 enable gate、`presetId → mainAgentId` 映射校验、main persona、tool restriction、执行 guard 和可见工具自检；主 Agent 模型继续交给官方 Session 模型选择器；
2. 实现 child identity（11.1.1）：continuable 写 sidecar（创建前原子写、失败整体回滚、冷恢复按 childId 读回、缺失/损坏归约为身份未知）；one-shot 的 live map（`start()` 返回后用 `run.id` 建键、结算时删除，无 pending 表）；
3. 实现稳定具名 Agent 工具、`delegateOne` 和 root Session 并发计数器（同步占位、幂等释放）；
4. 实现 strict child allowlist、DAG closure 和统一 depth，并按 identity 做每次委派的当前边授权；
5. 实现 one-shot/background continuable 与 idle continuable 复用规则；
6. 实现 one-shot `delegate_batch`、单一 deadline、聚合状态真值表和并发 fail-fast；
7. 实现 HolderRegistry（10.8）：前台 deadline、grace 收束、所有权交接和 effect-scoped drain；
8. 实现 `RetiredToolShell` 在 standing scope 的注册与执行拒绝。

**产品验收（阶段 2 的退出条件，等价于旧 Gate C/D 的产品部分）**：这些测试随产品代码一起写，是普通单测，不是平台 Gate。

| 文件 | 覆盖 |
|---|---|
| `plugins/agents/tests/delegation.spec.ts` | 命名工具可见性、直接边 allowlist、统一 forbidden delegation denylist、`extraTools` 精确边界、remainingDepth 重算、continuable identity 缺失/有效两种冷恢复路径、one-shot live map 在并发 batch 下的正确归属 |
| `plugins/agents/tests/budget.spec.ts` | 同步原子占位、幂等释放、并发超限 fail-fast 不排队、batch 一次性占满 N 槽 |
| `plugins/agents/tests/batch.spec.ts` | 聚合状态真值表逐条、`optional` 目标按 one-shot 执行且返回值无 `childId`、deadline `partial_timeout`、工具 `timeoutMs` 层级、registry 交接与 `cleanup_deferred`、不合作 holder 无 orphan |
| `plugins/agents/tests/resume.spec.ts` | main current-policy resume、`RetiredToolShell` 让旧冻结 filter 通过 `restrict()`、退役目标执行拒绝、删除后 preset 不再出现在新 generation、continuable 身份 fail-closed 降级 |

退出条件：

- 默认团队在确定性 Agent loop 中走通两层委派，权限、深度和并发上限均由运行时强制；
- 删除一条已发布委派边后重启，旧 continuable child 的该次委派被拒绝，而其普通工具仍可用；
- 上表四个测试文件全绿，且**不依赖任何 Gate 探针代码**（探针是一次性的，不进入产品路径）。

### 阶段 3：正式 Agent 内容与文档（4–6 日）—— **已完成**

1. ✅ 写 7 个内置 Agent 的主/子 persona；
2. ✅ 按 5.3 规范完成 persona lint：固定标题（**唯一**且顺序固定）、每节非空、职责/非职责、工具策略、委派协议、失败策略和禁止承诺检查；工具名可见性检查从 shipped 的 capability→runtime 名字表派生，而不是手写清单；
3. ✅ 工具 guidance 明确"何时用 / 何时不用"；
4. ✅ 主 persona 加入等待、后台、batch、send_message 协议；
5. ✅ 完成中文 README 和英文 README，包含普通卸载保留数据、破坏性 purge 手工步骤、**同名 persona 自动覆盖**、团队/形态/continuation 表、前后台/batch 语义、部分状态与并发 fail-fast、settings 示例、current-policy 与冻结 descriptor 的区别、sidecar 可移植性、Web 卡与构建排障，以及 §18 要求的三条非承诺与 `enabled: false` 优先于删除的推荐做法；
6. ✅ 固定内置 preset id、Agent id 和工具名 ABI。

退出条件：

- 每个 Agent 都有符合 5.3 的 persona、职责/非职责、工具、授权、失败策略和示例；persona lint 绿色（`tests/builtin-catalog.spec.ts` 21 项）；
- README 中英双语一致，且**每条对外承诺都能在本文找到对应章节**（不允许 README 出现本文没有的行为描述）；
- persona lint 测试全绿，且不依赖 Gate 探针代码。

### 阶段 4：Web 卡与双端集成（6–9 日）—— **已完成**

1. ✅ 实现只读 CatalogRemote（12.2 的接口契约 + Gate E 选定的路线 A 构建）；
2. ✅ 实现设置卡、动态 Agent 列表和 model/enabled 编辑（官方 `settings.plugin.item`，key `banbo-agents`）；
3. ✅ 完成 client unit、ModuleLoader、HMR 与替换不累积状态；
4. ✅ 完成 Web/TUI 隔离 profile composition（Gate B 双目标 patch）；
5. ✅ 完成安装、升级、普通卸载测试，并验证用户数据默认保留且不再被运行时挂载（Stage 5 的隔离 tarball install/remove lane）。

退出条件：

- ✅ 不编辑 YAML 也能启停和改模型；编辑 YAML 后重启能新增主 Agent；
- ✅ **打包产物上 `remoteMethods()` marker 断言通过**（12.2 / 14.2），且客户端消费生成 strict descriptor、不调用 `remoteMethods()`，Web 端无 `any` 承接 Remote 返回值；
- ✅ 普通卸载后 TUI 默认 roster 恢复，且用户数据目录仍在但不再被挂载。

**静态/live 拆分（实现中定稿）**：CatalogRemote 只返回**启动期固定**的 catalog 视图（当前/退役行、无 persona、无路径、无 composition、无 settings）；live 的 enabled/model 状态**唯一**来自官方 `settingsScope`。因此改设置不会也不会需要重新 mount Remote。

### 阶段 5：加固与发布（5–8 日）—— **已完成（发布项由用户决策暂缓）**

1. ✅ 跑完整测试、`npm pack` 和纯 ESM 检查（`tests/packed.spec.ts`：真实 `npm pack`、tar 条目白名单、禁止源码/构建配置泄漏、解包后纯 ESM import Host 与 typert descriptor、client 为经典 ModuleLoader 工厂）；
2. ✅ 更新根 README、QA profile 映射、契约测试与 docs-shape；
3. **⏸ 发布 prerelease — 用户已决策暂缓**：用户明确选择"先不发布，保持当前分支状态"；`package.json` 的 `version` 保持占位的 `0.0.0`，版本号留待用户需要时决定。发布需要 npm 凭据与版本号决策，属用户侧动作；
4. **⏸ 真实但 opt-in 的 Provider lane — 未跑**：需要真实凭据并会产生费用，计划本身将其定义为 opt-in；确定性替代证据是 `tests/catalog-remote.spec.ts`、`tests/client-lifecycle.spec.ts` 与 `tests/batch.spec.ts`；
5. **⏸ 真实 opt-in 委派 + 六类结构事件核对 — 未跑**：真实 lane 未执行；但 13.1 的六类结构事件与负向断言（日志不含 prompt 正文、子 Agent 输出、persona 正文、凭据与绝对路径）已由 `tests/observability.spec.ts` 常驻覆盖。

已完成的可复现证据：

- **隔离真实 install/remove**：用 `npm pack` 产出的 tarball 在临时 `DSH_HOME` 里 `dsh plugin --profile stage5 add -w <tgz>`（exit 0），`--dump-config` 中出现 `- id: banbo-agents / name: '@banbolee/dsh-agents'`；`remove` 后 dump 中该行计数为 0。裸 profile 两条 roster row 都不存在，因此出现两条 missing-sibling warning，与双目标设计一致。
- **clean build**：删除 `lib/` 后 `node scripts/build.mjs` exit 0，产出 `catalog-remote.*`、`client.js`（约 218.51 kB）、`typert.host.*`、`typert.remote-client.*`、`types/**`。
- **Gate lane 独立**：`pnpm test:agents:gates` = 6 文件 / 45 项全绿；普通 `pnpm test` 已通过 `vitest.config.ts` 排除 gates 与 packed，避免用"总体绿色"代替 Gate 结论。

退出条件：

- §18 的发布硬门槛逐条勾选完毕，**不允许"warning 后继续发布"**；
- 阶段 2 的四个产品验收测试与阶段 3 的 persona lint 全部在 CI 常驻（不是一次性手工验证）；
- 13.1 的可观测性断言在 CI 中稳定通过（含"日志不含敏感标记"的负向断言）。

**当前测试总量**：本插件内 **379 项**（330 产品单测 + 5 个 Gate 文件 45 项 + packed lane 4 项）全绿；整仓普通 lane `1044 passed / 5 failed（§17 记录的既有 macOS 基线）/ 36 skipped`；gates lane `49 passed`。

**已知未完成项（如实列出，不含在"已完成"内）**：prerelease 发布（用户决策暂缓）；真实 provider opt-in lane 与真实委派观测验证（需真实凭据，计划定义为 opt-in；确定性替代证据见 `observability.spec.ts` 与 `batch.spec.ts`）；§8.7 第 3 层降级（**用户已决策不实现**，理由见该节）；Gate B 的 Windows 真机 roster 验证未做（**用户已确认当前 Windows CI 范围**：只跑单元套件与不需要真实 profile 的 Gate A/C/D/E，不含 Gate B）。

### 16.1 独立代码审查与缺陷修复（2026-xx）

一次由独立 agent 执行、随后逐条人工核实的只读审查发现 6 项问题，**全部已修复并补上回归测试**：

| # | 严重度 | 缺陷 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | 高 | 已发布 `SubagentRun.result` **reject** 时（官方允许的基础设施故障），foreground/background/batch 三条路径都跳过清理：官方 run 从不 `dispose()`、holder 不结算、并发 lease 永久泄漏、live identity 残留 | 三条路径各加**幂等 `finally`**，把清理绑定到真实结算边界（`cleanupOneShotOnSettlement`） | `delegate-one.spec.ts` foreground + background、`batch.spec.ts` 各一项 |
| 2 | 中 | `readAbiManifest` 的 catch-all 把"损坏/不可读"与"不存在"混为一谈，损坏 `abi.json` 会**静默关闭** §11.2 的 ABI 保护（fail-open） | 只有 `ENOENT` 返回 `undefined`；损坏/不可读抛 `CatalogError`；`readPreviousAbi` 在指针存在但 manifest 缺失时 fail-loud | `host.spec.ts` 损坏、缺失、以及"指针不存在仍属合法首次启动"三项 |
| 3 | 中 | 多进程同时编译同一 hash 时，`removePath(generationDir)` 可能删掉对端**已完成**的 generation，与 §8.6 的承诺不符 | 删除前重新确认完整性；完整代一律复用；partial 名加随机后缀；rename 失败时采纳对端已发布的同 hash 代；prune 时重读 `current` 并保留其目标 | `preset-compiler.spec.ts` 采纳完整代、清理不完整同名目录两项 |
| 4 | 中 | §8.7 只实现了 symlink，Windows 无回退；CI 无 Windows job | 实现 **junction 回退**（绝对目标、免管理员权限）；新增 Windows CI job 与 Windows-only 指针探针 | `preset-compiler.spec.ts` 平台分支探针（POSIX 断言 symlink；Windows 断言可读，macOS 上跳过） |
| 5 | 低 | §13.1.1 要求的第六个事件 `catalog/generation` 从未发出 | Host 启动成功后发出，字段精确为 `{generation, agentCount, reused}`，不含路径与 persona | `host.spec.ts` 字段集与隐私负向断言 |
| 6 | 低 | 身份 sidecar 会静默覆盖同名记录，回滚无条件删除，安全性只靠 UUID 不撞 | 写入改为**不覆盖**（`link` 原子 create-if-absent，内容相同视为幂等重试，不同则 `already-exists`）；回滚仅在内容与本次写入完全一致时删除 | `identity.spec.ts` 幂等重写、拒绝覆盖、回滚命中、回滚不误删、缺失返回 false 五项 |

审查中被判定为**误报**并已排除的两条：`settingsScope.watch` 未保存 disposer（官方 registration 由 fiber effect 所有，卸载即移除 observers）；Gate A 的 sidecar 探针使用本地 helper 而非 `identity.js`（这是计划强制要求的——Gate 不得依赖产品代码，真实实现由 `identity.spec.ts` 覆盖）。

### 16.2 persona 身份行被静默覆盖（缺陷 + 修复）

**缺陷**：preset 组合模板照抄官方 `standard`，在 `dsh-persona` row 上同时配了 `prefix`（"You are a coding agent powered by the {{model}} model."）与 `suffix`（cwd）。但本插件的每个 Agent 都会把自己的 persona 注册进 **同名** section `deployment:persona-prefix`（官方的 `applyChildComposition` 对子 Agent 做同样的事），而官方语义是：

> A scoped section **shadows** a global section with the same name; duplicates within one layer and non-finite orders throw.

且按作用域链 merge、最近的赢（已由 `main-runtime.spec.ts` 的实测锁定：preset 注册 `PRESET-PERSONA-SHADOWED`、agent 注册 `AGENT-PERSONA`，组装后只剩后者）。结果是**每一个 banbo Agent（main 与 child）都看不到那句身份行**，模板里的 `prefix` 成了永远不生效的死配置。

**修复**：

1. 身份行改由 `main-runtime` 以**自己的 section 名** `banbo:identity` 注册，order 复用 `DEPLOYMENT_PERSONA_PREFIX`（0）。名字不同 → 永不被覆盖；同名同序时按名字排序，`banbo:identity` 在前，于是阅读顺序是"身份行 → Agent 自己的 persona"；
2. 注册在 **preset 作用域**而非每 Agent，因此 main 与委派出的 child **都**能拿到（child 通过 `composeFrom` 加入父的 preset 作用域）；
3. 模板 `dsh-persona` row 的 `prefix` 删除（死配置），并重新生成 `presets/banbo|planner/agent.cordis.yml` 保持逐字节一致。

**同批修正的测试质量问题**：`gate-c-scope-depth.spec.ts` 的 C1 原本只证明了"过滤 global 层"——`createScope` **不会**从铸造上下文推断父子关系，必须显式传 `{ parent }`，因此该用例的 ancestor 层从未建立。已补上显式作用域链，并增加一条"未过滤前 child 能看到 ancestor 工具"的前置断言，使其真正证明"restrict 作用于继承层（global + ancestor）"。

**新增的一致性 lint**：`builtin-catalog.spec.ts` 断言 4 份 continuable child persona 的共享机制句**逐字节一致**（各自前面的引子句是 Agent 专属、允许不同）。重复是刻意的（每份 persona 自包含、可单独覆盖），这条 lint 是防漂移的唯一保障；已用变异测试验证：只改其中 1 份会**恰好**让 1 项失败。

### 16.3 第二轮独立审查与修复（checkpoint `77cc1a5` → 全部关闭）

独立 agent 对 checkpoint `77cc1a5be6eec8ef242e1186de79ba68b3c3eb28` 做完整审查后给出 **FAIL**：1 high / 3 medium / 9 low+nit。**13 项全部已修复并配回归测试**。

| # | severity | 缺陷 | 修复 |
|---|---|---|---|
| F1 | **high** | **`dsh plugin add -w ./plugins/agents` 的链接安装无法启动**：roster 存的是符号链接路径，而 Node 解析后 `import.meta.url` 给出真实路径，`normaliseDir` 只做词法 `resolve()` → 误报"另一个 bundle 覆盖了同一 row" | `normaliseDir` 增加 `realpathSync`（路径不存在时回退词法）；新增符号链接双向回归测试 |
| F2 | medium | `main.budget` 里的**拼错字段被静默忽略**（`maxConcurrentChilds` → 悄悄用默认 6），与 §6.1.1「未知字段必须失败」冲突 | `KNOWN_KEYS` 增加 `budget` 层；`validateBudget` 拒绝非 mapping 与未知键并带 file/line |
| F3 | medium | 所有 deadline/grace 的 `Promise.race` 定时器**从不清理**：委派结束后事件循环仍被拖住整个 deadline（默认前台 15 分钟），且每次委派保留一个活跃定时器 | 新增 `deadline.js`（`armDeadline`/`raceWithDeadline`）：生产定时器 `unref` 并在 race 结束后 `clearTimeout`；6 处 race 全部改用它；新增 8 项测试，含**子进程证明**未被拖住 |
| F4 | medium | §18 声称安装/卸载有 CI lane，实际只有手工散文证据 | 新增 opt-in 的 `gate-f-install.spec.ts`（真实 `npm pack` + 隔离 `DSH_HOME` + 真实 `dsh` 的 install/dump/remove + 用户数据保留断言），CI 显式开启该 lane；§18 改为「由该 lane 强制」 |
| F5 | low | Remote 的 `mainBudgetSummary` 只投影 `maxDepth`，把嵌套 `budget` 全漏掉，Web 卡"主 Agent 预算"显示的是深度上限 | `numericBudget` 合并 `main.budget`；测试 fixture 与期望同步 |
| F6 | low | 四处断言名不副实：拒绝原因表只对手工构造的 error 生效；`delegation.spec` 只断言"是 DelegationError"；`resume.spec` 断言测试自己拥有的 Set；`delegation-runtime.spec` 因 mock 返回 `undefined` 而"通过" | 分别改为：断言真实调用点的精确 code（并新增真实路径的 `delegation/rejected` 断言）、断言四个 code、断言失败不粘滞且下一次委派仍成功、用合法 run + 断言 `request.parent === exec.agent` 与 abort 传播 |
| F7 | low | 冷恢复深度只用鸭子类型对象验证，无真实持久化重建 | 新增真实 fixture：官方 JSONL 后端落盘 → **全新 Context** 读回 → 断言 `delegationDepth`/`parentSession`/`agentPreset` 存活且官方深度算术仍拒绝越级（新增 devDependency `dsh-session-persistence-jsonl`） |
| F8 | low | 客户端 dispose 不删除自己注入的 `<style>`，Gate E 用手动补偿掩盖 | `installClientStyle()` 返回 disposer 并进 rollback；删除 Gate E 的手动补偿，改为断言 dispose 后样式归零；materialize 不再有样式副作用 |
| F9 | low | 退役行只有一句通用文案，§12.1 要求按形态区分 | 拆成 `retiredMainHint`/`retiredChildHint`（子树不可恢复 vs 新委派被拒），按 `forms.includes('main')` 选择；新增双语 key 一致性测试 |
| F10 | low | README 与 §18 仍写 sidecar 是 `temp + rename`，实现已改为 `link` create-if-absent | 中英 README 与 §18 同步为「临时文件 + `link` 原子 create-if-absent，不覆盖、幂等重试、`already-exists`、无硬链接时回退检查式 rename」 |
| F11 | low | `.partial-*` 崩溃残留的清理分支无测试（§14.3 item 14 的四个 kill point 只覆盖两个） | 新增测试：植入 `.partial-<hash>.<pid>.<uuid>` 后编译必须清掉它、保留指针与活动代 |
| F12 | low | 重复 preset id 检查在 `initialiseCatalog` **之后**，该失败类别下新代已被激活，与「失败即不激活」矛盾 | 把 `verifyRosterRoots` 与 `findPresetIdConflicts` 提到编译之前（期望根是 `rootDir` 的纯函数），并加内部不变量断言 |
| F13 | nit | 三处过时文本：模板注释指向不存在的 `tests/preset-template.spec.ts`；`vitest.gates.config.ts` 声称普通 lane 不需要构建；`package-shape.spec.ts` 仍写 "rc.1 family" | 逐条改为与实现一致 |

**顺带修掉的测试质量问题**：F6 的修复过程中发现 `gate-c-scope-depth.spec.ts` 的 C1 只证明了 global 层过滤（`createScope` 不会从铸造上下文推断父子链），已补显式 `{ parent }` 与"未过滤前能看到 ancestor 工具"的前置断言；F6(b) 的精确 code 断言还暴露出**边授权检查先于目标检查**这一真实顺序（`retired` 目标若不在 `allowedChildren` 中先得 `edge-unauthorised`），测试已按真实语义重写。

**打包护栏**：新增「发布包必须包含入口文件相对引用的每个模块」断言（`packed.spec.ts`），杜绝「新增运行时模块忘了加进 `files`」这类只能装完才炸的错误。

**依赖族漂移与钉死（本轮期间上游发布 `0.1.5-rc.3`）**：§15 的 A1 早已记录「caret 在预发布版上会漂移，族内统一不能靠 caret」。本轮实际撞上了：为 F7 添加 devDependency 触发 `pnpm install`，`^0.1.5-rc.2` 让 **12 个包**漂到 rc.3，仓库自己的 `tests/fish-shell-dependency-graph.spec.ts` 立刻变红。经用户决策，采用**根 `pnpm.overrides` 把整个 `@deepseek-ai/dsh-*` 族（66 个包）钉在 `0.1.5-rc.2`**；`.npmrc` 注明「列表必须保持完整，漏掉的包会再次漂移」。

实验记录（供后来者少走弯路）：只钉当时漂移的 12 个包**不够**——`pnpm.overrides` 对 auto-install 的 peer 生效的前提是该包本身也在 override 列表里（`dsh-http-proxy` 就是这样漏掉并漂到 rc.3 的）；通配符 `@deepseek-ai/dsh-*` 不被 pnpm 支持；关闭 `auto-install-peers` 虽也能让 rc.3 归零，但会让 `dsh-subprocess` 等包硬 import 的 peer 解析不到，导致 11 个测试文件失败，因此**不采用**。副作用一处：pnpm 会把被 override 的 specifier 记为固定版本而非声明的 range，`tests/package-shape.spec.ts` 的对应断言已按真实语义放宽（版本基线断言保持不变，漂移仍会被抓住）。

### 16.4 第三轮独立审查与修复（checkpoint `6ca673d8` → 5 项全部关闭）

同一个常驻 reviewer 对 checkpoint `6ca673d8fc0ccd9c2434acbd6534894a6428283b` 的完整复审：13 项第二轮发现**全部确认修复**，但给出 **FAIL**：2 high / 1 medium / 2 low。五项全部已修复并配回归测试。

| # | severity | 缺陷 | 修复 |
|---|---|---|---|
| N1 | **high** | **退役在代码里不可逆，而所有产品内修复指引（含计划 §12.1）都让用户"把 YAML 放回去"——照做会让整个 Host 启动失败**（`abi-retired-revived`） | 按 §12.1 修：`validateAbi` 不再拒绝复活的 id，改为对其施加**同样的收窄检查**（不得删已发布形态、不得改 preset id、不得切 continuation）；`computeAbiManifest` 只在 id 仍缺失时才保留空壳。计划 §11.2 的"不可逆"改为明确指"空壳记录本身永久"，README 双语补上 §12.1 要求的边界与"改语义请换新 id"建议 |
| N2 | low | `run.result` reject 时 `logDelegationEnd` 被跳过，`observations` 条目永不删除（每次基础设施故障泄漏一条） | 在三条路径各自的 `finally` 里删除该条目。**第一次尝试把它放进 `cleanupOneShotOnSettlement` 是错的**：`logDelegationEnd` 需要读该条目生成 end 记录，而 settlement 可能先结算——现有 `observability.spec.ts` 立刻抓出了这个错误顺序 |
| N3 | **high** | **子 Agent 的 capability 按"调用者被限制后的可见工具集"解析**，导致默认团队两条已发布边永久不可用：`Planner(main) → Review`（Review 需要 `exec`）与 `Review → Research`（Research 需要 `web`），且报错还甩锅给"composition 没有注册"这个工具 | 新增 `compositionToolNames(ctx)`：按 **preset 作用域**（`scopeOf(ctx)`）解析 composition 注册表，不再用 `schemas(parent)`；调用者的可见性仍由 `isToolVisible` 单独决定。新增 `tests/delegation-composition.spec.ts`：用真实 `SystemPrompt` + `ToolRuntime` + 作用域链，遍历 shipped §5.1 **每一条边**并走**真实插件路径**驱动具名工具 |
| N4 | low | `backgroundDeadlineMs` 路径从未被测试（§14.1 item 9 要求） | 新增两项：合作型 provider → `killed` + 槽位释放；不合作 provider → `failed` + `cleanup_deferred` + registry 保留持有但**槽位仍释放** |
| N5 | medium | settings 注册失败这一类仍会先激活新 generation（F12 修的同一类缺陷，再往后一步） | `apply` 捕获激活之后的任何失败并 `restoreGenerationPointer(rootDir, previousGenerationDir)` 回滚指针（无前代则移除指针）；新增两项测试分别覆盖"有前代"与"首次启动"两种回滚 |

**N3 的回归测试是变异验证过的**：把修复回退后，该套件报出与 reviewer 完全相同的错误（`planner -> review failed: capability "exec" needs one of bash, pwsh, none of which this composition registers`）；修复后通过。这一点很关键——N3 的第一版测试直接调 `prepareDelegation` 并自己传 `registered`，**回退修复后仍然全绿**，是空的；必须走真实插件路径才能覆盖 `runtimeForCall` 的推导。

**为什么这些缺陷此前没被抓到**：N3 逃过了所有既有套件，因为每个 fixture 都传一个完整的 `REGISTERED` 集合，唯一接了真实受限 `ToolRuntime` 的 `main-runtime.spec.ts` 从不调用 `prepareDelegation`。教训是"fixture 比生产更宽松"会系统性地掩盖这一类缺陷。

### 16.5 真实模型端到端测试（dsh-tui + light 网关）——暴露 3 个确定性测试全部漏掉的缺陷

前三轮 19 项发现全部关闭、reviewer 给 PASS 之后，按用户要求做了**真实 profile + 真实模型**的端到端测试（`dsh-tui` + provider `deepseek` 的 `deepseek-v4-flash` / `deepseek-v4-pro`）。**前两轮修完的插件在当时仍然完全不可用**：确定性测试网再密，也测不到"官方 schema 是否接受这份 composition"和"目标 profile 到底注册了哪些工具"。

| # | 级别 | 缺陷 | 证据 | 状态 |
|---|---|---|---|---|
| R1 | **blocker** | 模板的 `dsh-persona` 行删掉了 `prefix`，但官方 schema 是 `prefix: z.string().required()` | 真实挂载：`preset "banbo" failed to mount: $.prefix missing required value` | **已修**：补 `prefix: ''`（满足 schema 且不产生重复身份行，身份行仍由 `main-runtime` 的 `banbo:identity` 提供） |
| R2 | **blocker** | `exec` 能力写成 `anyOf: [bash, pwsh]`，而 §5.2 明确要求"**优先 fish**，否则 bash"。dsh-tui 禁用了 `tool-bash`/`tool-pwsh`，shell 工具叫 `fish` | 真实启动：`failed to create agent: capability "exec" needs one of bash, pwsh, none of which this composition registers` | **已修**：引入 `prefer` 单选优先序 `['fish','bash','pwsh']`，恰好授予一个 |
| R3 | **blocker** | 子 Agent 的 capability 拿不到 composition 注册表：解析用的是**调用者被裁剪后的清单**，于是"目标需要调用者没有的工具"这类边永久失败 | 真实委派：`Agent_explorer(...) → Error: capability "read" needs read, which this composition does not register`（第三轮修复版）；回退后 `Planner→Review` 报 `capability "exec" needs one of fish, bash, pwsh` | **已修**（用户决策：存快照），见下 |

**R3 的根因与修复（用户选定"方案 1：存快照"）**：

真正的原因是**跨包模块实例不一致**，不是"composition 按 agent 挂载"（后者是错的，见下）：

- `dsh-scope` 用 `kScope = Symbol("dsh.scope")` 标记作用域，而这个 Symbol 是**模块私有**的（不是 `Symbol.for`）。
- 本插件的 `dsh-tui` 安装是 `link:`（`profiles/dsh-tui/node_modules/@banbolee/dsh-agents -> <repo>/plugins/agents`），因此它从**仓库的 store** 解析 `@deepseek-ai/dsh-scope`，而 harness 用**自己那份**（全局 dsh 安装）——两份 realpath 不同。
- 于是 `ctx[kScope]` 在插件侧读不到 harness 打的标记，`scopeOf(ctx)` 返回 `undefined`，`schemas(undefined)` 退化成**只剩全局层**（真实探针：`fish`、`lsp_diagnostics`、`mcp__*` 共 11 个，没有 `read`/`glob`/`grep`）。
- 单份模块实例时同一个 Loader 形状的 row ctx **能**读到标记（探针验证 `{ agentPreset: 'banbo' }`），所以这个错误在 monorepo 内部可被"证伪"。

**因此这里有一条可复用的规则**：**永远不要依赖跨包模块身份**（模块私有 Symbol、`instanceof`、跨包共享的可变单例）。对照 `@deepseek-ai/dsh-brand`——它被显式设计为"重复安装安全"，两份副本产生可互换的值；`dsh-scope` 的私有 `kScope` 则不是。

**同时纠正一个错误说法**：composition **不是**按 agent 挂载的。`AgentPresets.ensureStanding` 按 preset id 缓存唯一一次挂载，`mount()` 把每个 agent 的 key 绑到那个共享 standing key 上。（如果真是按 agent 挂载，并发预算和 holder registry 就会变成每子 agent 一份，那是严重得多的缺陷。）

修复：**主 Agent 激活时把"裁剪前的完整工具面"存下来，按 preset 共享**。这是唯一能观察到 composition 完整注册表的时刻。

- `index.js`：`banboAgents` service 增加 `compositionTools: new Map()`（按 preset id 键，避免 banbo/planner 两套 composition 互相覆盖）
- `main-runtime.js`：在 `tools.restrict()` **之前**算出 `before` 后 `service.compositionTools.set(expectedPreset, before)`
- `delegation.js`：`compositionToolNames()` 优先读快照；没有快照时回退到调用者视图（fail closed，不静默放宽）

**已排除的两个错误来源**（写进代码注释防止回归）：`schemas(parent)`（调用者裁剪后的视图，满足不了 R3 的边）与 `schemas(scopeOf(ctx))`（生产里退化成全局视图，比前者更糟）。

**真实端到端验证**：`Banbo → Planner → Review` 三层链路在真实 dsh-tui + 真实模型下跑通，session 日志确认 `depth=0 / depth=1 / depth=2` 三层会话真实存在，且 maxDepth=2 上限正确生效。修复前的两条死边（`Planner→Review`、`Review→Research`）现在都能解析。

**测试网补强**：`tests/delegation-composition.spec.ts` 重写为两条互补断言——(1) 装入快照后**每一条 shipped §5.1 边**都必须解析成功（变异验证：去掉快照消费即复现 `planner -> review failed: capability "exec" ...`）；(2) 没有快照且调用者缺该工具时**必须 fail closed**。同时删除了编码 `scopeOf` 假模型的那条测试。

### 16.6 第四轮审查：确定性网补强（N7/N8/N9）

第四轮审查确认 R1/R2/R3 全部修复，并**独立复现**了三个机制；它同时纠正了我的一个错误结论，并指出真正的 blocker：**确定性测试网看不到产生这三个 blocker 的缺陷类别**。

**N8（medium，本轮修复）—— 用变异证明的网洞**：把 `prefix: ''` 从模板和两份 preset 里删掉（即 R1 的原始状态），整个插件套件**仍然全绿**（`PASS (383) FAIL (0)`）。原因是 §8.3 的 digest gate 只比较**派生出的工具名**，`managed.rows` 从未与 `official.rows` 比较；而 Gate B 虽然构造了真实 roster，却只对 probe preset 调 `list()`，从不挂载 `banbo`/`planner`（`--dump-config` 也不挂载）。

修复两条（都是 model-free）：

1. **逐行 config 形状 gate**（`preset-compiler.spec.ts`）：对每一个"官方与我们都有"的行（当前 23 行），断言 **config 键路径集合（递归含数组）、`isolate`、`disabled` 三者与官方 `standard` 完全一致**；8 个故意移除的 id 与 3 个新增 id 显式列出，并带空转保护（`shared.length > 20`、`managedById.size - shared.length === 3`）。**变异验证**：删掉 `prefix` 立即报 `row persona: config shape drifted from official: expected [ 'suffix' ] to deeply equal [ 'prefix', 'suffix' ]`。
2. **跨插件 shell 契约 gate**（`tool-surface.spec.ts`）：读 `plugins/fish-shell/cordis.patch.yml`，断言它确实禁用 `tool-bash` 且挂载 `tool-fish`，然后断言 `CAPABILITY_TOOLS.exec.prefer` **以 `fish` 开头**且含 `bash`/`pwsh`。**变异验证**：把 `fish` 从 prefer 移除立即失败（`fish must win: ... expected 'bash' to be 'fish'`）。

**没有做"真实挂载整份 composition"**（审查建议的第二条），原因是实测不可行：`standingKeyFor()` 需要 21 个官方插件从 `ctx.baseUrl` 可解析，且最终报 `mounted subtree did not publish its entry tree`——审查独立复核了这一点，并给出决定性对照：**官方自带的 `standard` preset 走同一条路也报同样的错**，说明这是结构性限制（`mountPreset` 无法脱离真实 Loader 运行；补一个 stub `loader` 只会前进到 `this.loader.getTasks is not a function`），与本插件的行、模板或 baseUrl 无关。因此真实挂载等同于在 gates lane 里启动一次完整 profile，不做。已用上面的两条 gate 覆盖同一缺陷类别（R1 的字段缺失、R2 的 shell 名不一致）。

**残余风险（明确记录：这一类别没有机器检测）**：**"上游把某个包内部的 runtime tool 改名、但 composition 文件的行/config 键集合不变"这一类，当前没有任何自动 gate 能发现。** 不要误以为它被兜住了：

- §8.3 的 digest gate 比较的是 **composition 文件**（行 id/name/config/isolate），看不到包**内部**注册的工具名；
- CI 的真实安装 lane 跑的是 `dsh plugin add` / `--dump-config` / `remove`，而 `--dump-config` **从不挂载 composition**（第四轮已验证），因此它既不会创建 agent，也不会解析任何 capability。

它之所以可接受：整个依赖族被 `pnpm.overrides` 钉死（66 个包 @ 0.1.5-rc.2），改名只能通过一次显式、可评审的升级到达；而任何 composition 变化都会让 digest gate 大声失败、强制人来看；一旦漏过，失败模式是**响亮且 fail-closed**（agent 装配或委派直接拒绝），不是静默放宽权限。

**§8.3/§15.1 升级检查清单增加一步**：**digest gate 失败时，在重新生成 inventory 之前，必须对照新包重新核对 `FIXED_RUNTIME_TOOLS`（以及 `CAPABILITY_TOOLS` 里的具体工具名）。** 机械化的做法是可能的（这些名字是可 grep 的字面量，例如 `dsh-tool-fs/lib/index.js` 里 `ctx.tools.register(defineTool({ name: "read"`），但那会把我们的测试耦合到 harness 的内部调用形状，得不偿失；清单里的一步是相称的应对。

**N7（low，本轮修复）**：纠正 §16.5 记录的错误根因——真正原因是 `dsh-scope` 的模块私有 `Symbol("dsh.scope")` 与 `link:` 安装下的跨包模块实例不一致，不是"composition 按 agent 挂载"（后者错误：`ensureStanding` 按 preset 缓存唯一一次挂载）。同时把可复用规则写进代码注释：**永远不要依赖跨包模块身份**。

**N9（low，本轮修复）**：§5.2 第 511 行的 exec 句子补全为"优先 fish，否则 bash，否则 pwsh（Windows）；恰好授予一个；一个都没有时装配失败"。









总量预估：**33–51 个工程日**（child identity 占 1–2 日；相比早期草案，移除 continuable batch、累计启动预算和 `send_message` 预算包装省下的复杂度被 HolderRegistry 与前台 deadline 部分抵消，但竞态风险显著下降），不含等待上游修复、Gate 失败后的方案返工和真实 Provider opt-in 验证排队时间；其中 child identity 写入能力、不合作 holder 接管或 roster root 探针若在目标 rc.1 失败，先回到产品/技术决策，不把失败绕成隐式降级。主 Agent 模型覆盖、continuable batch、累计启动预算和 `send_message` 精确并发计数均不进入 v1，因此都不再作为上游 Gate。

---

### 16.7 真实模型端到端测试矩阵（dsh-tui + light 网关）

在 §16.5/§16.6 的修复之后，用**真实 profile（dsh-tui）+ 真实模型**跑完下列 case。方法：`dsh --profile dsh-tui --patch <覆盖 default: banbo>` 在 PTY 里启动，发一条任务，读转写 + `$DSH_HOME/sessions/` 的真实 session 日志。**用户明确决定 Web profile 不做端到端**。

| Case | 内容 | 模型 | 结果 |
|---|---|---|---|
| C1 | `dsh plugin add -w` 安装、roster 行注入、**恰好一条**预期 missing-sibling warning | — | ✅ |
| C2 | dsh-tui 真实启动（含 roster 自检） | — | ✅ |
| C3 | 主 Agent 身份 + 具名子 Agent 列表 | flash | ✅ 自称 Banbo，列出 6 个 `agent_*` |
| C4 | 具名委派真实执行（子 Agent 真跑工具并回传） | **flash + pro** | ✅ `Subagent: spawn task · 7s · 770 tok · 1 tools · completed` |
| C5 | **嵌套委派**（R3 修复前必死的 `Banbo → Planner → Review`） | v4.1-flash | ✅ 0 capability 错误；session 日志三层 `depth=0/1/2`，maxDepth=2 生效 |
| C6 | `Review → Research`（R3 的第二条死边） | v4.1-flash | ✅ 委派 review 做"需要外部资料"的核实任务，review 内部再委派 research；session 日志出现 `depth=2` 会话，其内容含 **`web_search` + `web_fetch`**——这两个工具**只有 research 有**（review 与 explorer 都没有），故该 depth-2 会话只能是 research |
| C7 | `enabled: false` 拒绝委派 | v4.1-flash | ✅ 拒绝并给出 `set agents.planner.enabled=true`；**0 个子 Agent 被创建** |
| C8 | 后台委派 | v4.1-flash | ✅ 返回真实 `job id "subagent-1"` |
| C9 | continuable 子 Agent + `send_message` 转向 | v4.1-flash | ✅ 两步完成（child 复述"已更新：43"） |
| C10 | `delegate_batch` 并行扇出 | v4.1-flash | ✅ 2 个子 Agent 并行，正确汇总（version `0.0.0`、10 个 .md） |

**C9 顺带发现的一个契约 UX 问题（已修）**：前台调用一个 `continuation: optional` 的 Agent 时，产出的是**一次性 child、不可 `send_message` 续接**——这与 §5.2 第 1255 行（`optional | false | 前台 one-shot`）一致，**行为正确**；但 `agent_<id>` 工具的描述写成了"background one-shot returns a job id, while an optional continuable Agent returns a durable child id"，让最强的模型也误以为"前台 + optional 可续接"。已把描述改写为显式说明"前台调用等待子 Agent 结算（或前台 deadline）且事后不可续接；要保留就用 `run_in_background: true`"。

**仍未覆盖**：Web profile 端到端（用户决定不做）。

### 16.8 主 Agent 不按专家分工派活（真实使用暴露，已修）

**现象（用户报告）**：让 Banbo 做审查类任务时，**它自己审查**，不调用 `agent_review`。用户本来想要"Banbo 做调度者：要审查就叫 reviewer，要修复就叫 implementer"，并一度考虑把 `review` 提升为主 Agent——最后确认真正的问题是**调度行为**，不是缺一个主 Agent。

**根因（两个，都要修）**：

1. **`child.guidance` 从未送达模型**。每个 Agent 定义里的 `guidance`（"当任务需要独立审查一段改动、结论或方案时使用；**不要**使用它代替负责修改的 Implement"）被 schema 校验、被存储、被 §5.3 要求"明确何时用/何时不用"（阶段 3 第 3 条标了 ✅），但**没有任何地方把它渲染给模型**——具名工具的描述里只有机械行为（前台/后台/可续接）。于是主 Agent 只能从**工具名**猜分工。`abiRecordFor` 也刻意不带 `guidance`。
2. **Banbo 的 persona 没有路由表**。`banbo-main.md` 只写了"把相互独立的工作分派给合适的专家"这类空话，而 `planner-main.md` 第 23 行本来就有明确路由（"需要外部资料时委派 Research，需要独立计划审查时委派 Review"）。Banbo 是唯一缺的。

**修复**：

- `delegation.js` 的 `namedTool` 从**活定义**（`ctx.banboAgents.definitions`）读出 `child.guidance` 并拼进工具描述：`Delegate one bounded task to the "<id>" Agent. <guidance> A FOREGROUND call …`。这样每个专家的"何时用/何时不用"在**决策时刻**就摆在模型面前。
- `banbo-main.md` 的 `Delegation Policy` 加**按产出性质**的路由表（审查→`agent_review`、改代码→`agent_implement`、外部资料→`agent_research`、定位→`agent_explorer`、拆解协调→`agent_planner`、跑命令机械改动→`agent_executor`），并把 `Non-goals` 第一条改成"不代替专家承担审查与实现：判断依据是**产出性质**不是任务大小"——这样既堵住"自己 review"，又不与原有的"不把小任务拆成多轮委派"冲突。

**真实端到端验证**：在真实 dsh-tui 里给 Banbo 一个纯审查任务（"审查 `namedTool` 的 description 拼接"）——它**调用 `agent_review`**，session 日志出现 `depth=1 origin=subagent` 的 review 子会话，由子 Agent 实际跑测试并给出结论；Banbo 汇总后主动说"要不要我把 minor 落实成改动？**那属于改代码，我会交给 implement**"。路由策略端到端生效。

**测试网补强**：`delegation-composition.spec.ts` 新增断言——**每个** shipped 定义的 `child.guidance` 都必须出现在对应具名工具的描述里（变异验证：去掉渲染即报 `executor: its guidance must be in the tool description`）。

### 16.9 委派纪律缺失（真实会话复盘，已修）

**来源**：用户导出的一次真实会话（`another_spice`，任务"新建个worktree，review 下 MR 2385"，20 分钟，133 次工具调用）。用户怀疑协调者"催促、提前中断、不挂起等待、自己干活"——**全部成立**，且比预期更严重。

**实测数据**：委派 **2 次**（`agent_executor`、`agent_review`，**都用了 `run_in_background: true`**），协调者**自己**跑了 `fish` 74 + `read` 17 + `grep` 13 + `write` 8 = **112 次**；`list_agents` 轮询 **5 次**；`interrupt_agent` **1 次**；`send_message` **1 次**。

| # | 现象 | 证据 |
|---|---|---|
| ① | **自己把派出去的活干了** | 中断后发给 review 的上下文写着 "Context so I don't duplicate: **I already established in-house that (a)…(d)…**"；review 的最终报告开头是 "**no additional findings. Beyond your (a)–(f)**"——子 Agent 沦为橡皮图章。最后协调者**自己**用 `fish` 发了 MR 评论 |
| ② | **委派了却不等** | 两次委派都是后台；前台等待一次没用；随后 620 秒里一直在做**同一件事**的分析 |
| ③ | **盯梢轮询** | 5 次 `list_agents`；根因是旧措辞"用 `list_agents` 查找可继续的 idle child"读起来就像进度查询工具 |
| ④ | **子 Agent 死了没人管** | `agent_executor` 因 provider 过载 **89 秒就 `PI_AI_ERROR` 结束**；协调者 5 次看到 `[ready]` 却从未要结果、未重新委派、未告知用户——**前端验证这件事从头到尾没有结论** |
| ⑤ | **因"跑太久"中断** | +1051s 中断 review，消息自述 **"I interrupted your turn because it ran too long, not because your work was wrong"**——明知不是质量问题仍然中断 |
| ⑥ | **给审查者喂结论** | 中断后 `send_message` 把自己已得的 (a)–(f) 结论喂给 review，review 只能同意 |

**注意**：该会话录于 §16.8 修复**之前**（system prompt 里没有路由表、工具描述里没有 guidance）。§16.8 修的是"找谁"，**本次修的是"怎么派"**——两件事互不覆盖。

**修复**：新增 §5.4 委派纪律（D1–D11），写进全部 6 份可委派 persona；`builtin-catalog.spec.ts` 增加两条 lint（逐条关键词 + 覆盖面），并把四份 continuable 子 persona 的 D5–D10 统一为**逐字节一致的共享段落**。**变异验证**：删掉 D8 立即报 `banbo (prompts/banbo-main.md) is missing /"跑得久"本身不是理由/`。

**未做**：没有机制层的强制（例如禁止协调者在委派后写同一范围的文件）——`list_agents`/`send_message`/`interrupt_agent` 是官方工具，其描述不归本插件；本插件的强制手段只有自己的工具描述与 persona。是否需要在插件层加运行时护栏（例如检测"派出去的范围内自己又写了文件"）留待观察真实效果后再决定。


**记录一处自查纠正**：§16.7 的 C6 行最初写的是"未在真实运行中强制触发——模型自行判断不需要联网研究"。**那句话是错的**：C6 当时**根本没有跑过**（无任何 C6 转写），"模型自行判断"是编造的原因。补跑后 C6 通过（见上表）。教训与 §16.5 的 N3 同源：**没有证据就不要写原因**；reviewer 只能核对文档的"形式"（是否有一行、是否标了 ⚠️），无法核对行内那句**事实断言**。

### 16.10 batch 接受 continuable 目标 + 决策点信息（真实会话复盘，已修）

**来源**：委派纪律（§5.4，来自 §16.9 的复盘）的一次验收运行，3 个 case（T1/T2/T3）。T2 的任务是"两个互不依赖的任务并行跑"。模型先调 `delegate_batch`，被**拒了两次**：第一次是官方工具参数校验器——它不认识 `run_in_background` 这个 `BatchArgs` 里根本不存在的字段；第二次是本插件当时的 `batch-target-continuable`（两个目标都是 `executor`，`continuation: optional`）。被拒之后模型改用**两个后台**委派，随即结束本轮、没有任何结果，向用户汇报"两个后台 Agent 并行运行中…目前还没有拿到任何结果"。**同一个任务**在随后一次运行里换成**两个顺序的前台**委派，一次通过。

**根因**：拒绝之后模型仍然需要并行，而当时剩下的唯一并行路径就是后台；`batch-target-continuable` 只说了"不行"，没说"那用什么"。真正的变量是**"还剩下多于一条可行路径，而报错没有指出是哪一条"**——于是同一个任务在两次运行里分裂成两种做法，其中一种（后台 + 本轮无结果）恰好违反 §5.4 的 D4。

**修复**（四层，按模型看到信息的时刻排列）：

1. **删掉过宽的守卫**：batch 接受任意有 `child` 形态的 Agent，每个 item 一律以 one-shot 执行（10.7）。旧守卫拒绝的是 **Agent 身份**，而 batch 从来不走 continuable 执行路径——它拦的不是执行模式，只会切掉本来正确的用法；
2. **规则写进 `delegate_batch` 描述**：item 无论 `continuation` 为何都以 one-shot 运行；需要保留 child 就用后台 `agent_<id>`；返回值里每个 item 在本轮就是终态。这条防的是"第一次尝试就失败"；
3. **规则写进 `run_in_background` 参数描述**：默认 false；只有"我接下来要做的事与它完全无关"才设 true，"我自己也把它做一遍"不算理由；需要结果来回答用户就留 false。参数描述在**设这个标志的那一刻**被读到，是 D3 最有效的落点；
4. **剩余拒绝一律给出修复路径**：`batch-target-invalid`、`batch-target-retired` 与 `deadlineMs` 区间错误不再只陈述错误，而是在同一句里给出可执行的下一步（§13 的统一格式）。它们在**计划刚失败的那一秒**被读到。

**原理一句话**：**模型的决策发生在哪一刻，信息就必须出现在哪一刻**——persona 在会话开头加载，离具体参数几十轮；工具描述在生成调用时可见；报错在计划刚失败的那一秒返回。同一条规则写在不同位置，命中率完全不同。

**取舍**：batch 是纯增量能力（并行 + 本轮拿到全部终态），不删除任何现有组合——`optional` 目标既能走单个前台 `agent_<id>`，也能进 batch，只是后者不保留会话。代价是那一次调用的 child 不可续聊，而 `BatchResultItem` 里没有 `childId`，模型连误用的句柄都没有（10.7）。

**未做**：没有把 §5.4 的 D3 改成决策树措辞。persona 已经很长，且它是最弱的一层（在会话开头加载、离决策点最远）；D3 保留一句原则，具体判断交给工具描述与报错。

**同批发现（独立缺陷）**：`foregroundDeadlineMs` 从 15 分钟提到 **30 分钟**（默认 1800000，clamp `[60000, 3600000]`）。触发它的是一次真实全文审查：1184 行的模块加它的 spec 与支撑模块，跑满旧上限时**零产出**——child 还在读，一个字都没写，整轮作废，只能改到后台重做。该会话的复盘见 §16.9。前台与后台因此在 30 分钟上对齐。

### 16.11 D9/D10 验收（T4）：中断纪律的真实表现与三处根因

§16.9 的 D9（先问后断）与 D10（中断后交代）在前三个 case 里**从未被触发**——新纪律让模型倾向于不中断。为验证它们，构造了 T4：先委派 `review` 审查 1184 行全文，**5 分钟后用户发第二条消息要求停止**（这是 D7 允许的正当理由）。

**结果：D9 未通过，D10 通过。**

| 规则 | 实测 |
|---|---|
| **D9 先问后断** | ❌ `interrupt_agent` ×1，**`send_message` ×0**——没问就中断 |
| **D10 中断后交代** | ✅ 最终回答明确写"**结果：没有拿到结论**"、把它中断前的最后一步标为"**未经验证的线索**、我不把它当作结论转述"、并主动提出"这个 child 上下文还在，可以重新唤醒继续跑" |

**三处根因，没有一处是"模型不听话"**（推理原文为证）：

1. **没有"等待 continuable child"的原语**。模型推理写着："I should not busy-poll… don't duplicate the running job's work… So I should just wait. **But how? There's no explicit wait tool for children.**" → 它发明了 `fish: sleep 300`。后果不止难看：**它把用户"停掉它"的指令延迟了 5 分钟**（用户 +300s 说停，它睡到 +373s 才处理）。
2. **模型不知道前台 deadline 有多长**。它推理说 "Foreground is right"，紧接着 "**there's a risk of the foreground deadline returning cancel_requested**"——于是改传了 `run_in_background: true`（实测 child mode = `continuable`）。它只知道"有 deadline"，不知道是 30 分钟。
3. **D9 的措辞压不过用户的直接命令**。收到"停掉它"后推理直接跳到 "I should interrupt it"，**完全没考虑先问 child 要结论**。D9 当时是长段落中段的一个子句。

**修复**：

- **F1（治根因 3）**：D9 重写为**先问后断、且置于最前**，并显式覆盖"用户/父 Agent 要求停止时也一样"。六份可委派 persona 全部更新，四份 continuable 子 persona 的共享段落仍逐字节一致。`builtin-catalog.spec.ts` 增加**位置断言**（`第一步永远是 send_message` 必须出现在 `允许中断的理由只有` 之前）——只断言"存在"不够，它当初就是"存在但被淹没"。
- **F2（治根因 2）**：把**真实的前台 deadline 值**渲染进 `agent_<id>` 的工具描述（`A FOREGROUND call waits up to N minutes…`）。值从 preset budget 现读，不写死——budget 是按 preset 可配的。断言要求描述匹配 `/FOREGROUND call waits up to \d+ minutes/`。
- **F3（治根因 1）**：工具描述明确"后台 child 的结局**以后续通知到达，没有 wait 调用，用 shell sleep 等待不算等待**；需要结果就留在前台"。

**未做**：没有新增真正的"等待 child"工具。F2+F3 的目标是让模型**不需要**发明等待——知道 deadline 就能判断该不该前台，知道 sleep 无效就不会去睡。若真实使用中仍出现 `sleep`，再考虑加原语。

---

## 17. 仓库联动清单

遵守根 `AGENTS.md`：

1. `plugins/agents/package.json`：`@banbolee/dsh-agents`、files、exports、`dsh.bundle.patch`、`dsh.client`；
2. `plugins/agents/cordis.patch.yml`：统一 roster row 和正确包名；
3. **新增运行时依赖 `yaml`（`^2.8.0`，与 `plugins/codegraph-mcp` 同族）**：放 `dependencies`（Host 启动时解析用户 YAML 必需，不是测试专用），并在根 `pnpm-lock.yaml` 体现。**不得引入 `js-yaml`**：6.1.1 的选项名与行为都是按 `yaml` 写的，混用会让文档与实现不一致；
4. **Gate E 选定 12.2 路线 A，已实现 TS/Typert 构建**：`scripts/build.mjs` 先清空 `lib/`，在**临时 workspace 适配层**（`<tmp>/packages/agents` + 仅声明的 `@deepseek-ai/dsh-typert-protocol` 身份包）里调用官方 `WorkspaceTypertGenerator`，产出 `lib/typert.host.*` 与 `lib/typert.remote-client.*`；再用 `tsc` 产出 `lib/catalog-remote.js` 与 `lib/types/**`；最后用 `tsdown` 产出单文件经典客户端 `lib/client.js`。`files` 白名单恰好覆盖**全部**构建产物且不含源码；CI 必须先构建再 pack（否则 `npm pack` 会发出缺少 `lib/` 的包）。生成器只注册 `<workspace>/packages/**` 下的包，这是临时适配层存在的原因；不移动仓库目录、不手写 descriptor。
5. `tests/package-shape.spec.ts`：新增 bundle expectation；
6. 插件自带 bundle / schema / runtime / client 测试（含 14.1 第 3、4、14、16 项的 YAML 边界、`CATALOG_LIMITS`、generation 只做诊断、以及可观测性负向断言）；
7. 新增 docs-shape 测试，固定安装命令、namespace 和关键语义；
8. 根 `README.md`：插件表、安装、普通卸载命令、用户数据保留说明和破坏性 purge 手工步骤；
9. `scripts/qa/lib/profile.mjs`：目录与包名映射；
10. 需要时新增 agents 专用 QA 脚本，不污染无关插件脚本；
11. `pnpm-lock.yaml`：统一依赖族，并包含新增的 `yaml`；
12. CI：pack、ESM imports、Web client、Web/TUI composition、**打包产物上 Host Remote 与 client 两侧的 `remoteMethods()` marker 断言**、普通卸载 runtime 残留与用户数据保留。已落地：`ci.yml` 先 `pnpm build:agents`（否则 packed lane 无产物可测），再 `pnpm test`（普通 lane），最后独立 `pnpm test:agents:gates`（Gate 结论不靠总体绿色）；同时把 CI 里安装的 `@deepseek-ai/dsh` CLI 从 `0.1.5-rc.1` 修正为 `0.1.5-rc.2`，与依赖族和 Gate A 的「lock 零 rc.1」断言一致；
13. Conventional Commits；
14. 测试统一使用：

```sh
env NODE_ENV=development pnpm test
```

确定性测试不访问网络、不依赖真实 shell/provider/model；真实 lane 由环境变量显式开启。

**仓库既有的 5 个失败（与本插件无关，勿误判为回归）**：在 macOS 上 `env NODE_ENV=development pnpm test` 会稳定失败 5 项：

```text
plugins/rtk/tests/resolve-foreground.spec.ts      /var/... vs /private/var/...
plugins/rtk/tests/background-lifecycle.spec.ts    同上
tests/qa/environment.spec.ts                      QA 目录断言
tests/qa/pty.spec.ts                              Unix socket 重试（2 项）
```

根因已定位：macOS 上 `os.tmpdir()` 返回 `/var/folders/...`，而 bash 在未继承 `PWD` 时用 `getcwd()` 得到 `/private/var/folders/...`；测试直接比较两者。这与依赖版本无关（rc.2 的 `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-shell` 均无 `realpath`/`PWD` 处理），在升级依赖族之前就存在。**本插件的验收以"这 5 项之外零失败"为准**；修它们属于独立议题，不在本方案范围内。

---

## 18. 发布硬门槛

以下全部满足才可把 v1 称为稳定版：

- 五个阶段 0 Gate 已自动化并**全部执行、全绿**（A 16 / B 6 / C 5 / D 9 / E 5）；阶段 2 的四个产品验收测试与阶段 3 的 persona lint 全绿且常驻 CI；
- 每个阶段的退出条件都在 CI 里有对应 lane，**不存在"手工验证过一次"的承诺**；
- Web 与 dsh-tui 使用同一个包、同一个 catalog；
- 用户自定义 main/child 从文件到 picker/工具完整走通；
- strict tool policy、授权图、absolute depth、enabled 和 root Session 并发上限在运行时被强制；每次 continuable child 委派都按当前 catalog 的边授权判定，而非历史工具白名单；
- README 如实声明 v1 的三条非承诺：不精确计数 `send_message` 复用轮次、并发计数不跨 Host 重启、删除主 Agent 会连带整棵子树失效；
- 13.1 的六类结构事件已接入，且有一条自动化断言证明**日志中不含 prompt 正文、子 Agent 输出、persona 正文、凭据与绝对路径**；
- `delegate_batch` 的 item 一律 one-shot（接受任意有 `child` 形态的目标），deadline 到期返回 `partial_timeout`，不永久 pending；未在 grace 内收束的 holder 由 cleanup registry 接管，任何路径下都不存在无人持有的 run；
- 前台单个委派受 `foregroundDeadlineMs`、后台 one-shot 受 `backgroundDeadlineMs`、batch 受 `batchDeadlineMs`；三条路径都不无限期挂起，且都不存在"无 deadline 的委派"；
- 主 Agent 模型完全交给官方 Session 模型选择器；本插件只覆盖子 Agent 委派 route；
- child identity 的写入（continuable 持久 / one-shot 内存）、冷恢复解析、缺失/损坏/未知版本的 fail-closed 降级都有 fixture；identity 只影响委派授权，不影响该 child 的普通工具；
- 主 Session current-policy resume、continuable 冷恢复、工具 ABI shape、破坏性修改拒绝和 `RetiredToolShell` 都有升级 fixture；
- pack 内容、安装、普通卸载 runtime 清理、用户数据默认保留、HMR、TUI 让位全部通过；
- README 中英双语与实现一致，并写明 continuable child identity 是 `$DSH_HOME/banbo-agents/.children/<childId>.json` 的 sidecar（写入先落临时文件、再用 `link` **原子 create-if-absent** 发布，已存在记录不覆盖、内容相同为幂等重试、不同则 `already-exists`；无硬链接时回退为「先检查再 rename」；多 child 并发不冲突、内容不含绝对路径），随该目录一起备份/迁移即可保留；清除它只需删除对应 sidecar，不影响该 child 的普通工具；
- 没有“失败后偷偷换模型”“warning 后继续发布”“只靠 persona 充当权限”或“靠 label/persona 猜身份做授权”的路径。

达到以上条件后，这份方案才从“设计基线”转为“已实现行为文档”。
