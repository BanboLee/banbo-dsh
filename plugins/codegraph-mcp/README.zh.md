# @banbolee/dsh-codegraph-mcp

[English](./README.md) | **中文**

DSH profile bundle：通过官方 [`@deepseek-ai/dsh-mcp-client`] bridge 把 CodeGraph MCP 服务接入任意 DeepSeek Harness profile。它新增一行可配置的 row `mcp-codegraph`，以 `CODEGRAPH_NO_DAEMON=1` 通过 stdio 启动 `codegraph serve --mcp`。

## 前置条件

`codegraph` CLI 必须**预先安装**并可在 `PATH` 上访问，本 bundle 才能工作：`mcp-codegraph` row 通过 stdio 启动 `codegraph serve --mcp`，因此没有该二进制时 bridge 就没有服务端，也不会有任何 `mcp__codegraph__*` 工具可用。本 bundle 从不下载或安装 CodeGraph；请针对任意当前发行版进行测试（已在 1.6.0 上验证）。

## 用法

**从 npm 安装（推荐）** —— 无需 clone：

```sh
dsh plugin --profile <name> add @banbolee/dsh-codegraph-mcp
```

本地开发时，可在仓库根目录把本 bundle 安装到任意 DSH profile。必须带上 workspace 根标志 `-w`：否则 pnpm 无法在 profile 生成的 workspace 内解析本地包，安装会以 `ERR_PNPM_ADDING_TO_ROOT` 失败。

```bash
dsh plugin --profile <name> add -w ./plugins/codegraph-mcp
```

若要用一条命令把两个本地 bundle（rtk 和 codegraph-mcp）安装到同一个隔离 profile：

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <name>
```

sync 辅助脚本要求设置 `DSH_HOME`，这样测试与手工 QA 始终作用于隔离的 profile 状态，而不是用户的默认 Harness home。

## 配置

本 bundle 插入单行 row（见 `cordis.patch.yml`）：

| 字段 | 值 |
| --- | --- |
| `id` | `mcp-codegraph` |
| `name` | `@deepseek-ai/dsh-mcp-client` |
| `serverName` | `codegraph` |
| `transport` | `stdio` |
| `command` | `codegraph` |
| `args` | `['serve', '--mcp']` |
| `env.CODEGRAPH_NO_DAEMON` | `'1'` |

`serverName` 为 `codegraph`，因此 bridge 把每个对外公布的 MCP 工具注册到带服务端限定的名字 `mcp__codegraph__<rawName>` 之下。

`CODEGRAPH_NO_DAEMON=1` 把服务端固定为 direct 模式：`codegraph serve --mcp` 通过 stdio 只服务这一个客户端，而不是 fork 一个分离的后台 daemon，从而让 profile 的使用保持确定性。默认 row 不固定任何项目路径：DSH bridge（`@deepseek-ai/dsh-mcp-client`）不发送 `rootUri`，也不宣告 MCP `roots` capability，因此 CodeGraph 从服务端自身的工作目录推导项目 —— 也就是 DSH 启动时所在的目录。请从被索引的项目根目录启动 DSH，或用 `--path` 显式固定项目（见下文的 profile override）。

## 项目路径的 profile override

profile patch 会按 id 替换整个 row 的 config（最后写入者生效；没有 deep merge）。要固定显式 workspace，请重新声明该 row 并追加 path 标志：

```yaml
- id: mcp-codegraph
  config:
    serverName: codegraph
    transport: stdio
    command: codegraph
    args: ['serve', '--mcp', '--path', '/abs/path/to/workspace']
    env:
      CODEGRAPH_NO_DAEMON: '1'
```

## Agent 指令

无需安装 —— 上游的工具描述已经教会模型优先使用 CodeGraph，本 bundle 也刻意不在任何地方写 AGENTS.md。

- CodeGraph 把它的使用手册放在 MCP `initialize` 的 `instructions` 里（上游 `src/mcp/server-instructions.ts`），MCP 客户端会把它呈现到 agent 的 system prompt 中。DSH bridge（`@deepseek-ai/dsh-mcp-client`）**不**消费这些 instructions —— 它只桥接 MCP 工具 —— 因此那些文字永远不会通过 bridge 到达模型。
- 真正能穿过 bridge 的指引是工具描述本身：上游服务端把 `codegraph_explore` 描述为 `PRIMARY TOOL — call FIRST for almost any question OR before an edit`，其他 codegraph 工具都让位于它（`Use codegraph_explore instead`）。bridge 会把每个对外公布的工具描述原样注册到 harness ToolRuntime，因此主 agent 与被委派的 subagent 在每一次工具选择时都会看到这份强调。
- 因此本 bundle **不**向 `$DSH_HOME/AGENTS.md`（或任何其他 AGENTS.md）安装任何带 marker fence 的块。`$DSH_HOME/AGENTS.md` 是用户全局的：`dsh-agent-instructions`（在 `@deepseek-ai/dsh-base` 中默认启用）会把它加载进每个项目和每个 profile，因此在那里放一个 codegraph 块会污染没有 `.codegraph/` 索引的仓库、以及没有装本 bundle 的 profile —— 变成没有工具支撑的指引。依赖工具描述可以让指引只作用于真正拥有这些 MCP 工具的 session。

说明：

- 被 CodeGraph 索引的项目完全可以在自己的项目 `AGENTS.md` 里提到这一点（例如“本仓库已被索引 —— 优先用 `mcp__codegraph__codegraph_explore` 而不是 grep”）；那是项目所有者的决定，不是本 bundle 的。
- 如果本 bundle 的早期版本曾把某个块安装到某些 AGENTS.md 中，请手动删除 `<!-- CODEGRAPH_START --> … <!-- CODEGRAPH_END -->` 段；marker fence 让清理变得机械。

## 模型体验

只有带服务端限定的 MCP 工具会暴露给模型；原始 MCP 名字从不直接注册。确定性测试只观察到唯一一个公开工具 `mcp__codegraph__echo_context`，调用它会返回 fake 服务端的 `codegraph-ok` 文本。

## 已知限制与待办工作

- DSH bridge 目前只覆盖工具；MCP Resources 和 Prompts 没有 harness 消费者，属于待办，因此本 bundle 不桥接它们。
- DSH bridge 不发送 `rootUri`，也不宣告 MCP `roots` capability，因此 CodeGraph 无法从客户端得知项目：没有 `--path` 时，服务端从其启动目录（DSH 启动时所在的目录）推导项目。按 profile 固定 `--path`，让项目变得显式且确定（见“项目路径的 profile override”）。
- DSH bridge 不消费 MCP `initialize` 的 `instructions`，因此 CodeGraph 的使用手册永远不会通过 bridge 到达模型。本 bundle 用真正能穿过 bridge 的东西来补偿：上游的工具描述本身（见“Agent 指令”），它教会主 agent 及其 subagent 优先调用 `mcp__codegraph__codegraph_explore` —— 这正是上游安装器为其他 agent 写进 CLAUDE.md/AGENTS.md/GEMINI.md 的 marker-fenced 块的 DSH 等价物，而且不需要写任何文件。
- DSH 没有像 Claude Code 的 `settings.json` `permissions.allow` 那样的静态 MCP 权限允许列表。上游安装器在那里自动批准 `mcp__codegraph__*`，以避免每次调用都弹提示；DSH 的批准接缝是 per-session 的 `ask`/`never` 策略，且只支持一次性授权，因此 codegraph 调用是否弹提示取决于组合出来的 approval 策略 —— 而不是本 bundle。如果交互式 profile 在每次 codegraph 调用时都询问，请把 session 策略设为 `never`，或改用非交互式 profile。
- 上游 Claude Code 安装器还会接一个可选（opt-in）的 `UserPromptSubmit` hook，运行 `codegraph prompt-hook`，在结构性提问（“how / where / trace”）上提前注入 codegraph 上下文，让 agent 无需被提醒就会去用图。DSH 没有等价的 prompt hook 面（`dsh-agent-instructions` 链是静态的，不对 prompt 作出反应），因此 codegraph 指引只能通过工具描述到达模型 —— prompt-hook 的提前注入属于待办，此处未复刻。
- 确定性的 fake-MCP 测试是本 bundle 的权威验收。它们针对 `tests/fixtures/fake-mcp-server.mjs` 运行，不需要真实 `codegraph` 二进制、不需要网络，也不需要 daemon。确定性验收在无 daemon 的情况下运行。
- 真实 CodeGraph 冒烟测试仍然可选。安装、测试或运行本 bundle 从不需要真实 `codegraph` 二进制；`scripts/smoke-codegraph-mcp.sh` 是尽力而为的诊断脚本，二进制缺失时会跳过。
- 真实的 `codegraph serve --mcp` 服务端默认开启遥测，并在启动时执行一次后台的更新可用性检查（已对照 CodeGraph 源码验证）。想要退出的 profile 可以把环境变量加到该 row 的 `env` 中：
  - `DO_NOT_TRACK=1` 同时关闭匿名使用遥测和后台更新检查。
  - `CODEGRAPH_TELEMETRY=0` 只关闭遥测；它优先于已存储的默认开启选择。
  - `CODEGRAPH_NO_UPDATE_CHECK=1` 只关闭后台更新检查。
  默认 row 把遥测与更新检查行为留给 CodeGraph 自身的默认值；本 bundle 不做改动。

## 验证

确定性测试通过官方 bridge 把 bundle row 挂载到 fake stdio MCP 服务端上；不需要真实 `codegraph` 二进制或 daemon：

```bash
pnpm exec vitest run plugins/codegraph-mcp/tests/*.spec.ts
```

文档形态测试（必需章节与契约字符串，包括 agent 指引策略 —— 不写 AGENTS.md，指引经由工具描述）：

```bash
pnpm exec vitest run tests/docs-shape-codegraph.spec.ts
```

可选的真实 CodeGraph 冒烟测试，仅在 PATH 上有真实 `codegraph` 时运行，绝不是必需的验收：

```bash
scripts/smoke-codegraph-mcp.sh
```
