# RTK / CodeGraph 接入 DeepSeek Harness 的先验知识报告

> 目标：沉淀后续在 `banbo-dsh/` 里以插件方式让 RTK 与 CodeGraph 被 deepseek-harness（DSH）完整使用所需的前置知识。本文不是实施计划，而是对两个工具的作用、内部工作方式、宿主假设、以及与 DSH 插件机制相关的关键事实进行归纳。

## 0. 一句话结论

- **RTK** 是“命令执行链路上的透明压缩代理”：把 `git status`、`cargo test`、`rg ...` 这类命令改写为 `rtk git status`、`rtk cargo test`、`rtk rg ...`，由 Rust 二进制执行原命令、过滤输出、保留退出码、记录节省量。它的宿主适配核心不是 MCP，而是“在 shell 命令被执行前改写命令”。
- **CodeGraph** 是“本地代码知识图谱 + MCP 工具服务”：通过 `codegraph init` 在项目里建立 `.codegraph/` SQLite 索引，MCP 服务暴露 `codegraph_explore` 等只读工具，让 agent 用一次结构化查询替代 grep/read 文件爬取。它的宿主适配核心是“正确启动 MCP stdio 服务，并把 `projectPath`、cwd、daemon 生命周期和工具说明传给宿主”。
- **DSH 插件形态** 当前以 `dsh-fish-shell` 为唯一参考：一个 npm 包声明 `dsh.bundle.patch`，通过 Cordis patch 禁用/插入 profile row，注册 host-plane tool/executor，并用 agent preset 控制 agent-plane 工具集。RTK/CodeGraph 后续都应优先沿用这个 bundle 形态，而不是照搬 Claude/OpenCode/Codex 的安装路径。

## 1. DSH 插件宿主侧事实：`banbo-dsh` 里已有的模板

`banbo-dsh` 当前只有一个完整插件：`plugins/fish-shell/`。它不是普通脚本集合，而是一个 DSH bundle：

- `plugins/fish-shell/package.json` 通过 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明这是一个 DSH bundle，并暴露默认入口、`./local` 和 `./tool` 三个 export（`plugins/fish-shell/package.json:7`、`plugins/fish-shell/package.json:21`）。
- `cordis.patch.yml` 禁用 `bash-sandbox` 与 `tool-bash`，插入 `fish-shell` executor 和 `tool-fish` host tool，并同时 patch `agent-presets` 与 `dsh-tui-agent-presets` 两个 roster row（`plugins/fish-shell/cordis.patch.yml:17`、`plugins/fish-shell/cordis.patch.yml:23`、`plugins/fish-shell/cordis.patch.yml:35`、`plugins/fish-shell/cordis.patch.yml:54`）。
- `index.js` 通过继承 `SandboxBashExecutor`，把 `ctx.shell` 的底层 argv 从 `bash -c` 改成 `fish -c`；它特别覆盖了 `danger-full-access` 分支，因为基类在该分支会绕过 `confine()` 并落回硬编码 `bash -c`（`plugins/fish-shell/index.js:2`、`plugins/fish-shell/index.js:39`、`plugins/fish-shell/index.js:70`）。
- `tool.js` 注册模型可见的 `fish` tool，但执行时不自己 `child_process.spawn`，而是调用 `ctx.shell.resolve()` 和 `ctx.shell.run()`，从而继承 sandbox、credential scrub、输出截断、timeout clamp 和 result facts（`plugins/fish-shell/tool.js:4`、`plugins/fish-shell/tool.js:198`、`plugins/fish-shell/tool.js:215`、`plugins/fish-shell/tool.js:239`）。
- `README.md` 明确说明部署副本必须位于 `$DSH_HOME/profiles/node_modules/dsh-fish-shell`，因为插件真实路径决定 Node 模块解析；放在 profile tree 外的 `link:` 会找不到 harness 运行时的 `@deepseek-ai/*` 包，或造成重复 Cordis/Service 实例（`plugins/fish-shell/README.md:51`）。
- `scripts/sync-to-profile.sh` 把 checkout 中的插件复制到 `$DSH_HOME/profiles/node_modules/dsh-fish-shell`，并检查 fish preset 是否相对标准 preset 发生非 shell 段漂移（`scripts/sync-to-profile.sh:6`、`scripts/sync-to-profile.sh:19`、`scripts/sync-to-profile.sh:25`）。

这给 RTK / CodeGraph 后续适配提供了几个宿主级不变量：

1. **不要让 model-facing tool 自己 spawn 外部进程来绕过 harness seam**。如果需要运行命令，应通过 `ctx.shell`、`ctx.subprocess`、`ctx.fs` 等 harness seam，否则会绕过 sandbox、凭据清理、输出边界和 abort 信号。
2. **插件包要部署在 profile tree 内**，否则 peer dependency 解析和 Cordis 单例假设会破。
3. **profile patch 是 bundle 的安装语义**；它能禁用已有 row、插入 host-plane service/tool、替换 roster config，并能让 agent-plane preset 成为默认。
4. **同一 bundle 同时要考虑 web、dsh-tui、headless 等 surface**；`fish-shell` 通过 host-global tool + 双 roster row patch 实现跨 surface 可见。

## 2. RTK：它是什么、如何工作

### 2.1 定位：命令输出压缩代理，而不是 MCP 工具

RTK README 对外定位很明确：它会拦截 shell 命令并在 agent 读取前压缩输出，支持 `ls/tree`、`cat/read`、`grep/rg`、`git status/diff/log`、测试运行器、lint/build、Docker 等场景（`rtk/README.md:37`、`rtk/README.md:41`、`rtk/README.md:43`）。它的收益口径是“bash output bytes/token estimate 的减少”，不是账单直接减少；token 估算是 `bytes / 4`，没有真实 tokenizer（`rtk/README.md:58`、`rtk/README.md:64`）。

快速使用路径是 `rtk init` 给不同 agent 安装 hook 或插件；例如 Claude/Codex/OpenCode/Cursor/Pi/Hermes/Droid 等（`rtk/README.md:111`、`rtk/README.md:115`、`rtk/README.md:124`、`rtk/README.md:132`）。这说明 RTK 的主适配点是“宿主的 shell/tool 执行前事件”，不是 MCP。

### 2.2 CLI 入口和命令路由

`src/main.rs` 是单二进制入口：

- `AgentTarget` enum 覆盖 Claude、Cursor、Windsurf、Cline、Kilocode、Antigravity、Kimi、Pi、Hermes、Droid、Vibe（`rtk/src/main.rs:35`）。
- `Cli` 通过 clap 解析全局 `-v/-vv/-vvv`、`--ultra-compact`、`--skip-env`（`rtk/src/main.rs:62`、`rtk/src/main.rs:73`、`rtk/src/main.rs:77`、`rtk/src/main.rs:81`）。
- `Commands` enum 覆盖文件、git、GitHub/GitLab、JS/TS、Python、Go、Rust、Ruby、PHP、JVM、Docker/Kubectl/AWS 等大量子命令；示例可见 `Ls`、`Read`、`Git`、`Gh`、`Pnpm`、`Grep`、`Init`、`Gain` 等（`rtk/src/main.rs:86`、`rtk/src/main.rs:102`、`rtk/src/main.rs:133`、`rtk/src/main.rs:171`、`rtk/src/main.rs:212`、`rtk/src/main.rs:314`、`rtk/src/main.rs:340`、`rtk/src/main.rs:421`）。
- 如果 clap parse 失败，`run_fallback()` 会把未知命令作为原生命令执行，并尝试 TOML DSL filter；但 `gain/init/config/proxy/rewrite` 等 RTK meta-command 永远不 fallback 到系统命令（`rtk/src/main.rs:1287`、`rtk/src/main.rs:1295`、`rtk/src/main.rs:1307`、`rtk/src/main.rs:1404`）。
- 主程序重置 Unix SIGPIPE，避免 `rtk git log | head` 这类管道触发 Rust 默认 SIGPIPE panic/abort（`rtk/src/main.rs:1534`、`rtk/src/main.rs:1542`）。

### 2.3 执行与过滤流水线

RTK 的架构文档把命令生命周期拆成 parse → route → execute → filter → print → track 六个阶段（`rtk/docs/contributing/ARCHITECTURE.md:57`、`rtk/docs/contributing/ARCHITECTURE.md:66`、`rtk/docs/contributing/ARCHITECTURE.md:78`、`rtk/docs/contributing/ARCHITECTURE.md:86`、`rtk/docs/contributing/ARCHITECTURE.md:99`、`rtk/docs/contributing/ARCHITECTURE.md:123`）。命令模块都位于 `src/cmds/`，每个模块调用外部 CLI、过滤 stdout/stderr、记录 savings、传播退出码（`rtk/src/cmds/README.md:5`、`rtk/src/cmds/README.md:21`）。

关键机制：

- Rust filter 用于需要结构化解析、状态机、注入 CLI flag、跨命令路由的场景；简单通用场景可用 TOML DSL filter（`rtk/src/cmds/README.md:13`）。
- runner 支持 CaptureOnly、Buffered、Streaming、Passthrough 四种过滤模式（`rtk/src/cmds/README.md:63`、`rtk/src/cmds/README.md:67`）。
- 所有模块约定返回 `Result<i32>`，由 `main.rs` 唯一调用 `process::exit(code)`；模块不得直接 exit，避免丢失 tracking（`rtk/src/cmds/README.md:225`、`rtk/src/cmds/README.md:227`）。
- 过滤失败时 fallback 到 raw output；结构化解析类输出应通过 tee recovery 提供完整输出恢复路径，不允许只显示“还有 N 条”但没有可恢复路径（`rtk/src/cmds/README.md:247`、`rtk/src/cmds/README.md:251`、`rtk/src/cmds/README.md:255`）。
- tracking 写 SQLite，记录 input/output token estimate、savings%、execution time；项目路径也会 canonicalize 进记录，用于 project-scoped 查询（`rtk/src/core/tracking.rs:7`、`rtk/src/core/tracking.rs:42`、`rtk/src/core/tracking.rs:66`、`rtk/src/core/tracking.rs:115`）。

### 2.4 Hook / rewrite 系统

RTK 真正与 agent 集成的是 `rtk rewrite` 和 hook/plugin：

- `hooks/README.md` 明确：每个 agent hook 都是 thin delegate，只解析 agent-specific JSON、调用 `rtk rewrite`、返回 agent-specific 响应；所有改写规则在 Rust binary 的 `src/discover/registry.rs` 中（`rtk/hooks/README.md:5`、`rtk/hooks/README.md:17`、`rtk/hooks/README.md:30`）。
- Claude hook 输入是 `{ "tool_name": "Bash", "tool_input": { "command": "git status" } }`，输出通过 `hookSpecificOutput.updatedInput.command` 改成 `rtk git status`（`rtk/hooks/README.md:66`、`rtk/hooks/README.md:77`）。
- OpenCode plugin 用 `tool.execute.before`，只处理 `bash`/`shell` tool，并原地修改 `args.command`（`rtk/hooks/opencode/rtk.ts:19`、`rtk/hooks/opencode/rtk.ts:25`、`rtk/hooks/opencode/rtk.ts:29`、`rtk/hooks/opencode/rtk.ts:31`）。
- Hermes plugin 用 Python `pre_tool_call`，只处理 `terminal` tool，调用 `subprocess.run(["rtk", "rewrite", command], timeout=2)`，只在 exit code 为 0 或 3 且 stdout 有改写结果时修改 `args["command"]`（`rtk/hooks/hermes/rtk-rewrite/__init__.py:18`、`rtk/hooks/hermes/rtk-rewrite/__init__.py:40`、`rtk/hooks/hermes/rtk-rewrite/__init__.py:51`、`rtk/hooks/hermes/rtk-rewrite/__init__.py:62`、`rtk/hooks/hermes/rtk-rewrite/__init__.py:71`）。
- `src/hooks/README.md` 总结了安装模式、完整性校验、PatchMode、权限模型和新增 agent 的步骤；新增 agent 要加安装逻辑、必要时加 hook protocol processor、权限 Host、完整性 hash 等（`rtk/src/hooks/README.md:20`、`rtk/src/hooks/README.md:37`、`rtk/src/hooks/README.md:52`、`rtk/src/hooks/README.md:66`、`rtk/src/hooks/README.md:105`）。

`rtk rewrite` 的 exit code 是适配时最重要的协议：

| exit | 含义 | DSH 侧要考虑 |
|---|---|---|
| 0 | 可直接改写并允许 | 可改写 `spec.command` 后继续执行 |
| 1 | 无 RTK 等价命令 | 原命令透传 |
| 2 | Deny rule 命中 | 如果 DSH 有审批/阻断能力，可阻断；否则需保守透传或显式报错 |
| 3 | Ask/default verdict | 这是最棘手的点：DSH 要决定自动改写、走 approval，还是透传 |

权限模型来自 Claude settings：Deny > Ask > Allow > Default，并映射到 rewrite exit code（`rtk/src/hooks/README.md:68`、`rtk/src/hooks/README.md:76`）。在 DSH 里没有 Claude settings.json，简单调用 `rtk rewrite` 很可能大量得到 default/ask 语义；插件必须明确定义 DSH 的映射。

### 2.5 RTK 的宿主假设和风险

- **没有 daemon**：每次 rewrite 都是短生命周期二进制调用；适配 DSH 时应设置短 timeout 并 fail-open，参考 Hermes/OpenClaw 2s timeout。
- **不是 MCP**：不要试图把 RTK 当 MCP server 接入；它应接在 `ctx.shell` executor 或 tool pre-execute 之类的命令改写 seam 上。
- **OpenCode 安装路径有 XDG 差异**：RTK `resolve_opencode_dir()` 固定为 `~/.config/opencode`，而不是 `$XDG_CONFIG_HOME/opencode`；这与 CodeGraph 的 opencode target 不同，说明不要盲目复用现有安装逻辑到 DSH（研究轴发现于 `rtk/src/hooks/init.rs` 的 opencode dir 逻辑）。
- **stdout 是协议**：`rtk rewrite` 的 stdout 是改写后的命令，不应把 warning/debug 混进去；hook 错误路径应退出 0 并让原命令执行（`rtk/hooks/README.md:243`、`rtk/hooks/README.md:253`）。
- **输出过滤要保留退出码**：RTK 的价值不只是少输出，还要“不改变命令语义”；DSH 侧如果封装 shell executor，必须继续使用基类的 exit/signal/timeout/sandbox result facts。

## 3. CodeGraph：它是什么、如何工作

### 3.1 定位：本地代码图谱 + MCP 服务

CodeGraph README 定位为本地代码智能：用 Rust kernel / tree-sitter 解析代码，建立符号、调用边、依赖、文件的知识图谱，并通过 agent 一次 `codegraph_explore` 查询返回相关源代码、调用路径和影响面（`codegraph/README.md:9`、`codegraph/README.md:11`、`codegraph/README.md:16`、`codegraph/README.md:188`、`codegraph/README.md:192`）。安装分三步：安装 CLI、`codegraph install` 写入 agent MCP 配置、在每个项目里 `codegraph init` 建 `.codegraph/` 索引（`codegraph/README.md:73`、`codegraph/README.md:100`、`codegraph/README.md:110`）。

重要边界：`codegraph install` 只接入 agent，不会索引代码；索引是用户在项目中显式 `codegraph init` 的动作（`codegraph/README.md:108`、`codegraph/README.md:110`）。

### 3.2 Public API 和索引流水线

`src/index.ts` 暴露 `CodeGraph` class，连接 DB、extraction、resolution、graph、context 五层：

```
files → ExtractionOrchestrator → DB(nodes/edges/files)
      → ReferenceResolver
      → GraphQueryManager / GraphTraverser
      → ContextBuilder
```

这条流水线在仓库 CLAUDE 中也被总结为 layered pipeline（`codegraph/CLAUDE.md:34`、`codegraph/CLAUDE.md:38`、`codegraph/CLAUDE.md:48`）。

主要模块职责：

- `src/index.ts`：`CodeGraph` facade，提供 `init/open/close`、`indexAll/sync`、`searchNodes`、callers/callees/impact、`buildContext`、watch/unwatch 等（`codegraph/CLAUDE.md:52`）。
- `src/db/`：SQLite、FTS5、WAL、QueryBuilder，基于 Node 内置 `node:sqlite`（`codegraph/CLAUDE.md:53`）。
- `src/extraction/`：tree-sitter wrapper、语言 extractor、worker 线程解析（`codegraph/CLAUDE.md:54`）。
- `src/resolution/`：import resolver、name matcher、framework resolvers，生成 route/reference edges（`codegraph/CLAUDE.md:55`）。
- `src/graph/`：BFS/DFS、impact radius、path finding（`codegraph/CLAUDE.md:56`）。
- `src/context/`：把图查询结果格式化成 Markdown/JSON 上下文（`codegraph/CLAUDE.md:57`）。
- `src/sync/`：FileWatcher、git hook helpers（`codegraph/CLAUDE.md:59`）。
- `src/mcp/`：MCP server、tools、transport、server instructions（`codegraph/CLAUDE.md:60`）。

### 3.3 MCP 工具面

CodeGraph 的默认宿主面是 MCP。CLI `codegraph serve --mcp` 启动 stdio MCP server；CodeGraph installer 给各 agent 写的本质配置都是启动这条命令：

```json
{ "command": "codegraph", "args": ["serve", "--mcp"] }
```

CodeGraph 的 opencode target 写入的是：

```json
{
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

该 shape 在源码中说明为 opencode 使用 `mcp.<name>`，不是 `mcpServers`，`command` 是二进制与 args 合并的 string array，并且有显式 `enabled`（`codegraph/src/installer/targets/opencode.ts:22`、`codegraph/src/installer/targets/opencode.ts:118`）。

Codex target 则写 TOML `[mcp_servers.codegraph]`（研究轴定位于 `codegraph/src/installer/targets/codex.ts`）。这说明 DSH 如果已有 MCP registry，可以选择“写入/注入一个 MCP server entry”，而不是重写 CodeGraph 工具本体。

CodeGraph 的 MCP 工具说明核心是 `server-instructions.ts`。其中强调：

- `codegraph_explore` 是 primary tool；
- 用自然语言问题或符号/file names 一次拿源代码 + call path + blast radius；
- 不要先 grep/read；
- 未索引项目返回 guidance，用户决定是否 `codegraph init`；
- 如果 root 未索引但子项目有 `.codegraph/`，传 `projectPath`（这一点对 monorepo/DSH cwd 很关键）。

这些说明不是普通 README 文案，而是 MCP initialize response 里 agent 最早看到的行为约束；DSH 插件若自己注册 tool，也必须复用这些语义。

### 3.4 daemon / watch / sync 生命周期

CodeGraph 的进程模型比 RTK 复杂：

- MCP server 有 direct、proxy、daemon 三种模式；direct 是单进程 stdio，proxy 是 host 连接的轻量 stdio↔socket 管道，daemon 是 detached background process，多个 host 共享一个 daemon、watcher 和 SQLite handle（`codegraph/src/mcp/index.ts:17`、`codegraph/src/mcp/index.ts:19`、`codegraph/src/mcp/index.ts:22`、`codegraph/src/mcp/index.ts:25`）。
- daemon root 由 explicit path 或 cwd 经 `resolveServerRoot` 得到；它会 realpath canonicalize，避免 symlink/cwd 表达不同导致不同 socket/lock（`codegraph/src/mcp/index.ts:147`、`codegraph/src/mcp/index.ts:166`）。
- daemon 通过同一个 CLI script 重新 spawn：`process.execPath + process.execArgv + scriptPath + serve --mcp --path <root>`，并设置 `CODEGRAPH_DAEMON_INTERNAL=1`；日志写 `.codegraph/daemon.log`（`codegraph/src/mcp/index.ts:184`、`codegraph/src/mcp/index.ts:204`、`codegraph/src/mcp/index.ts:207`）。
- 如果没有可达 `.codegraph/`，daemon 不启动，直接 direct mode（`codegraph/src/mcp/index.ts:147`、`codegraph/src/mcp/index.ts:299`）。
- watcher 默认开启，监听文件变化并 debounce 后 sync；`CODEGRAPH_NO_WATCH=1` 可关；WSL2 `/mnt` 场景会禁用 watcher，避免宿主文件系统事件不可靠（研究轴定位于 `codegraph/src/sync/watch-policy.ts`）。

对 DSH 来说，这意味着：

1. 如果 DSH 的 sandbox 不允许 detached process、Unix socket、named pipe 或后台 daemon，应该设置 `CODEGRAPH_NO_DAEMON=1` 走 direct mode。
2. 如果 DSH 启动 MCP server 的 cwd 不稳定，应显式传 `--path <workspace>`，最好 realpath。
3. 如果 DSH profile 有自己的长期进程生命周期，要意识到 CodeGraph daemon 会超出单次 tool call 存活。

### 3.5 projectPath / root handling

CodeGraph root resolution 是适配高风险点：

- `.codegraph/` 目录是每个项目自己的索引，`codegraph init` 创建它并建立 DB（`codegraph/README.md:110`、`codegraph/README.md:117`）。
- CLI `resolveProjectPath` 会从 path/cwd 上行寻找最近已初始化项目；找不到则返回原路径，后续报友好错误（`codegraph/src/bin/codegraph.ts:239`、`codegraph/src/bin/codegraph.ts:244`、`codegraph/src/bin/codegraph.ts:252`）。
- MCP tool 的 `projectPath` 允许在 monorepo 或非默认 root 下显式指定项目；server instructions 的 no-root-index 变体专门告诉 agent 传 `projectPath`。
- CodeGraph CLAUDE 强调工具面即使 root 未索引也始终暴露，未索引是 success-shaped guidance 而不是 isError，避免 agent 因早期 error 放弃整个工具集（`codegraph/CLAUDE.md:107`）。

DSH 插件应把 workspace cwd、agent session cwd 与 MCP `--path/projectPath` 关系弄清楚：如果 DSH 的 agent cwd 是 `banbo-dsh/`，但用户要查 sibling repo，需要让工具参数可传目标 `projectPath`。

### 3.6 Installer target 抽象

CodeGraph 已经有比 RTK 更清晰的 target 抽象：

- `AgentTarget` interface：`id/displayName/docsUrl/supportsLocation/detect/install/uninstall/printConfig/describePaths`（`codegraph/src/installer/targets/types.ts:80`）。
- `registry.ts` 中列出 claude、cursor、codex、opencode、hermes、gemini、antigravity、kiro、copilot-vscode、copilot-cli、copilot-jetbrains（`codegraph/src/installer/targets/registry.ts:23`）。
- 新增 agent = 新建一个 target 文件 + registry entry（`codegraph/src/installer/targets/registry.ts:1`、`codegraph/src/installer/targets/types.ts:3`）。
- shared MCP server config 是 `{ type:'stdio', command:'codegraph', args:['serve','--mcp'] }`，Claude auto-allow permissions 是 `mcp__codegraph__*`（研究轴定位于 `codegraph/src/installer/targets/shared.ts`）。

如果将来给 CodeGraph 原项目加 DSH target，这是正统入口；但如果目标是写在 `banbo-dsh/` 下的 DSH bundle，则更可能只复用 CodeGraph 的 MCP stdio entry，而不是修改 upstream installer。

### 3.7 CodeGraph 的宿主假设和风险

- **Node 版本**：package engines 是 `>=20 <25`，CLI 对 Node 25 做硬阻断，对低于最低版本也阻断；实际 node:sqlite 需要 Node ≥22.5（`codegraph/package.json:58`、`codegraph/src/bin/codegraph.ts:89`、`codegraph/src/bin/codegraph.ts:101`、`codegraph/CLAUDE.md:53`）。
- **WASM runtime flag**：CLI 会必要时 relaunch 加 `--liftoff-only`，避免 tree-sitter WASM 在 Node/V8 下 OOM；DSH 如果内嵌/包装 `node` 启动，要保留这条启动路径（`codegraph/src/bin/codegraph.ts:109`、`codegraph/src/bin/codegraph.ts:114`）。
- **stdout 是 MCP 协议通道**：日志、update notice、daemon log 都必须走 stderr 或文件；DSH 包装 MCP 时不能把 stdout 附加任何额外文字。
- **工具默认只暴露 `codegraph_explore`**：其他工具通过 env `CODEGRAPH_MCP_TOOLS` 才能列出；这是为了让 agent 使用最稳定的工具而不是选择错误工具。DSH 若自行注册工具，应理解这个选择，不要一次性暴露所有底层 API。
- **NotIndexedError 不是 MCP error**：未索引、symbol 不存在这类 expected condition 返回 success-shaped text，而 `isError=true` 只保留给安全拒绝和真实故障。DSH 如果做二次封装，不应把这些 guidance 误转成异常。
- **Telemetry / update check**：CodeGraph telemetry default-on，并有后台 update check；企业/内网 DSH 部署应设置 `DO_NOT_TRACK=1`、`CODEGRAPH_TELEMETRY=0`、`CODEGRAPH_NO_UPDATE_CHECK=1`（研究轴定位于 `codegraph/src/telemetry/index.ts` 和 `codegraph/src/upgrade/update-check.ts`）。

## 4. RTK 与 CodeGraph 的关键差异：不要用同一种插件抽象硬套

| 维度 | RTK | CodeGraph | DSH 适配含义 |
|---|---|---|---|
| 本质 | CLI proxy / command output filter | Local code graph + MCP server | 一个接 shell executor，一个接 MCP/tool registry |
| 宿主事件 | shell/tool 执行前改写命令 | MCP initialize/tools/list/tools/call | RTK 应靠 executor/tool pre-execute；CodeGraph 可直接挂 MCP |
| 状态 | SQLite tracking DB；无 daemon | `.codegraph/` 项目 DB + daemon/watch/socket | CodeGraph 要考虑 cwd、projectPath、daemon；RTK 主要考虑 PATH/timeout |
| 安装 | 写 hook/plugin/rules 到 agent config dir | 写 MCP server config + instructions | DSH 里都不应直接照搬原安装路径，应做 Cordis bundle |
| 权限 | Claude Bash permission model | MCP read-only tool annotations / Claude auto-allow wildcard | RTK 的 Ask/Deny 要映射到 DSH approval；CodeGraph 工具应保持 read-only |
| 输出协议 | stdout = rewritten command 或过滤后命令输出 | stdout = JSON-RPC；tool result text 内含源代码 | DSH 包装时 stdout/stderr 边界完全不同 |
| 失败策略 | hooks fail-open，原命令继续 | expected errors success-shaped；fatal 才 isError | 两者都避免早期 hard error 教坏 agent，但语义不同 |

## 5. 面向 DSH 插件的先验约束

### 5.1 RTK 的合理 DSH 接入点

最接近当前 `fish-shell` 模板的做法是：提供一个继承 DSH shell executor 的 RTK executor，在 `run/start/confine` 前先调用 `rtk rewrite <command>`：

1. 原 `spec.command` → `rtk rewrite spec.command`；
2. exit 0：替换为 rewritten command；
3. exit 1：透传原 command；
4. exit 2：映射到 DSH approval/deny 机制，或保守透传并记录；
5. exit 3：明确选择“自动改写但保留审批”还是“透传”，不能默认忽略；
6. 子进程 timeout 后 fail-open；
7. 继续调用基类 executor，让 sandbox、timeout、abort、output cap 仍由 DSH 管。

关键不是写一个 `rtk` tool 让模型主动调用；那会违背 RTK“透明改写”的价值。RTK 的使用面应该尽量不改变模型工具选择。

### 5.2 CodeGraph 的合理 DSH 接入点

CodeGraph 已经是 MCP server，最小接入是注册一个 MCP server entry：

```yaml
codegraph:
  command: codegraph
  args: [serve, --mcp, --path, <workspace-realpath>]
```

需要额外保证：

- server stdout 原样接入 MCP transport，不被 DSH shell renderer 包裹；
- cwd / `--path` 指向用户实际 workspace；
- 如果 DSH sandbox 不适配 daemon，设置 `CODEGRAPH_NO_DAEMON=1`；
- 传入禁用 telemetry/update check 的 env（如部署策略需要）；
- 初始化说明要保留 CodeGraph 的“先用 explore、不要先 grep/read、未索引传 projectPath”的提示；
- 只读工具 annotation 或 DSH 等价权限要保持。

如果 DSH 没有通用 MCP registry，则可以仿照 CodeGraph MCP tool schema 注册 DSH native tools，但成本会高很多：需要重写 JSON-RPC transport、tool result shaping、error semantics、projectPath cache、staleness banner 等契约。

### 5.3 两者共同的 bundle 事实

RTK 和 CodeGraph 的后续插件都应以 `dsh.bundle.patch` + host-plane service/tool + agent preset 的方式落到 `banbo-dsh/`，而不是让 upstream installer 去写 `~/.config/opencode`、`~/.codex`、`~/.claude`。这能避免：

- 写错用户的外部 agent config；
- profile 不同步；
- duplicate Cordis instance；
- 与 DSH sandbox/approval/preset roster 脱节；
- 在 headless/web/tui surface 上行为不一致。

## 6. 证据索引

### RTK

- `rtk/README.md:37`：RTK 定位为过滤/压缩命令输出。
- `rtk/README.md:111`：`rtk init` 支持多 agent 接入。
- `rtk/README.md:136`：代理模式示意图。
- `rtk/CLAUDE.md:68`：command proxy architecture 概述。
- `rtk/docs/contributing/ARCHITECTURE.md:57`：六阶段执行生命周期。
- `rtk/docs/contributing/TECHNICAL.md:71`：hook installation。
- `rtk/docs/contributing/TECHNICAL.md:84`：hook interception。
- `rtk/src/main.rs:35`：`AgentTarget` enum。
- `rtk/src/main.rs:86`：`Commands` enum。
- `rtk/src/main.rs:1287`：fallback path。
- `rtk/src/main.rs:1534`：main + SIGPIPE 处理。
- `rtk/src/cmds/README.md:38`：command execution flow。
- `rtk/src/cmds/README.md:63`：filter modes。
- `rtk/src/cmds/README.md:225`：exit code propagation。
- `rtk/src/core/tracking.rs:7`：tracking architecture。
- `rtk/src/hooks/README.md:20`：installation modes。
- `rtk/src/hooks/README.md:66`：permission model。
- `rtk/hooks/README.md:17`：hook 工作机制。
- `rtk/hooks/README.md:188`：OpenCode plugin mutation 示例。
- `rtk/hooks/hermes/rtk-rewrite/__init__.py:40`：Hermes pre_tool_call 入口。
- `rtk/hooks/opencode/rtk.ts:19`：OpenCode tool.execute.before 入口。

### CodeGraph

- `codegraph/README.md:100`：`codegraph install` 接 agent。
- `codegraph/README.md:110`：`codegraph init` 接项目索引。
- `codegraph/README.md:188`：为什么需要 CodeGraph。
- `codegraph/CLAUDE.md:34`：layered pipeline。
- `codegraph/CLAUDE.md:52`：`src/index.ts` public API。
- `codegraph/CLAUDE.md:72`：installer target architecture。
- `codegraph/CLAUDE.md:88`：MCP server instructions 是单一工具指导来源。
- `codegraph/CLAUDE.md:98`：adapt the tool to the agent。
- `codegraph/CLAUDE.md:113`：explore budget。
- `codegraph/CLAUDE.md:128`：dynamic-dispatch coverage。
- `codegraph/package.json:58`：Node engines。
- `codegraph/src/bin/codegraph.ts:123`：无参数时运行 installer。
- `codegraph/src/bin/codegraph.ts:239`：resolveProjectPath。
- `codegraph/src/bin/codegraph.ts:1834`：`serve --mcp`。
- `codegraph/src/index.ts:141`：`CodeGraph` class。
- `codegraph/src/index.ts:279`：`CodeGraph.init`。
- `codegraph/src/mcp/index.ts:17`：direct/proxy/daemon 三模式。
- `codegraph/src/mcp/index.ts:236`：`MCPServer` class。
- `codegraph/src/mcp/index.ts:273`：MCPServer start 决策。
- `codegraph/src/mcp/tools.ts:67`：NotIndexedError success-shaped 语义。
- `codegraph/src/mcp/tools.ts:166`：explore budget。
- `codegraph/src/installer/targets/types.ts:80`：AgentTarget interface。
- `codegraph/src/installer/targets/registry.ts:23`：ALL_TARGETS。
- `codegraph/src/installer/targets/opencode.ts:22`：opencode config shape。

### DSH / banbo-dsh

- `banbo-dsh/plugins/fish-shell/package.json:21`：`dsh.bundle.patch`。
- `banbo-dsh/plugins/fish-shell/cordis.patch.yml:17`：禁用 base bash executor/tool。
- `banbo-dsh/plugins/fish-shell/cordis.patch.yml:23`：插入 fish executor/tool。
- `banbo-dsh/plugins/fish-shell/index.js:30`：`FishSandboxExecutor`。
- `banbo-dsh/plugins/fish-shell/tool.js:23`：tool plugin named export。
- `banbo-dsh/plugins/fish-shell/tool.js:215`：通过 `ctx.shell` 执行。
- `banbo-dsh/plugins/fish-shell/tool.js:239`：`ctx.tools.register`。
- `banbo-dsh/plugins/fish-shell/README.md:51`：profile node_modules symlink chain 部署约束。
- `banbo-dsh/scripts/sync-to-profile.sh:6`：必须部署到 profile tree。

## 7. 后续阅读线索

这些不是计划，只是后续做真正设计前应补读的材料：

- `deepseek-harness/docs/cookbook/adding-a-tool.md`：DSH native tool 注册、参数 schema、执行策略。
- `deepseek-harness/docs/subsystems/tools.md`、`shell.md`、`sandbox.md`、`permission-presets.md`：RTK executor 适配会直接依赖这些 seam。
- `deepseek-harness/packages/skill/skill-filesystem/` 与 `docs/subsystems/skills.md`：CodeGraph 若走 skill/local-root discovery，可参考这里。
- `codegraph/src/mcp/proxy.ts`、`query-pool.ts`、`explore-session-state.ts`：如果 DSH 不直接走 MCP stdio，而想复用 daemon socket，需要读这些。
- `rtk/src/discover/registry.rs` 与 `rtk/src/discover/rules.rs`：如果将来不想 subprocess 调 `rtk rewrite`，而要在 JS 插件中复刻改写规则，必须读完整 registry 和 rules。
