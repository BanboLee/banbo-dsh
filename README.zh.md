# banbo-dsh

[![CI](https://img.shields.io/github/actions/workflow/status/BanboLee/banbo-dsh/ci.yml?label=CI&logo=github)](https://github.com/BanboLee/banbo-dsh/actions/workflows/ci.yml)

[English](./README.md) | **中文**

DeepSeek Harness（DSH）插件集合：6 个开箱即用的插件，全部发布在 npm（`@banbolee/dsh-*`），一条命令即可安装到任意 DSH profile，无需 clone 本仓库。MIT 协议开源。

## 快速安装（用户）

前置条件：已安装 `dsh`（0.1.5-rc.2 族）、Node.js ≥ 22、pnpm 9.x。

想装哪个装哪个：

```sh
dsh plugin --profile <profile> add @banbolee/dsh-rtk
dsh plugin --profile <profile> add @banbolee/dsh-codegraph-mcp
dsh plugin --profile <profile> add @banbolee/dsh-fish-shell
dsh plugin --profile <profile> add @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> add @banbolee/dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> add @banbolee/dsh-agents
```

## 插件总览

| 插件 | 功能 | 需要的二进制 |
| --- | --- | --- |
| [`@banbolee/dsh-rtk`](plugins/rtk/README.md) | 装饰已挂载的 shell 执行器：每条命令经 `rtk rewrite` 改写后执行，模型侧 `grep` 输出经 `rtk pipe` 压缩 | `rtk` |
| [`@banbolee/dsh-codegraph-mcp`](plugins/codegraph-mcp/README.md) | 通过官方 DSH bridge 新增一行 `mcp-codegraph`，以 stdio 接入 CodeGraph MCP 服务（`codegraph serve --mcp`），并附 agent 指令安装脚本 | `codegraph` |
| [`@banbolee/dsh-fish-shell`](plugins/fish-shell/README.md) | 用 fish 替代 bash：沙箱/本地两种执行器 + 模型可调的 `fish` 工具 + 任意 agent preset 下用 fish 替换 bash 的 per-agent 策略 | fish |
| [`@banbolee/dsh-lsp-diagnostics`](plugins/dsh-lsp-diagnostics/README.md) | `write`/`edit`/`str_replace_editor` 改动落盘后，自动把 LSP 诊断结果附到下轮模型推理；另注册模型可调用的 `lsp_diagnostics(file_path)` 工具 | `typescript-language-server`、`gopls`（可选 `clangd`、`rust-analyzer`、`pyright-langserver`） |
| [`@banbolee/dsh-llm-pi-ai-with-session`](plugins/dsh-llm-pi-ai-with-session/README.md) | `llm-pi-ai` 的通用 session wrapper：注册显式 session provider 路由，每次 LLM 请求携带动态会话 header（默认 `x-session-id`） | 无（复用 `llm-pi-ai` provider） |
| [`@banbolee/dsh-agents`](plugins/agents/README.md) | 用 YAML 定义自己的 Agent 团队：具名 `agent_<id>` 工具、每个 Agent 的 persona 与工具面、显式委派图、绝对深度/并发预算；接管官方 `agent-presets` roster 行 | 无 |

`@banbolee/dsh-llm-pi-ai-with-session` 是 `llm-pi-ai` 的一个通用 session wrapper：按配置显式注册 session provider 路由，复用 pi-ai 的 openai-completions 实现并在每次请求里带上可配置的会话 header（默认 `x-session-id`）；网关、凭据、模型、推理档位全部从 source provider 继承，无需重复配置。详见 [plugins/dsh-llm-pi-ai-with-session/README.md](plugins/dsh-llm-pi-ai-with-session/README.md)。

每个插件的完整说明见各自的 README。

## 外部依赖（重要，装前必读）

`rtk`、`codegraph`、fish、LSP servers 等二进制**必须预先安装**，插件不会帮你下载：

| 二进制 | 用于 |
| --- | --- |
| `rtk` | `@banbolee/dsh-rtk`——**必须预装**，否则命令改写/grep 压缩全部 fail-open 直通 |
| `codegraph` | `@banbolee/dsh-codegraph-mcp`——**必须预装**，否则 MCP bridge 没有服务器、无 `mcp__codegraph__*` 工具 |
| fish | `@banbolee/dsh-fish-shell` 执行器与工具 |
| `typescript-language-server`、`gopls`（可选 `clangd`、`rust-analyzer`、`pyright-langserver`） | `@banbolee/dsh-lsp-diagnostics` 的自动诊断 |

把二进制放进 `PATH`（或通过插件配置固定路径）。缺少二进制不影响安装和测试，只是对应功能 fail-open。

## 卸载

```sh
dsh plugin --profile <profile> remove @banbolee/dsh-rtk
dsh plugin --profile <profile> remove @banbolee/dsh-codegraph-mcp
dsh plugin --profile <profile> remove @banbolee/dsh-fish-shell
dsh plugin --profile <profile> remove @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> remove @banbolee/dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> remove @banbolee/dsh-agents
```

>`@banbolee/dsh-agents` 的普通卸载**保留**用户数据（`$DSH_HOME/banbo-agents/`：YAML 定义、persona、generated presets、ABI manifest），重装后即可恢复；它只是不再挂载到运行时。彻底清除是显式的破坏性操作，见 [plugins/agents/README.md](plugins/agents/README.md)。

## 本地开发 / 从源码安装（贡献者）

```sh
git clone git@github.com:BanboLee/banbo-dsh.git
cd banbo-dsh
env NODE_ENV=development pnpm install
```

从仓库根目录安装到 profile（`-w` 标志对以下本地路径安装是必需的，否则 pnpm 报 `ERR_PNPM_ADDING_TO_ROOT`；`@banbolee/dsh-fish-shell` 例外，不需要 `-w`，它有独立的部署与符号链接方案，见其 README）：

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
dsh plugin --profile <profile> add -w ./plugins/agents
dsh plugin --profile <profile> add ./plugins/fish-shell
```

一次性装多个/维护隔离环境，可用同步脚本（要求 `DSH_HOME` 指向隔离目录）：

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <profile>
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
scripts/sync-to-profile.sh            # fish-shell：把插件拷贝进 profile 树
```

### 测试

```sh
env NODE_ENV=development pnpm test
```

`NODE_ENV=development` 很重要：`NODE_ENV=production` 时 pnpm 会跳过 devDependencies，导致依赖装不全、依赖图断言失败。各插件自己的验证命令见各自 README。

### 真实 headless E2E（可选）

先构建相邻的 RTK release 二进制与 CodeGraph 产物，再跑 opt-in 的真实 profile 套件：

```sh
(cd ../rtk && cargo build --release)
(cd ../codegraph && npm run build)
corepack pnpm test:e2e:headless
```

需要 Node 22、`dsh`、fish；可用 `DSH_REAL_E2E_DSH_BIN` / `DSH_REAL_E2E_NODE_BIN` / `DSH_REAL_E2E_RTK_BIN` / `DSH_REAL_E2E_CODEGRAPH_BIN` 覆盖可执行文件位置。

## License

MIT —— 见 [LICENSE](LICENSE)。
