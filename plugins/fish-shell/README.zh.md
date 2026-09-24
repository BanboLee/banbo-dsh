# @banbolee/dsh-fish-shell

[English](./README.md) | **中文**

DeepSeek Harness 的 fish shell executor 与工具：用 **fish** 而不是 bash 运行命令。可直接分发、与 surface 无关：任何挂载它的 profile 都能用——基于 preset roster 的（dsh-tui、web）或基于 host tool 的（headless）——并且在**任意 agent preset**（standard、ptc、cordis、minimal 或第三方 preset）下都能用。

## 这个 bundle 做什么

- **Executor（受限 / sandboxed）**（`index.js`，默认导出）：`FishSandboxExecutor`，一个 `SandboxBashExecutor` 子类，把 `fish -c` 命令而不是 `bash -c` 关进 sandbox。它以 `ctx.shell` 的形式挂载，替代基础 `bash-sandbox` executor。sandbox 后端、拒绝分类、runner 失败事实，以及 `sandboxMode` 能力事实（`dsh-permission-presets` 需要）都继承而来。受限路径与 `danger-full-access` 路径都运行 fish（基类的 full-access 分支会落到硬编码的 bash，因此被覆盖）。
- **Executor（非受限 / unconfined）**（`local.js`，导出为 `@banbolee/dsh-fish-shell/local`）：`FishLocalExecutor`，一个 `LocalBashExecutor` 子类，不带 sandbox 运行 `fish -c`。用于刻意在无 sandbox 下运行的自定义 composition；把它与 `dsh-permission-presets` 组合会在加载时 fail loud。
- **Tool**（`tool.js`，导出为 `@banbolee/dsh-fish-shell/tool`）：一个面向模型的 `fish` 工具，以 host-global 方式挂载，通过 `ctx.shell` 执行。它的功能 surface 与官方 `@deepseek-ai/dsh-tool-bash` 对齐（只把 shell 措辞换成 fish）：
  - **后台执行**：`run_in_background: true` 会把命令注册到 `ctx.jobs`（`kind: fish`）并返回 `{kind: 'background', jobId}`；输出读取会带上 lossy-read 与 sandbox runner 失败/拒绝通知，其余由 job controller 的 `job_output`/`job_kill` 处理。
  - **Sandbox 升级**：当挂载的 executor 会施加限制时，schema 会声明 `sandbox_permissions` + `justification`；升级会在**任何执行发生之前**通过 `ctx.approval` 裁决（只允许严格更宽的模式，fail-closed），被拒绝的结果会带上同一轮内的升级提示。Headless composition（没有 sandboxing executor）不会暴露这两个字段。
  - **结果事实**：前台结果携带完整的规范事实集，包括 sandbox 的 `enforcement`/`runnerFailed` 字段。
  - **UI 呈现**：`presentCall`/`presentResult` 把前台调用渲染成终端卡片（带 exit-status 状态胶囊），把后台/错误结果渲染成通用的围栏式控制台输出。
  - **Exit-code 提示词小节**：在 `TOOL_BASH` 位置注册 `tool:fish` 小节（「Check the [exit code: N] marker on every fish result…」）。
  - 除此之外，它还会传递调用方 session 已解析的 sandbox policy（因此 `/permission` 切换与 session workspace root 都会被遵守），从 `ctx.shellEnv` 收集受管理的 `DSH_*` 环境变量，渲染 harness marker 契约（`[exit code: N]`、`[stderr]`、`[sandbox: file access denied under <mode> mode]`、`[output truncated; full output: <path>]`），并且它的描述会用每条结果上的 `[fish syntax]` 提示教会模型 fish 语法。
- **Per-agent fish policy**（`policy.js`，导出为 `@banbolee/dsh-fish-shell/policy`）：一个以 host 方式挂载的 Cordis plugin，让每个 agent 都看到 fish 而不是 bash，**无论它跑在哪个 agent preset 下**。bundle patch 会禁用基础 bash executor（`bash-sandbox`）与 host bash 工具（`tool-bash`），挂载 fish executor 与 host-global `fish` 工具，并且不改动 preset——它不再修改 roster 默认值、不再注入 preset root，也不再往 `$DSH_HOME/.agent-presets/` 下写副本。preset 仍会注册自己的 `bash` 同名工具（standard/minimal 就会），而在 `agent/created` 时（以及每次 `tools/change`，即 `/preset` 重新组合之后），policy 会通过 `agent.ctx.tools.restrict({ deny: ['bash'] })` 按 agent 隐藏这个继承来的 bash 工具，并用一个空的 agent 作用域小节遮蔽 preset 静态的 `tool:bash` 提示词指引。agent 最终只剩下唯一一个 shell 工具：`fish`。在 `minimal` 下——它常驻的 bash 是持久 PTY 形态（参数只带 `command`，输出 schema 是普通字符串）——policy 会先在 agent 作用域注册一个持久 `fish` 工具（遮蔽 one-shot fish），然后隐藏 bash，因此 minimal session 在 fish 下保持持久语义。
- **持久 fish terminal 后端**（`terminal-fish.js`，导出为 `@banbolee/dsh-fish-shell/terminal-fish`）：一个库——**不**由 bundle patch 挂载——提供持久工具使用的 `fish` PTY 后端。它继承官方 `BashTerminalBackend`，启动 `fish --no-config -i`（可通过配置覆盖）并配上受控提示符——该提示符遵循 harness readiness 契约（OSC `133;D;<status>` + `dsh> `）——并通过同一套 sandbox policy 施加限制；官方 sandbox-mode fence 被复制进来（官方模块没有导出它；这份副本为自管理用途提供了一个可注入的 owner-activity 检查）。patch 刻意没有 `fish-terminal` host row：`terminals` service 是 `minimal` preset isolate realm 的 entry-local 资源，在 host 平面（headless / dsh-tui / composition 测试 profile）不可见，因此这样一行会永远停留在 pending。`apply` 会被导出，供直接装配与测试使用（或供显式挂载该 registry 的 composition 使用）。
- **持久 fish 工具**（`persistent.js`，导出为 `@banbolee/dsh-fish-shell/persistent`）：官方 `dsh-tool-bash-persistent` 模式的 fish 版本——每个 agent 一个缓存的 PTY shell，其 cwd、变量与函数在多次调用之间存活，并支持 marker 包裹的命令、串行执行、deadline/timeout 重置与 scrollback 读取。它刻意不导出 Cordis `apply`：`policy.js` 会在 agent 边界为 persistent-bash preset 调用 `registerPersistentFish(ctx, agentCtx)`。PTY 是**自管理**的：工具自己持有一个 `FishTerminalBackend` 实例并直接驱动它的 session（`backend.spawn(...)`、`session.startSend/read/status/close`），而不经过 `terminals` registry——agent 作用域的工具解析不到它（该 registry 只存在于 minimal preset 的 entry-local realm 内）。命令的引号处理使用 fish 单引号转义，并用带单个字符串参数的 `eval`（fish 4 没有 `$'...'` ANSI-C 引号语法，也没有 `eval --`），已用真实 fish 4.0.0 验证。

## 安装

**从 npm 安装（推荐）**——无需 clone：

```sh
dsh plugin --profile <name> add @banbolee/dsh-fish-shell
```

从本仓库检出安装，按 profile 分别执行：

```sh
dsh plugin --profile <name> add ./plugins/fish-shell
```

把它加到每一个需要运行 fish 的 profile（dsh-tui、web、headless……）。bundle patch（`cordis.patch.yml`）是一个跨 surface 安全的 patch：它禁用 host bash executor 与 `tool-bash` row，挂载 fish executor 与 host-global `fish` 工具，并插入 `fish-preset-policy` row——该 row 会按 agent 隐藏 preset 继承来的 `bash` 工具（restriction + 空的 `tool:bash` 提示词遮蔽，在 `minimal` 下换成 persistent fish）。patch 不再改动 preset roster。

### 部署副本与 symlink 链

这些 executor 继承 `@deepseek-ai/dsh-bash-local` / `@deepseek-ai/dsh-bash-sandbox`。这些 import 必须解析到 harness 使用的同一个运行时实例——即 launcher 维护的 `profiles/node_modules/@deepseek-ai/*` symlink 链。直接 `link:` 到本仓库检出（位于 profile 树之外）将解析不到任何 `@deepseek-ai` 包，因此部署副本放在 `profiles/node_modules/@banbolee/dsh-fish-shell`（树内）。`scripts/sync-to-profile.sh` 会在改动后把插件复制到那里。pnpm 的 `file:` 依赖让每个 profile 指向该部署副本。发布到 npm 的包则正常安装（它的 realpath 本来就在 profile 树内）。

## 各 surface 的行为

- **基于 preset roster 的 surface**（dsh-tui、web）：roster 默认值不被改动（`standard`）。`fish-preset-policy` plugin 按 agent 生效，因此**任意** preset 下的 agent——`standard`、`ptc`、`cordis`、`minimal` 或普通第三方 preset——其 preset 继承来的 `bash` 工具都会被隐藏，只能看到唯一一个 shell 工具：`fish`。preset 静态的 `tool:bash` 提示词指引会被遮蔽（空的 agent 作用域小节），因此模型不会被告知去「check the bash result」。在 `minimal` 下，policy 会检测到 preset 的持久 bash 并改换成持久 `fish` 工具，因此 minimal session 保持其持久语义。持久 PTY 由 policy 自管理（直接驱动一个 `FishTerminalBackend`，不经过 `terminals` registry），所以它在每个 surface 都能工作——该 registry 只在 minimal preset 的 entry-local realm 内可见，这也正是 bundle 不挂载任何 `fish-terminal` row 的原因。
- **基于 host tool 的 surface**（headless）：agent 使用 host 平面的工具；被禁用的 host `tool-bash` 与 host-global `fish` 工具使 fish 成为 agent 唯一的 shell 工具。

## 行为

- **One-shot**（standard、ptc、cordis、第三方 preset 与 headless）：每次 shell 调用都会新起一个 non-login shell（对 `FishSandboxExecutor` 而言是在配置的 sandbox 后端下）；调用之间不保留任何状态（cwd、变量、函数、历史）。
- **Persistent**（`minimal` preset，它挂载了持久 PTY bash 机制）：agent 的 `fish` 工具为每个 agent 维持一个存活的 fish session。当前目录、导出的变量与已定义的函数在调用之间保留；通过该工具运行的命令串行执行；超过工具 deadline 的命令会被打断并重置 shell（下一次调用会从 workspace 用一个全新的 shell 开始）。持久 fish PTY 由工具自己通过 `FishTerminalBackend` 启动并驱动（不涉及 `terminals` registry）。
- 每条流的输出都受 executor 配置的上限约束；超时会被钳到 executor 的上限；模型看到的是 harness marker 契约。
- `run_in_background: true` 会把长时间运行的命令作为后台 job 启动（`kind: fish`）并立即返回一个 job id；用 `job_output` 读取输出，用 `job_kill` 停止它。需要组合 jobs service（`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`）；未组合时该工具会 fail loud。
- 在 sandboxing executor 下，被拒绝的命令可以在同一轮内用 `sandbox_permissions`（够用的最窄的更宽模式）加一句 `justification` 重新以更宽权限执行；这次重试弹出的 approval prompt 就是用户表示同意的方式。当 approval prompt 被禁用或升级被拒绝时，拒绝即为最终结果。
- 要求 PATH 中有 `fish`；缺失时 executor 会 fail loud。

## 已知限制

- 模型默认使用 bash 惯用法；`fish` 工具的描述会教 fish 语法，但用 bash 方言写出的命令在 fish 下会失败。这是更换 shell 的预期代价。
- **旧的 bundled `fish` agent preset 已被移除**：本 bundle 不再包含 `presets/fish/` 目录，sync 脚本不再部署它、也不再做 drift 检查，并且不会再往 `$DSH_HOME/.agent-presets/fish` 写用户副本。旧版 bundle 遗留的该目录用户副本不会起作用（roster 已不再指向它），可以手动删除。
- **`minimal` 下的持久语义**由持久 `fish` 工具提供（cwd、导出的变量与已定义的函数在调用之间保留）。与官方持久 bash 一样，超出 deadline 的命令会被打断并重置 shell；agent 作用域的 `fish` 工具遮蔽了 host-global 的 one-shot 工具，因此升级字段（`sandbox_permissions`/`justification`）与后台执行（`run_in_background`）不属于持久 surface。
- **第三方 preset 的边界**：policy 隐藏的是从 preset 继承来的 `bash` 同名工具。如果一个 preset 刻意排除全局 `fish` 工具（用 allowlist 把它过滤掉），或用别的名字注册自己的 shell 工具，那么它会被原样保留，只按 agent 给出一次警告——bundle 从不改动第三方 preset。
- `fish` 工具面向模型的 surface 与官方 bash 工具对齐：后台执行（通过 `ctx.jobs` 的 `run_in_background`）、sandbox 升级（通过 `ctx.approval` 的 `sandbox_permissions`/`justification`）、终端/通用 UI 呈现，以及 `tool:fish` exit-code 提示词小节，全都支持。
- 仅支持 POSIX：`fish` 二进制与底层 process-group 语义在 Windows 上不可用（Windows 由 pwsh 系列覆盖）。
