# banbo-dsh

[![CI](https://img.shields.io/github/actions/workflow/status/BanboLee/banbo-dsh/ci.yml?label=CI&logo=github)](https://github.com/BanboLee/banbo-dsh/actions/workflows/ci.yml)

[English](./README.md) | **中文**

DeepSeek Harness（DSH）插件集合：4 个持续维护的插件发布在 npm（`@banbolee/dsh-*`），另有 2 个已弃用插件冻结在 0.3.4。维护中的插件一条命令即可安装到 DSH profile，无需 clone 本仓库。MIT 协议开源。

## 快速安装（用户）

前置条件：已安装 `dsh` 0.2.2-rc.1，TUI profile 使用 `dsh-tui` 0.19.0，以及 Node.js ≥ 24.9.0（CI 与升级 QA 使用 Node 26）、pnpm 9.x。

想装哪个装哪个：

```sh
dsh plugin --profile <profile> add @banbolee/dsh-rtk
dsh plugin --profile <profile> add @banbolee/dsh-fish-shell
dsh plugin --profile <profile> add @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> add @banbolee/dsh-agents
```

## 插件总览

| 插件 | 功能 | 需要的二进制 |
| --- | --- | --- |
| [`@banbolee/dsh-rtk`](plugins/rtk/README.md) | 装饰已挂载的 shell 执行器：每条命令经 `rtk rewrite` 改写后执行，模型侧 `grep` 输出经 `rtk pipe` 压缩 | `rtk` |
| [`@banbolee/dsh-fish-shell`](plugins/fish-shell/README.md) | 用 fish 替代 bash：沙箱/本地两种执行器 + 模型可调的 `fish` 工具 + 任意 agent preset 下用 fish 替换 bash 的 per-agent 策略 | fish |
| [`@banbolee/dsh-lsp-diagnostics`](plugins/dsh-lsp-diagnostics/README.md) | `write`/`edit`/`str_replace_editor` 改动落盘后，自动把 LSP 诊断结果附到下轮模型推理；另注册模型可调用的 `lsp_diagnostics(file_path)` 工具 | `typescript-language-server`、`gopls`（可选 `clangd`、`rust-analyzer`、`pyright-langserver`） |
| [`@banbolee/dsh-agents`](plugins/agents/README.md) | 用 YAML 定义自己的 Agent 团队：具名 `agent_<id>` 工具、每个 Agent 的 persona 与工具面、显式委派图、绝对深度/并发预算；把自带 preset 作为 `@deepseek-ai/dsh-agent-preset` 行声明在 profile 的 preset registry 上 | 无 |

**已弃用 / 冻结在 0.3.4：** [`@banbolee/dsh-codegraph-mcp`](plugins/codegraph-mcp/README.md) 与 [`@banbolee/dsh-llm-pi-ai-with-session`](plugins/dsh-llm-pi-ai-with-session/README.md)。源码、旧版文档与测试仅保留供参考，不参与 workspace 安装、活动测试、类型检查、升级与发布。其 DSH 0.2.1 基线不属于 DSH 0.2.2-rc.1 支持边界，请勿加入当前 profile。

每个插件的完整说明见各自的 README。

## 外部依赖（重要，装前必读）

`rtk`、fish、LSP servers 等二进制**必须预先安装**，插件不会帮你下载：

| 二进制 | 用于 |
| --- | --- |
| `rtk` | `@banbolee/dsh-rtk`——**必须预装**，否则命令改写/grep 压缩全部 fail-open 直通 |
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

旧版 profile 中也可使用 `dsh plugin --profile <profile> remove <package>` 移除上述两个已弃用包；本次仓库切换不要求重启已有会话。

>`@banbolee/dsh-agents` 的普通卸载**保留**用户数据（`$DSH_HOME/banbo-agents/`：YAML 定义、persona、ABI manifest），重装后即可恢复；它只是不再挂载到运行时，preset 行也随之消失。彻底清除是显式的破坏性操作，见 [plugins/agents/README.md](plugins/agents/README.md)。

## 本地开发 / 从源码安装（贡献者）

```sh
git clone git@github.com:BanboLee/banbo-dsh.git
cd banbo-dsh
env NODE_ENV=development pnpm install
```

从仓库根目录安装到 profile（`-w` 标志对以下本地路径安装是必需的，否则 pnpm 报 `ERR_PNPM_ADDING_TO_ROOT`；`@banbolee/dsh-fish-shell` 例外，不需要 `-w`，它有独立的部署与符号链接方案，见其 README）：

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
dsh plugin --profile <profile> add -w ./plugins/agents
dsh plugin --profile <profile> add ./plugins/fish-shell
```

只有四个维护中的目录参与 `pnpm install`、测试与类型检查，不要把冻结目录安装到当前 rc.1 workspace。

维护隔离环境可用同步脚本（要求 `DSH_HOME` 指向隔离目录）：

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
scripts/sync-to-profile.sh <profile>            # fish-shell：打包 bundle，再把 tarball 装进 profile
```

### 测试

```sh
env NODE_ENV=development pnpm test
```

`NODE_ENV=development` 很重要：`NODE_ENV=production` 时 pnpm 会跳过 devDependencies，导致依赖装不全、依赖图断言失败。各插件自己的验证命令见各自 README。

### 旧版 headless E2E（冻结）

基于 CodeGraph 的 `tests/e2e/**` 源码仅保留为旧版证据，不参与活动测试发现、
CI 与发布，原 headless E2E npm 脚本已移除。四个维护中插件由 `pnpm test`、
`pnpm test:composition` 及 G4–G6 DSH/TUI QA 车道覆盖。

### 发布（维护者）

发布只走一条手动 workflow：[`.github/workflows/release.yml`](./.github/workflows/release.yml)，一次 dispatch **在同一 commit 上仅发布四个维护中的包**：

```sh
gh workflow run release.yml -f release_sha=<40-character SHA on main> -f dry_run=true
```

`dry_run` 默认 `true`：只打包、校验四个 tarball 并上传 release journal，不碰 registry。要真正发布时传 `dry_run=false`。车道先跑全部确定性门禁，再一次性打包，随后用 `next` candidate tag 串行执行 `npm publish --provenance --access public` 并逐包核验 registry integrity；**四包全部成功后**才提升 `latest`、删除 candidate tag，并在同一 commit 上创建四个 annotated tag 与四个 GitHub Release。两个冻结包绝不会在此车道打包或发布。

认证走 npm Trusted Publishing（OIDC，无长期 secret），`id-token: write` 权限就是 provenance 的签名来源。npmjs.com 上必须同时满足两件事：Trusted Publisher 要**同时授权 publish 与 dist-tag**（本车道用同一个 OIDC 身份移动 `latest`、删除 candidate tag），npm CLI 必须是 **11.21.0 或更新**——`publish` 自 11.5.1 起支持 tokenless OIDC，但 `dist-tag` 直到 11.21.0 才支持，旧版本会发完四个版本再卡在第一次 promotion。workflow 固定该版本，`preflight` 遇到更旧的版本直接拒绝启动。

已发布的 npm 版本不可变，所以 partial failure **绝不盲目重发**：上传的 journal 记录实际到达 registry 的内容。用 `prior_run_id` 重新 dispatch 时，旧 journal 会被核验（同一 commit、tag 与版本）后接管续跑——已发布的版本跳过，`finalize` 只提升尚未提升的包，已存在的 GitHub Release 只有在其 tag、target 与 title 都与本次 dispatch 一致时才被接受。

## License

MIT —— 见 [LICENSE](LICENSE)。
