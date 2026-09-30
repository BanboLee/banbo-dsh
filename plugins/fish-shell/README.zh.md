# @banbolee/dsh-fish-shell

[English](./README.md) | **中文**

DeepSeek Harness 的 fish shell executor 与工具：用 **fish** 而不是 bash 运行命令。bundle 在设计上与 surface 无关——基于 preset roster 的（dsh-tui、web）或基于 host tool 的（headless）——per-agent policy 也按「任意 agent preset 都适用」编写（standard、ptc、cordis、minimal 或第三方 preset）。但**已验证范围比设计更窄**：真实 lane 覆盖的是 `dsh-base` 类 profile（隔离 profile 的 bundle layer 为 `@deepseek-ai/dsh-base` + 本 bundle）。其它 preset/profile 组合一律**未验证**——dsh-tui 组合正在补测——部署到别处之前请以下方 **已知限制** 为权威口径。

## 这个 bundle 做什么

- **Executor（受限 / sandboxed）**（`index.js`，默认导出）：`FishSandboxExecutor`，一个 `SandboxBashExecutor` 子类，把 `fish -c` 命令而不是 `bash -c` 关进 sandbox。它以 `ctx.shell` 的形式挂载，替代基础 `bash-sandbox` executor。sandbox 后端、拒绝分类、runner 失败事实，以及 `sandboxMode` 能力事实（`dsh-permission-presets` 需要）都继承而来。受限路径与 `danger-full-access` 路径都运行 fish（基类的 full-access 分支会落到硬编码的 bash，因此被覆盖）。
- **Executor（非受限 / unconfined）**（`local.js`，导出为 `@banbolee/dsh-fish-shell/local`）：`FishLocalExecutor`，一个 `LocalBashExecutor` 子类，不带 sandbox 运行 `fish -c`。用于刻意在无 sandbox 下运行的自定义 composition；把它与 `dsh-permission-presets` 组合会在加载时 fail loud。
- **Tool**（`tool.js`，导出为 `@banbolee/dsh-fish-shell/tool`）：一个面向模型的 `fish` 工具，以 host-global 方式挂载，通过 `ctx.shell` 执行。它的功能 surface 与官方 `@deepseek-ai/dsh-tool-bash` 对齐（只把 shell 措辞换成 fish）：
  - **后台执行**：`run_in_background: true` 会把命令注册到 `ctx.jobs`（`kind: fish`）并返回 `{kind: 'background', jobId}`；进程的 observed 流会作为 registry 的拉取源交给它（lossy-read 上报由 registry 负责），sandbox runner 失败/拒绝事实并入 job 终态 detail，其余由 job controller 的 `job_output`/`job_kill` 处理。
  - **Sandbox 升级**：当挂载的 executor 会施加限制时，schema 会声明 `sandbox_permissions` + `justification`；升级会在**任何执行发生之前**通过 `ctx.approval` 裁决（只允许严格更宽的模式，fail-closed），被拒绝的结果会带上同一轮内的升级提示。Headless composition（没有 sandboxing executor）不会暴露这两个字段。
  - **结果事实**：前台结果携带完整的规范事实集，包括 sandbox 的 `enforcement`/`runnerFailed` 字段。
  - **UI 呈现**：`presentCall`/`presentResult` 把前台调用渲染成终端卡片（带 exit-status 状态胶囊），把后台/错误结果渲染成通用的围栏式控制台输出。
  - **Exit-code 提示词小节**：在 `TOOL_BASH` 位置注册 `tool:fish` 小节（「Check the [exit code: N] marker on every fish result…」）。
  - 除此之外，它还会传递调用方 session 已解析的 sandbox policy（因此 `/permission` 切换与 session workspace root 都会被遵守），从 `ctx.shellEnv` 收集受管理的 `DSH_*` 环境变量，渲染 harness marker 契约（`[exit code: N]`、`[stderr]`、`[sandbox: file access denied under <mode> mode]`、`[output truncated; full output: <path>]`），并且它的描述会用每条结果上的 `[fish syntax]` 提示教会模型 fish 语法。
- **Per-agent fish policy**（`policy.js`，导出为 `@banbolee/dsh-fish-shell/policy`）：一个以 host 方式挂载的 Cordis plugin，让每个 agent 都看到 fish 而不是 bash，**无论它跑在哪个 agent preset 下**。bundle patch 会禁用基础 bash executor（`bash-sandbox`）与 host bash 工具（`tool-bash`），挂载 fish executor 与 host-global `fish` 工具，并且不改动 preset——它不再修改 roster 默认值、不再注入 preset root，也不再往 `$DSH_HOME/.agent-presets/` 下写副本。preset 仍会注册自己的 `bash` 同名工具（standard/minimal 就会），而在 `agent/created` 时（以及每次 `tools/change`，即 `/preset` 重新组合之后），policy 会通过 `agent.ctx.tools.restrict({ deny: ['bash'] })` 按 agent 隐藏这个继承来的 bash 工具，并用一个空的 agent 作用域小节遮蔽 preset 静态的 `tool:bash` 提示词指引。agent 最终只剩下唯一一个 shell 工具：`fish`。在 `minimal` 下——它常驻的 bash 是持久 PTY 形态（参数只带 `command`，输出 schema 是普通字符串）——policy 会先在 agent 作用域注册一个持久 `fish` 工具（遮蔽 one-shot fish），然后隐藏 bash，因此 minimal session 在 fish 下保持持久语义。
- **持久 fish terminal 后端**（`terminal-fish.js`，导出为 `@banbolee/dsh-fish-shell/terminal-fish`）：一个库——**不**由 bundle patch 挂载——提供持久工具使用的 `fish` PTY 后端。它继承官方 `BashTerminalBackend`，启动 `fish --no-config -i`（可通过配置覆盖）并配上受控提示符——该提示符遵循 harness readiness 契约（OSC `133;D;<status>` + `dsh> `）——并通过同一套 sandbox policy 施加限制；官方 sandbox-mode fence 被复制进来（官方模块没有导出它；这份副本为自管理用途提供了一个可注入的 owner-activity 检查）。patch 刻意没有 `fish-terminal` host row：`terminals` service 是 `minimal` preset isolate realm 的 entry-local 资源，在 host 平面（headless / dsh-tui / composition 测试 profile）不可见，因此这样一行会永远停留在 pending。`apply` 会被导出，供直接装配与测试使用（或供显式挂载该 registry 的 composition 使用）。
- **持久 fish 工具**（`persistent.js`，导出为 `@banbolee/dsh-fish-shell/persistent`）：官方 `dsh-tool-bash-persistent` 模式的 fish 版本——每个 agent 一个缓存的 PTY shell，其 cwd、变量与函数在多次调用之间存活，并支持 marker 包裹的命令、串行执行、deadline/timeout 重置与 scrollback 读取。它刻意不导出 Cordis `apply`：`policy.js` 会在 agent 边界为 persistent-bash preset 调用 `registerPersistentFish(ctx, agentCtx)`。PTY 是**自管理**的：工具自己持有一个 `FishTerminalBackend` 实例并直接驱动它的 session（`backend.spawn(...)`、`session.startSend/read/status/close`），而不经过 `terminals` registry——agent 作用域的工具解析不到它（该 registry 只存在于 minimal preset 的 entry-local realm 内）。命令的引号处理使用 fish 单引号转义，并用带单个字符串参数的 `eval`（fish 4 没有 `$'...'` ANSI-C 引号语法，也没有 `eval --`），已用真实 fish 4.0.0 验证。
- **交互式终端会话**（`terminal-tools.js`，导出为 `@banbolee/dsh-fish-shell/terminal-tools`）：交互式（L2）surface 的 `terminalTools: 'allow' | 'deny'` 开关；它的 patch group 挂载官方 `@deepseek-ai/dsh-terminal` registry、用 fish argv 驱动的官方 `@deepseek-ai/dsh-terminal-bash` 后端，以及官方 `@deepseek-ai/dsh-tool-terminal`（六个 `terminal_*` 工具）。见下方 **交互式终端会话（L2）**。

## 支持矩阵

| 项 | 支持范围 | 验证情况 |
|---|---|---|
| `@deepseek-ai/*` dsh 族 | `0.2.0-rc.1` —— 精确版本钉在仓库根 `package.json`（`pnpm.overrides`） | 是：S0 探针在真实隔离 profile 里跑过 |
| `fish` | `3.7+` | 是，实测 `3.7.1`；更低版本未验证 |
| 平台 | 仅 POSIX：Linux 与 macOS。Windows 不支持（Windows 由 `pwsh` 系列覆盖） | Linux：真实 profile 实跑；`fish-pty-posix` CI job 在 `ubuntu-latest` 与 `macos-latest` 上跑同一条真实 PTY lane |
| Node.js | `>=22`（`engines.node`） | 是 |

## 安装

**从 npm 安装（推荐）**——无需 clone：

```sh
dsh plugin --profile <name> add @banbolee/dsh-fish-shell
```

从本仓库检出安装，按 profile 分别执行：

```sh
dsh plugin --profile <name> add ./plugins/fish-shell
```

把它加到每一个需要运行 fish 的 profile（dsh-tui、web、headless……）——但要记住上面的口径：今天只有 `dsh-base` 类 profile 已验证，其它 preset/profile 组合都未验证，dsh-tui 组合正在补测（见 **已知限制**）。bundle patch（`cordis.patch.yml`）是一个跨 surface 安全的 patch：它禁用 host bash executor 与 `tool-bash` row，挂载 fish executor 与 host-global `fish` 工具，并插入 `fish-preset-policy` row——该 row 会按 agent 隐藏 preset 继承来的 `bash` 工具（restriction + 空的 `tool:bash` 提示词遮蔽，在 `minimal` 下换成 persistent fish）。它还会为交互式终端会话追加 `fish-terminal-group`（见下方 **交互式终端会话（L2）**）。patch 不再改动 preset roster。

### 部署副本与 symlink 链

这些 executor 继承 `@deepseek-ai/dsh-bash-local` / `@deepseek-ai/dsh-bash-sandbox`。这些 import 必须解析到 harness 使用的同一个运行时实例——即 launcher 维护的 `profiles/node_modules/@deepseek-ai/*` symlink 链。直接 `link:` 到本仓库检出（位于 profile 树之外）将解析不到任何 `@deepseek-ai` 包，因此部署副本放在 `profiles/node_modules/@banbolee/dsh-fish-shell`（树内）。`scripts/sync-to-profile.sh <profile>` 会用 hoisted linker 打包插件（先 `pnpm install --prod --config.node-linker=hoisted`，再 `pnpm pack --config.node-linker=hoisted`），并用 `dsh plugin --profile <profile> add -w <tgz> --offline --config.auto-install-peers=false` 把产出的 tarball 装进 profile。pnpm 的 `file:` 依赖让每个 profile 指向该部署副本。发布到 npm 的包则正常安装（它的 realpath 本来就在 profile 树内）。

### 发布与 provenance

发布预期带上 **npm provenance**：`publishConfig` 里带 `provenance: true`，因此从支持 OIDC 的 CI（GitHub Actions）发布即可，或显式执行 `npm publish --provenance --access public`。本机发布会缺少为该次构建作证的 OIDC provider，因此维护者从工作站发版时必须为那一次发布关掉 provenance，用 `--no-provenance`。**2FA 是发版前置条件**——provenance 不能替代它，且 npm 在账户/组织侧校验，本仓库无法验证。发布前把 `CHANGELOG.md` 的 `[Unreleased]` 落成即将发布的版本号（`0.7.0` → `0.8.0`）。

## 交互式终端会话（L2）

除了一次性的 `fish` 工具，bundle 还挂载了一个交互式终端 surface：一个真实 fish PTY，模型用 `terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close` 与 `terminal_list` 来驱动它。它复用官方终端栈——插件不自建任何 backend。

patch 在 `cordis.patch.yml` 末尾追加了一个 `insert` group，id 为 `fish-terminal-group`：

| Row id | 包 | 配置 |
|---|---|---|
| `pty` | `@deepseek-ai/dsh-terminal` | — |
| `terminal-fish-pty` | `@deepseek-ai/dsh-terminal-bash` | `shellPath: fish`、`shellArgs: ["--no-config","-i","-C", <FISH_PROMPT_SETUP>]`、`timeoutMs: 300000` |
| `terminal-tools` | `@deepseek-ai/dsh-tool-terminal` | — |
| `fish-terminal-tools` | `@banbolee/dsh-fish-shell/terminal-tools` | `terminalTools: allow` |

group 行是 `cordis:group`，带 `group: true` 与 `isolate: { terminals: true }`：`terminals` service 必须在 group 内自足，因为挂在 host 平面的 row 会在所有 host 平面没有 `terminals` service 的 profile 里永远 pending。`tools` 刻意**不**隔离，因此 `terminal-tools` 注册的六个 `terminal_*` 工具会进入宿主 tools 注册表、对 agent 可见。

prompt setup 走 `-C` 参数（与 `terminal-fish.js` 导出的 `FISH_PROMPT_SETUP` 是同一个字符串）：启动时不提交任何输入，所以 motd 保持干净；而把同一份 setup 从 PTY 输入喂进去，会被 fish line editor 回显出来。

`fish-terminal-tools` 是本插件为该 surface 新增的唯一入口：`terminal-tools.js` 里实现的 `terminalTools` 开关。它默认 `allow`（什么都不做，与部署中的其它工具一致）；`deny` 会按 agent 收回这六个工具——见 **安全模型**。

**为什么一次性路径一行没动。** 追加的 group 是纯增量的。它上面的 host 平面 row 保持逐字不变（`bash-sandbox`/`tool-bash` 禁用，`fish-shell`/`tool-fish`/`fish-preset-policy` 插入），并且 `ctx.shell`（`index.js`）、一次性 `fish` 工具（`tool.js`）、`minimal` preset 的持久工具（`persistent.js`）与 `terminal-fish.js` 库都保持原样的代码路径：交互式 surface 的存在不改变一次性命令的任何行为。

**随包分发的 `@deepseek-ai/dsh-tool-terminal`。** `terminal-tools` row 从本包内部解析官方工具包，而不是从 profile 平面解析：`@deepseek-ai/dsh-tool-terminal@0.2.0-rc.1` 声明在 `dependencies` 与 `bundledDependencies` 里，所以打包会把它及其传递依赖作为实体文件放进 tarball 内的 `node_modules/` 下。这正是离线 profile 能安装成功的原因。它**不能**被挪到 `peerDependencies`：peer 解析会去找 profile 平面的副本，而那正是本设计要避免的。版本、来源与许可证见 `./THIRD-PARTY-NOTICES.md`。

## 安全模型

- **默认：`terminalTools: 'allow'`。** 交互式 surface 默认开启，与部署中挂载的其它工具完全一样；装了本 bundle 的 fish profile 行为等同于任何带官方终端工具的 profile。`deny` 是退出开关：把 `fish-terminal-tools` row 的 config 设为 `terminalTools: deny`，之后在 `agent/created` 时、以及每次 `tools/change`，policy 都会通过官方 `agent.ctx.tools.restrict({ deny: [...] })` 按 agent 限制这六个名字。名字是逐个枚举的（从不用 `terminal_*` 通配），因此上游新增的第七个工具不会静默穿透策略。
- **六个工具**：`terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close`、`terminal_list`。
- **不提供任何提权入口。** 本插件不注册自己的工具、不包装或替换任何宿主对象、不做 monkey-patch，也不提供 sudo/提权入口。会话进程就是 `fish`，权限等于启动该 profile 的用户权限。
- **沙箱继承。** 限制由宿主施加：`workspace-write` profile 会通过与其它命令相同的 sandbox 后端把交互式会话 fence 住（实测：写 `/etc` 被拒）。插件不旁路该 fence，也不把任何东西缓存到沙箱之外。
- **secret 处置与审计都有边界** —— 下方的 **已知限制** 写明了 hidden-input 边界、不支持的交互面与 best-effort 审计范围。

## 各 surface 的行为

- **基于 preset roster 的 surface**（dsh-tui、web）：roster 默认值不被改动（`standard`）。`fish-preset-policy` plugin 按 agent 生效，因此**任意** preset 下的 agent——`standard`、`ptc`、`cordis`、`minimal` 或普通第三方 preset——其 preset 继承来的 `bash` 工具都会被隐藏，只能看到唯一一个 shell 工具：`fish`。preset 静态的 `tool:bash` 提示词指引会被遮蔽（空的 agent 作用域小节），因此模型不会被告知去「check the bash result」。在 `minimal` 下，policy 会检测到 preset 的持久 bash 并改换成持久 `fish` 工具，因此 minimal session 保持其持久语义。持久 PTY 由 policy 自管理（直接驱动一个 `FishTerminalBackend`，不经过 `terminals` registry），所以它在每个 surface 都能工作——该 registry 只在 minimal preset 的 entry-local realm 内可见，这也正是 bundle 不挂载任何 `fish-terminal` row 的原因。
- **基于 host tool 的 surface**（headless）：agent 使用 host 平面的工具；被禁用的 host `tool-bash` 与 host-global `fish` 工具使 fish 成为 agent 唯一的 shell 工具。

## 行为

- **One-shot**（standard、ptc、cordis、第三方 preset 与 headless）：每次 shell 调用都会新起一个 non-login shell（对 `FishSandboxExecutor` 而言是在配置的 sandbox 后端下）；调用之间不保留任何状态（cwd、变量、函数、历史）。
- **Persistent**（`minimal` preset，它挂载了持久 PTY bash 机制）：agent 的 `fish` 工具为每个 agent 维持一个存活的 fish session。当前目录、导出的变量与已定义的函数在调用之间保留；通过该工具运行的命令串行执行；超过工具 deadline 的命令会被打断并重置 shell（下一次调用会从 workspace 用一个全新的 shell 开始）。持久 fish PTY 由工具自己通过 `FishTerminalBackend` 启动并驱动（不涉及 `terminals` registry）。
- 每条流的输出都受 executor 配置的上限约束；超时会被钳到 executor 的上限；模型看到的是 harness marker 契约。
- `run_in_background: true` 会把长时间运行的命令作为后台 job 启动（`kind: fish`）并立即返回一个 job id；用 `job_output` 读取输出，用 `job_kill` 停止它。后台 job **不设 deadline**（工具以 `onExpiry: 'none'` 解析它，与 0.1.5 的 `start()` 及官方 `dsh-tool-bash` 一致）：它会一直运行到 `job_kill`、取消或 composition teardown。需要组合 jobs service（`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`）；未组合时该工具会 fail loud。**运行中的 job 被 kill/cancel 已由真实 PTY lane 验证**（`plugins/fish-shell/tests/terminal-session-real.spec.ts`）：`job_output` 能读到仍然存活的 `terminal_send` job，`job_kill` 会把它收敛到终态 `killed`。
- 在 sandboxing executor 下，被拒绝的命令可以在同一轮内用 `sandbox_permissions`（够用的最窄的更宽模式）加一句 `justification` 重新以更宽权限执行；这次重试弹出的 approval prompt 就是用户表示同意的方式。当 approval prompt 被禁用或升级被拒绝时，拒绝即为最终结果。
- 要求 PATH 中有 `fish`；缺失时 executor 会 fail loud。

## 已知限制

- 模型默认使用 bash 惯用法；`fish` 工具的描述会教 fish 语法，但用 bash 方言写出的命令在 fish 下会失败。这是更换 shell 的预期代价。
- **旧的 bundled `fish` agent preset 已被移除**：本 bundle 不再包含 `presets/fish/` 目录，sync 脚本不再部署它、也不再做 drift 检查，并且不会再往 `$DSH_HOME/.agent-presets/fish` 写用户副本。旧版 bundle 遗留的该目录用户副本不会起作用（roster 已不再指向它），可以手动删除。
- **`minimal` 下的持久语义**由持久 `fish` 工具提供（cwd、导出的变量与已定义的函数在调用之间保留）。与官方持久 bash 一样，超出 deadline 的命令会被打断并重置 shell；agent 作用域的 `fish` 工具遮蔽了 host-global 的 one-shot 工具，因此升级字段（`sandbox_permissions`/`justification`）与后台执行（`run_in_background`）不属于持久 surface。
- **第三方 preset 的边界**：policy 隐藏的是从 preset 继承来的 `bash` 同名工具。如果一个 preset 刻意排除全局 `fish` 工具（用 allowlist 把它过滤掉），或用别的名字注册自己的 shell 工具，那么它会被原样保留，只按 agent 给出一次警告——bundle 从不改动第三方 preset。
- `fish` 工具面向模型的 surface 与官方 bash 工具对齐：后台执行（通过 `ctx.jobs` 的 `run_in_background`）、sandbox 升级（通过 `ctx.approval` 的 `sandbox_permissions`/`justification`）、终端/通用 UI 呈现，以及 `tool:fish` exit-code 提示词小节，全都支持。
- **secret：只有真 hidden-input 才是隐藏的。** 命令行、参数或 `terminal_send` 载荷对会话而言都是公开的：fish line editor 会回显收到的内容，会话也保留 scrollback，所以任何以非隐藏方式进入的内容都能被 `terminal_read` 读回。不要把 secret 作为命令参数或通过 `terminal_send` 传递；真正隐藏的读取（fish 里的 `read -s`）是唯一受支持、能让文本不出现在回显流里的方式。`stty -echo` **不是**处置方案：fish 的 line editor 会 repaint，哨兵仍留在 scrollback 里（实测）。
- **审计是 best-effort，不是生命周期承诺。** 插件只观察模型显式 `terminal_open`/`terminal_close` 调用能暴露的东西（session id、PID、status 迁移）。它**不**覆盖宿主侧回收、超时 kill、进程自己退出、别的 agent 或 owner 的会话，以及 group 内 `terminals` realm 的内部事件（在 host 平面不可见）。这里没有完整生命周期承诺：官方 `TerminalSessionService` 不暴露 open/exit/dispose 事件，插件也不自造审计面。
- **只支持文本交互。** 官方会话 API 不支持 `resize`、named key（方向键、具名 Ctrl 组合）、全屏 TUI（`vim`、`htop`）与 `TERM=dumb` 类降级终端；要支持它们只能自建 backend，不在范围内。
- **跨 agent 的 owner 隔离未验证。** 在真实 lane 覆盖它之前，插件只按官方会话实现的行为描述，不承诺 agent 之间的隔离。
- **未验证（不要当成已支持）**：minimal preset 或 dsh-tui 组合下的同形态 group；活动 PTY 存在时切 mode 被 fence 拒绝；read-only 模式下的 PTY spawn；`FishTerminalBackend` 的 submitted-setup 路径在 fish 3.7.1 上收敛（该库未被挂载，不影响 L2 surface）；跨 agent owner 隔离；完全无网的冷环境首装；以及 profile 的 `cordis.patch.yml` 直引 bundled 包名。
- 仅支持 POSIX：`fish` 二进制与底层 process-group 语义在 Windows 上不可用（Windows 由 pwsh 系列覆盖）。

## 排障

### `@deepseek-ai/dsh-tool-terminal` 报 `ERR_MODULE_NOT_FOUND`

bundled 的工具包没有进安装产物，或它被当成 peer（profile 平面）依赖解析了。用 hoisted linker 构建：先 `pnpm install --prod --config.node-linker=hoisted`，再 `pnpm pack --config.node-linker=hoisted`。不带它 pnpm 会拒绝打包 bundled 依赖，并报 `ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED`。检查产物：tarball 必须包含 `package/node_modules/@deepseek-ai/dsh-tool-terminal/package.json`。有一条上游原因不在我们能修的范围内：`@deepseek-ai/dsh-tool-terminal@0.2.0-rc.1` 声明的 `exports` 里有 `./src/*`，而实际发布的 tarball 并不包含它，因此任何按该子路径解析的代码都会 `ERR_MODULE_NOT_FOUND`。

### `ERR_PNPM_NO_OFFLINE_TARBALL`

离线安装打在了冷 pnpm store 上：`--offline` 下 pnpm 拒绝为它没有缓存的 tarball 走网络。先用一次联网安装把 store 预热（或首次安装时不带 `--offline` 跑同一条 `dsh plugin ... add`），然后再跑离线命令。插件自身的运行时依赖是随插件 tarball 一起走的，所以这是 store 状态问题，不是 bundled 文件缺失。
