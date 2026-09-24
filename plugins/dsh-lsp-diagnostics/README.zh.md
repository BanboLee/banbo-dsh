# @banbolee/dsh-lsp-diagnostics

[English](./README.md) | **中文**

DeepSeek Harness 的 host 面 Cordis bundle 插件：当一次官方 `write`/`edit`/`str_replace_editor` 变更落在 session workspace 内，或落在带 marker 根的兄弟 worktree/项目内时，工具结果仍然成功，而下一次模型推理会携带一条持久的 LSP diagnostics 插件 notice。它还注册了模型可调用的 `lsp_diagnostics(file_path)` 工具，用于显式诊断。

本插件是具名 namespace 函数插件：导出 `name`、`inject`、`Config` 和 `apply`，没有 default export。真实 Loader 读取模块 namespace（`exports.default ?? exports`），Cordis 从插件对象读取 `inject`/`Config`，因此每个公开元数据字段都能在安装后存活。插件从不修改 `deepseek-harness`，从不扩展 `ctx.lsp`，从不 import `@deepseek-ai/*/src/*`，也从不 monkey-patch 官方对象。

## 用法

**从 npm 安装（推荐）** —— 无需 clone：

```sh
dsh plugin --profile <name> add @banbolee/dsh-lsp-diagnostics
```

本地开发时，可在仓库根目录把本 bundle 安装到任意 DSH profile。必须带上 workspace 根标志 `-w`：否则 pnpm 无法在 profile 生成的 workspace 内解析本地包。

```bash
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
```

若要用一条命令安装到隔离的 profile：

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
```

sync 辅助脚本要求设置 `DSH_HOME`，这样测试与手工 QA 始终作用于隔离的 profile 状态，而绝不是用户的默认 Harness home。

插件注册一个真正的三参数 `tools/post-execute` waterfall 监听器 `(exec, _result, next)`：它恰好调用一次 `await next()`，且在任何插件 catch 之外，也从不消费 `_result` 占位符。

## 配置

所有开关都经由插件的 `Config` schema 与严格校验器。未知 key、不是合法 JSON 可表示的值、非法 timer/cap，或对封闭扩展路由的任何偏离，都会在加载时 fail loud。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `enabled=false` 时插件不创建任何 collector、runtime、coordinator 或 tool，不注册任何 tools/listeners/effects，也不 spawn 任何进程。 |
| `timeoutMs` | `5000` | 单个 post-execute 聚合的不可延长 deadline。 |
| `settleMs` | `200` | 静默窗口；必须 `< timeoutMs`。 |
| `shutdownTimeoutMs` | `1000` | 优雅 `shutdown`/`exit` 的预算。 |
| `killGraceMs` | `500` | 进程树的 TERM→KILL 宽限期。 |
| `maxDocumentBytes` | `2097152` | 经 `didOpen` 发送的文档的硬性 UTF-8 字节上限。 |
| `maxMessageBytes` | `4194304` | LSP 消息体上限。 |
| `maxStderrBytes` | `16384` | 有界的 stderr 尾部上限。 |
| `maxDiagnostics` | `50` | 自动 diagnostic 行的全局上限，也是 canonical direct-tool diagnostics 数组的每次调用上限。 |
| `maxResultChars` | `8000` | 最终聚合文本的 Unicode 码点上限。 |
| `reportClean` | `true` | 显式空结果是否渲染为 `Status: clean`。 |
| `servers` | TypeScript + Go | 封闭的 provider catalog；TypeScript 和 Go 默认启用，而 `clangd`、`rust` 和 `python` 需显式开启。 |

扩展路由是封闭的：`.ts` → typescript/typescript，`.tsx` → typescript/typescriptreact，可选的显式 `.js` → typescript/javascript，`.go` → go/go，`.c` → clangd/c，`.cc`/`.cpp`/`.cxx` → clangd/cpp，`.h`/`.hh`/`.hpp`/`.hxx` → clangd/cpp，`.rs` → rust/rust，`.py`/`.pyi` → python/python；任何其他扩展名 key、缺失的 canonical provider 条目、跨 provider 冲突或被改写的 language id 都会在加载时 fail loud，而运行时的其他扩展名会被静默忽略。

`servers` 块是 provider 级别的部分 overlay：省略 `servers` 或提供 `servers: {}` 会精确保留 TypeScript 和 Go 默认值，而提供已知的可选 key `clangd`、`rust` 或 `python` 会激活对应 provider。例如 `servers: { go: { command: '/path/trae-gopls' } }` 只改动 Go，无需提供 TypeScript 块。legacy 的 `extensionToLanguage` 字段仅当它包含该 provider 的 canonical 映射且只包含受支持的 provider 自有扩展时才被接受。`.js` 为兼容显式 TypeScript 配置而被接受，但默认不启用。

默认命令为 `typescript-language-server --stdio`、`gopls`、`clangd`、`rust-analyzer` 和 `pyright-langserver --stdio`。clangd、rust-analyzer 和 gopls 不接受任何默认参数。per-server 的 `env`、`configuration` 和 `initializationOptions` 可以被覆盖，且必须是 JSON 可表示的。

## 行为

要求存在非空、且能 canonicalize 为目录的 `session.header.cwd`。自动反馈首先对该 workspace 包含的 target 保持旧行为；workspace 之外的 target 只有在 target 本地的 `.git` 文件或目录能标识其自身 git worktree 根时才符合条件。cwd 缺失或为空、canonicalize 结果不是目录，以及没有 marker 根 git worktree 的外部 target，都会被静默忽略 —— 永远不会出现 `workspace unavailable` 或 `outside workspace` notice。workspace、cwd 和 URI 始终通过公开的 `ctx.fs` API（`resolve`/`stat`/`contains`/`targetKey`/`processPath`/`fileUrl`）推导，绝不来自原始的 `displayPath` 或宿主的 `process.cwd()`。

Fail-open 仅限插件自身的后处理失败：在下游 `await next()` 决策已经成功之后，diagnostics 错误、服务端缺失或崩溃、协议失败、读取错误或超时都不会改变该决策或结果，也永远不会返回 `kind: 'block'`。调用方 abort 由 ToolRuntime 和下游监听器决定；本插件从不吞掉、改写调用方 abort，也不承诺把它变成成功。

新鲜度使用写入后的 `FsVersion`，加上一个独立的 per-target 单调 generation 计数器，其取值在一个插件生命周期内永不重用。`retireIfCurrent` 只移除匹配的 active marker（generation + version），从不触碰计数器。当 generation 计数器耗尽时，插件 fail safe，所有更旧的候选都保持 stale。

符合条件的 target 由唯一的共享 comparator `(renderPath, String(targetKey), canonicalUri)` 按 Unicode 码点排序，同一顺序同时驱动诊断调度和渲染出的 section —— 绝不使用原始 `displayPath` 元组、`localeCompare` 或默认的 UTF-16 排序。

一次 exec 最多产生一条聚合 notice，其中恰好有一个标题 `[LSP diagnostics after write]`，每个保留的文件一个 section，section 之间恰好一个空行，且没有开头或结尾换行。在全局 `maxDiagnostics` 数量上限之后，保留行为零的 diagnostics 文件会被整体省略，绝不留下空 section；clean 和 unavailable 的 section 不消耗该上限。仅当至少保留一行 diagnostic 时，才追加恰好一条全局 advisory，并以一个空行分隔。`maxResultChars` 上限只在完整的 canonical 聚合构建完成之后才应用：固定 marker `…(truncated)` 替换被截断的后缀，输出永不超过该上限。

文档在 `stat.size` 预检之后用有界的 `ctx.fs.readBytes(target, signal, maxDocumentBytes)` 读取，并采用严格 UTF-8 解码；绝不使用无界的 `readText`。已知大小超过上限，或未知大小的读取抛出 `code === 'FS_TOO_LARGE'` 的 `FsError`，都映射为 `document too large`；任何其他读取错误映射为 `diagnostics unavailable`。公开接缝保证成功的 `readBytes` 是完整的，且 `bytes.length <= maxDocumentBytes`；插件从不依赖或返回超过上限的字节。

`publishDiagnostics` 的关联顺序是精确 URI 优先，其次按文档 version；只有被消费的字段 `range`、`severity`、`code`、`source` 和 `message` 会被校验，而标准可选字段 `tags`、`relatedInformation`、`codeDescription`、`data` 以及未知扩展字段会被安全忽略，绝不进入规范化 schema 或 renderer。位置是基于 0 的 UTF-16，渲染为基于 1 的起止坐标。

coordinator 同时持有 active augment-operation registry 和 `retiredIo` late-final-stat registry。Unload 按精确顺序静默：停止 direct-tool 准入 → 停止 coordinator 准入（同时关闭 runtime 准入）→ offTool → offPost → offObserved → abort coordinator 操作 → abort direct-tool 操作 → await 所有 active augment promise → await 所有 active direct-tool promise → await 所有 `retiredIo` → `runtime.dispose()`。清理在单个失败之后仍继续并聚合这些失败；因此没有任何直接调用能与 runtime disposal 竞争。每个操作最外层的 `finally` 会清除 deadline timer 并移除 caller/cleanup relay 监听器，不留任何残留。

`stopAdmission()` 只关闭闸门和 runtime 自身的准入；它从不 abort 操作。Active 操作在更靠后的 abort 步骤被 abort，即在两个 listener disposer 都运行之后，与文档记载的顺序完全一致。已经进入但仍阻塞在下游 `next()` 中的监听器没有插件自有的取消接缝，因此清理会在 pending-invocation registry 中跟踪每一个这样的调用并等待其结算（它在下游结果或错误返回之前取走并 retire 该 exec 的候选，包括 `next()` 同步抛出的情况）。deadline 使用注入的单调时钟，绝不使用 `Date.now()`，因此墙钟回拨无法延长硬 deadline。

Session teardown 还负责协议写入的静默：每个在途的 server-request handler 和序列化的写入尾部都在 cleanup 返回前结算，关闭期间不会启动新的 server-request handler —— 因此 cleanup 完成后不可能再写入任何排队的帧（responses、`shutdown`、`exit`）。与 `didOpen` 写入竞争的匹配 `publishDiagnostics` 会被缓冲，直到 open 写入成功；只有成功写入的 open generation 才接受通知，而失败的 `didOpen` 写入仍允许被允许的 fresh-instance 重试。共享 runtime 采用通用的 correctness-over-performance 策略：它仍会把一个 provider/workspace session 跨不同的 canonical URI 池化，但在该 session 已打开过的 URI 被再次诊断之前，它会驱逐并异步 retire 该 session，然后在一个全新进程中以 version 1 打开该 URI；这避免了 provider VFS 缓存返回同一 URI 的陈旧 diagnostics，而 retired teardown 在 unload 时仍被跟踪并排空。

`timeoutMs` 是整个 post-execute 的单个不可延长 deadline；最后一轮 freshness 是一次性的 final stat/deadline/generation 闸门。direct tool 同样从其注入的单调时钟捕获一个绝对 deadline，并且当 `now() >= deadlineAt` 时每个闸门都转为 timeout，即使事件循环饥饿尚未运行已排定的 timer 回调。deadline/caller/cleanup 丢失时绝不等待迟到的 final stat：未结算的记录在决策返回前被 retire 进 `retiredIo`。Session teardown 是唯一顺序：`shutdown` 请求 → `exit` 通知/自然关闭等待 → 有条件的 `handle.terminate()`（仅当仍存活时）→ await `handle.done` 与 `waitForExit()` → `processLifetimeController.abort()`；`terminate()` 是唯一的硬停止。

## 模型体验

`lsp_diagnostics(file_path)` 是模型可调用的只读工具，作用于一个已存在、且 `ctx.fs` 允许该 session 读取的文件。它接受 workspace 相对路径或绝对路径，并使用所有已配置的 provider 以及上文记载的封闭扩展路由。它具有与官方 `read` 工具相同的路径权限：对于被 `session.header.cwd` 包含的文件，该 cwd 仍是 LSP 项目根；对于 session cwd 之外的可读文件，工具优先使用 target 的 marker 根项目/worktree 根，然后回退到 session cwd。它从不创建、编辑或删除文件。非法请求会显式失败，并给出 `file_path must be a non-empty string`、`session workspace cwd`、`session workspace is not an existing directory`、`target does not exist`、`target is not a regular file`、`no configured diagnostics provider` 或 `target changed during diagnosis`。

direct tool 恰好有三种 canonical 结果：`diagnostics`，其规范化列表按与自动渲染相同的 comparator 排序，并在 ToolRuntime/PTC 收到之前被切片到 `maxDiagnostics`，外加一个始终存在的非负整数 `omitted_diagnostics`；`no_diagnostics`，渲染为 `No diagnostics reported for this file snapshot.`；以及 `unavailable`，带一个封闭 reason。renderer 会保留来自该 canonical 计数的省略 marker。当你需要显式诊断一个已存在的文件时调用它，尤其是在 shell 命令、formatter 或 generator 绕过了自动 `fs/observed` 反馈之后；当已有新鲜的自动反馈时，请避免冗余调用。在受支持的 write/edit 变更之后，自动的写入后反馈仍是默认行为，而 direct tool 是刻意调用的，并且会报告路径/workspace 错误，而不是把它们静默当作不符合条件。

从模型的角度看，每个变更工具（`write`、`edit`、`str_replace_editor` 的 create/str_replace/insert）都原样返回其结果；插件为下一次推理向 `decision.additionalContexts` 追加一条有界聚合 notice。notice 包含：

- 每个保留的文件一个 `File: <renderPath>` section —— diagnostics 为 `- <severity> <startLine>:<startCharacter>-<endLine>:<endCharacter> source=... code=... message` 行，或 `Status: clean`，或 `Status: diagnostics unavailable (<reason>)` —— 按共享的码点顺序排列；
- 当至少保留一行 diagnostic 时，恰好一条全局 advisory；
- 对不支持的扩展名、不符合条件的 workspace、`enabled=false` 或没有 workspace 的 session，则不产生任何内容。

Unavailable reason 是封闭的：`server not found`、`server crashed`、`timeout`、`malformed response`、`document too large`、`diagnostics unavailable`。

## 已知限制与待办工作

- 绕过 `ctx.fs`/`fs/observed` 的 shell 重定向、`sed -i`、脚本、formatter、generator 以及外部编辑器不在自动反馈的范围内；模型可以随后调用 `lsp_diagnostics(file_path)`。没有 filesystem watcher；项目根探测基于 marker，且只对受支持的源文件运行。
- 对于自动反馈，无 agent 的工具执行、cwd 缺失/为空或不是目录，以及没有 marker 根 git worktree 的外部 target，都被静默排除在范围之外，永不产生 notice。直接调用则改用与官方 `read` 等价的路径权限：session cwd 之外的可读文件符合条件，并在可用时使用其 marker 根项目/worktree 根。
- 插件不安装也不下载 `typescript-language-server`、`gopls`、`clangd`、`rust-analyzer` 或 `pyright-langserver`；请自行安装所需可执行文件并配置其路径。服务端缺失时 fail open，给出 `diagnostics unavailable (server not found)`。
- 可移植的确定性测试使用仓库内的 fixture 服务端，绝不使用真实服务端或网络。独立的显式 real-server lane 需显式开启，只使用本地文件系统/进程，且从不安装或下载工具。
- 实现与测试使用 `0.1.5-rc.2` 依赖族；peer 依赖 `@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-subprocess` 和 `@deepseek-ai/dsh-tools` 为 `^0.1.5-rc.2`。

## 验证

确定性的包内测试（fixture 服务端、无网络、无真实 LSP 服务端、隔离的临时 workspace/profile）：

```bash
pnpm exec vitest run plugins/dsh-lsp-diagnostics tests/package-shape.spec.ts
```

文档形态测试（必需章节与契约字符串）：

```bash
pnpm exec vitest run tests/docs-shape-lsp-diagnostics.spec.ts
```

类型检查与 sync 脚本帮助：

```bash
pnpm dlx --package=typescript@6.0.3 tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit
bash scripts/sync-lsp-diagnostics-to-profile.sh --help
```

显式的 real-server 验证与可移植覆盖是分开的。它要求 `RUN_REAL_LSP_SERVERS=1`、非空的 `REAL_LSP_PROVIDERS` 列表、每个被请求 provider 的显式可执行文件路径，以及一个证据路径：

```bash
RUN_REAL_LSP_SERVERS=1 \
REAL_LSP_PROVIDERS=rust \
REAL_LSP_RUST_COMMAND=/data00/home/lixingxin/.cargo/bin/rust-analyzer \
REAL_LSP_EVIDENCE_PATH=/tmp/dsh-real-rust.json \
pnpm exec vitest run tests/composition/lsp-real-servers.spec.ts
```

operator wrapper 执行同样的检查：

```bash
node scripts/qa/run-lsp-real-servers.mjs \
  --providers rust \
  --rust-command /data00/home/lixingxin/.cargo/bin/rust-analyzer \
  --evidence /tmp/dsh-real-rust.json
```

每个被请求的 provider 都必须完成 bad → diagnostic → repair → clean。该 JSON 文件是机器可读的证据；被请求的可执行文件缺失时会记录 `status: "blocked"` 并以非零码退出，而不是跳过或通过。
