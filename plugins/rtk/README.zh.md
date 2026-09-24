# @banbolee/dsh-rtk

[English](./README.md) | **中文**

RTK 改写装饰器（DeepSeek Harness 插件）：一个普通的 Cordis 函数插件（`name`/`inject`/`Config`/`apply`），用于装饰运行中的 `ctx.shell` 执行器 —— 用 `rtk rewrite` oracle 包裹其 `run`/`start` —— 并通过 `rtk pipe` 压缩模型侧 `grep` 工具的输出。由于它是包裹而不是替换 shell，因此能与任何 shell 执行器（bash、fish 等）共存，且绝不注册重复的 shell provider。沙箱隔离与结果语义继承自被挂载的执行器。

## 前置条件

`rtk` CLI 必须**预先安装**并可在 `PATH` 上访问（或通过 `rtkBinary` 配置固定），本 bundle 才会产生任何效果。没有 `rtk` 时，插件仍可安装并运行，但每条命令都会 fail open 到直通（passthrough）—— 不会发生 `rtk rewrite`，`grep` 输出也永远不会被压缩。本 bundle 从不下载或安装 `rtk` 本身；请针对任意当前 `rtk` 发行版进行测试（已在 0.47.0 上验证）。

## 用法

**从 npm 安装（推荐）** —— 无需 clone：

```sh
dsh plugin --profile <name> add @banbolee/dsh-rtk
```

本地开发时，可在仓库根目录把本 bundle 安装到任意 DSH profile。必须带上 workspace 根标志 `-w`：否则 pnpm 无法在 profile 生成的 workspace 内解析本地包，安装会以 `ERR_PNPM_ADDING_TO_ROOT` 失败。

```bash
dsh plugin --profile <name> add -w ./plugins/rtk
```

若要用一条命令把两个本地 bundle（rtk 和 codegraph-mcp）安装到同一个隔离 profile：

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <name>
```

sync 辅助脚本要求设置 `DSH_HOME`，这样测试与手工 QA 始终作用于隔离的 profile 状态，而不是用户的默认 Harness home。

本插件是函数插件，用于装饰已挂载的 shell 执行器：它用 `rtk rewrite` oracle 包裹运行中的 `ctx.shell` 对象的 `run`/`start`，并注册一个 `tools/post-execute` 监听器来压缩 `grep` 输出。它从不挂载（或替换）shell provider，因此能与宿主挂载为 `ctx.shell` 的任何执行器（bash、fish 等）共存，不会产生重复的 service 注册。

## 配置

插件接受三个生效的可选开关，以及一个已废弃的兼容字段：

- `rtkBinary`：用于 `rtk rewrite` 和 `rtk pipe` 的 `rtk` 可执行文件（默认 `rtk`）。裸名字在 Harness 启动时从启动 PATH 解析一次；相对路径在 Harness 启动时从启动目录解析一次。请求无法通过 `PATH` 替换被固定的可执行文件，也无法通过其 workdir 重新解释相对路径。在 Windows 上，解析出的目标必须可直接执行（`.exe` 或 `.com`）；批处理 shim 不会通过命令 shell 启动。
- `rewriteTimeoutMs`：单次 `rtk rewrite` oracle 调用的时限，超时后 fail open 到直通（默认 `5000`）。
- `grepCompress`：启用后，工具运行结束后把 `grep` 工具输出通过 `rtk pipe -f grep` 管道处理（默认 `true`）。
- `askNote`：已废弃并被忽略。为保持 profile 兼容仍然接受，但 exit-3（`ask`）改写始终静默。

这三个生效开关原样穿过插件的 `Config` schema，因此 profile 可以在不修改包代码的情况下覆盖其运行时行为。`askNote` 仅为 profile 解析兼容而保留，没有运行时效果。

## 行为

每条 shell 命令在交由已挂载的 shell 执行器运行之前，都会先经过 `rtk rewrite`。退出码契约与 `rtk rewrite` 一致：

- Exit 0，改写：使用 stdout 中的改写后命令替代原命令运行，例如 `git status` 变为 `rtk git status`。如果 RTK 原样回显命令，则原命令按原样运行。
- Exit 1，直通：没有 RTK 等价物；原命令不做改动地运行。
- Exit 2，拒绝：fail closed。前台运行抛出带类型的 `RtkDenyError`（name 为 `RtkDenyError`，code 为 `RTK_DENY`），且零次委派调用；后台启动最终以被 kill 的进程收束，拒绝原因通过读取路径暴露一次。
- Exit 3，ask：不请求交互式批准。改写后的命令静默运行；插件不会向前台 stderr 或后台输出添加任何 RTK 专属文本。
- `rtk` 缺失、挂起或被信号杀死：fail open 到直通，因此命令执行永不被阻塞。

模型侧 `grep` 工具结果会被压缩：`grep` 工具执行后，其被接受的文本内容会通过 `rtk pipe -f grep` 管道处理。管道失败会 fail open 到原始输出，因此 grep 结果永不丢失或被阻塞。

沙箱隔离、workdir/env/stdin、timeout、abort、退出码、信号、stdout/stderr、沙箱事实以及后台进程生命周期都原样继承自被委派的执行器。本包从不绕过沙箱，也从不挂载 shell provider。

## 模型体验

从模型的角度看，shell 工具的行为与已挂载的执行器（bash、fish，或 profile 配置的任何执行器）完全一致，区别只在于命令运行前会经过 RTK 的透明改写，且 `grep` 工具结果可能经由 `rtk pipe -f grep` 压缩后返回。可观察到的差异仅限于测试所证明的内容：

- 被改写的命令以 `rtk <command>` 运行，其输出是委派方的真实输出。
- exit 3（`ask`）改写会运行改写后的命令，且不会向模型侧结果添加 RTK 专属消息。
- 拒绝会以 `RtkDenyError` 暴露，命令永不运行。
- `grep` 结果可能以压缩形式返回；当管道 fail open 时，原始文本原样返回。

本集成不量化 token 或 KV-cache 节省；RTK 的实际压缩幅度取决于真实二进制、其规则以及正在运行的命令。

## 已知限制与待办工作

- Exit 3（`ask`）会静默运行改写后的命令，而不是走交互式批准。永远不会提示人类，也没有计划任何交互式批准流程。
- 确定性的 fake-RTK 测试是本插件的权威验收。它们使用临时 PATH 上的 fake `rtk` fixture，绝不触碰用户全局 `rtk`、用户全局 DSH profile 或网络。
- 真实 `rtk` 保持可选。安装、测试或运行本插件从不需要真实二进制；当它存在时，本机上的 `rtk rewrite` 会以 exit 3（`ask`）退出，映射为静默改写。
- `start()`（后台进程）会同步查询 oracle，以便委派启动错误从调用本身传播。这在 oracle 运行期间会短暂阻塞事件循环，最长 `rewriteTimeoutMs`，并在挂起时 fail open。前台 `run()` 完全异步。
- 范围边界：本插件装饰已挂载的 shell 执行器（用 `rtk rewrite` oracle 包裹其 `run`/`start`），并通过 `rtk pipe` 压缩模型侧 `grep` 输出。它从不挂载 shell provider，从不绕过沙箱，也不修改 DSH core、RTK 或 CodeGraph。

## 验证

确定性的包内测试（fake `rtk` fixture，不使用用户全局状态）：

```bash
pnpm exec vitest run plugins/rtk/tests/*.spec.ts
```

文档形态测试（必需章节与契约字符串）：

```bash
pnpm exec vitest run tests/docs-shape-rtk.spec.ts
```

可选的真实 RTK 冒烟测试，仅在 PATH 上有真实 `rtk` 时运行，绝不是必需的验收：

```bash
scripts/smoke-rtk.sh
```
