# AGENTS.md

本仓库（banbo-dsh）是 DeepSeek Harness 的插件集合仓库（rtk、codegraph-mcp、fish-shell、lsp-diagnostics、llm-pi-ai-with-session、agents）。对仓库的任何修改请遵守以下约定。

## 插件命名约定（强制）

所有插件包发布到 npm 时统一使用 scoped 命名空间，**延续此方案**：

```
@banbolee/dsh-<name>
```

- 本地目录路径保持 `plugins/<name>`（如 `plugins/rtk`），**目录名与路径不改**。
- `package.json` 的 `name` 字段必须为 `@banbolee/dsh-<name>`；不论名字在 npmjs 上是否被占用，一律走 `@banbolee` scope，**不得**改用其它 unscoped 名称（scoped 名称永不与他人冲突）。
- 现有六个插件（发布名）：
  - `@banbolee/dsh-rtk`
  - `@banbolee/dsh-codegraph-mcp`
  - `@banbolee/dsh-fish-shell`
  - `@banbolee/dsh-lsp-diagnostics`
  - `@banbolee/dsh-llm-pi-ai-with-session`
  - `@banbolee/dsh-agents`
- 新插件一律命名为 `@banbolee/dsh-<name>`，先确认 npm 可用性再定 `<name>`。

## 文档语言约定（强制）

仓库采用**英文为主的双语 README**：

| 文件 | 语言 | 作用 |
|---|---|---|
| `README.md` | **英文** | 主文档。npm 与 GitHub **默认渲染的就是它**，所以它必须是英文 |
| `README.zh.md` | **中文** | 中文对照 |

**适用范围**：根 `README.md` 与**每个** `plugins/<name>/README.md`。

规则：

1. **两份都要有**，缺一不可；`package.json` 的 `files` 必须同时列出 `README.md` 和 `README.zh.md`，否则中文版不会进发布包；
2. **结构必须一致**：标题层级与顺序、表格行列数、代码块位置逐一对齐——改一份就要同步另一份；
3. **不翻译的东西两份相同**：行内代码（包名、路径、工具名、CLI 参数、配置键、环境变量）、链接目标、URL、徽章；**代码块里的命令与路径**也必须一致——一个被翻译坏的 `dsh plugin ... add` 就是一条坏指令。但**注释和右侧对齐的注解属于散文，应当翻译**（`some-command      # 说明`、`├── agents/*.yaml        你的定义`）；判定口径是"**两个及以上空格之后的部分**"，所以命令内部单个空格不会被误切；
4. **语言切换器**放在 `#` 标题下一行、空一行之前，**英文在前**，当前语言加粗：
   - `README.md` 里写 `**English** | [中文](./README.zh.md)`
   - `README.zh.md` 里写 `[English](./README.md) | **中文**`
5. 契约测试（`tests/docs-shape-*.spec.ts`）按语言分别断言，所以**不要**把两份文件的内容互换——`docs-shape-agents.spec.ts` 会立刻失败。

> 历史坑：根 README 曾经是中文 `README.md` + `README.en.md`，而 5 个插件的 README 是纯英文，导致同一个仓库两套约定，且根英文版长期缺内容（少一整行插件、少一段卸载说明、还写着 "five bundles"）。统一成英文为主之后这类漂移只会在改一份忘另一份时出现，而结构对齐规则能把它暴露出来。

## 新增/改名插件时的联动清单

改包名或加新插件时，以下位置必须同步，否则契约测试会挂：

1. `plugins/<name>/package.json`：`name` + `files` 字段（发布内容白名单）
2. 插件内 `cordis.patch.yml` 的 `name:` 行（= 安装后 cordis 要加载的包名）
3. 契约测试：
   - `tests/package-shape.spec.ts`：`bundleExpectations` 的 `packageName`
   - 各 `tests/docs-shape-*.spec.ts`（安装命令等契约字符串）
   - 插件自带 `tests/bundle.spec.ts`（patch 行名断言）
4. 根 `README.md`：插件总览表、卸载命令（`dsh plugin --profile <p> remove @banbolee/dsh-<name>`）
5. 根 `package.json` 的 `typecheck` 脚本：把新插件的 `tsconfig.json` 追加进那条写死的 `tsc -p … --noEmit` 链
6. `scripts/qa/lib/profile.mjs`：`[插件目录, 包名]` 映射表
7. `scripts/sync-to-profile.sh <profile>`：fish 部署路径仍是 `profiles/node_modules/@banbolee/dsh-fish-shell`，但不再手写拷贝清单——改为 pack（hoisted linker：`pnpm install --prod --config.node-linker=hoisted` → `pnpm pack --config.node-linker=hoisted`）后 `dsh plugin --profile <p> add -w <tgz> --offline --config.auto-install-peers=false`，bundled 依赖必须随 tgz 进 profile
8. `pnpm-lock.yaml`：改名后执行 `pnpm install` 重新生成
9. 测试中的 `pnpm list --filter @banbolee/dsh-<name>` 与断言字符串

## 其它约定

- 依赖族固定在 `@deepseek-ai/* ^0.2.1-rc.2`（与 dsh 0.2.1-rc.2 对齐）；升级依赖族时同步更新测试断言与文档。全族的精确版本钉在根 `package.json` 的 `pnpm.overrides`（**不要**搬到 `pnpm-workspace.yaml`：本仓 `packageManager` 固定 pnpm@9.3.0，实测只有 `package.json` 里的 overrides 生效）。重建依赖树必须 `rm -rf node_modules plugins/*/node_modules pnpm-lock.yaml` 后再 `env NODE_ENV=development pnpm install`——只删 lock 会复用旧实例、残留旧族。
  - `0.2.0-rc.2 → 0.2.1-rc.2` 有两个例外，**不要**再把它们加回 overrides 或任何 manifest（上游已下架，`npm view <pkg>@0.2.1-rc.2` 返回 404）：`@deepseek-ai/dsh-invariants`（最后一版 `0.2.0-rc.2`；该族每个包的 `lib/types/invariant.*` 与 peer 声明同时被删除）与 `@deepseek-ai/dsh-subagent-in-process-driver`（最后一版 `0.2.1-alpha.1`；`dsh-subagent-spawn-in-process@0.2.1-rc.2` 已不再声明该 peer）。
  - 同一族的 peer 基线随之上移：`@deepseek-ai/cordis` `~4.0.5`、`@deepseek-ai/schemastery` `~3.18.5`。
  - `0.2.1-rc.2` 的 `ctx.subagents` 只提供 `startActivation()`：`start()` / `startContinuable()` 已删除，`SubagentRun` 的 `id`/`localAgent` 换成 `SubagentActivation` 的 `childId`，且 `SubagentStartRequest` 不再接受 `persona`/`toolFilter`（子代理组合改由 preset 或创建窗口自行施加）。插件里不要再用旧名字。
- 插件核心约束：不修改 deepseek-harness 内核、不 monkey-patch 官方对象、只通过公开扩展点（`ctx.llm.registerAdapter`、`tools/post-execute` 等）工作；确定性测试不得依赖网络/真实二进制（可选真实 lane 用环境变量显式开启）。
- `.omo/`、`research/`、`dist/`、`node_modules/` 为本地证据/草稿/产物，永不提交。
- 测试统一用 `env NODE_ENV=development pnpm test`（`NODE_ENV=production` 时 pnpm 会跳过 devDependencies，导致安装不全、`pnpm list` 隐藏依赖图）。注意 `pnpm test` **不包含**下面两条独立 lane：
  - `env NODE_ENV=development pnpm test:composition`：`tests/composition/**` 启动**真实**的隔离 DSH profile 与真实子进程（经 `dsh` CLI），又慢又吃资源，混在单元套件里会互相抢资源、并把它自己的信号淹没，所以单独跑（CI 里也是独立 job，且关闭文件并行）。**覆盖率是搬家，不是丢弃**——`tests/vitest-discovery.spec.ts` 同时断言"被排除"和"有 lane 跑它"，两者缺一即红；
  - `env NODE_ENV=development pnpm test:agents:gates`：agents 的平台 Gate 探针与打包产物 lane（§15/§16）。
- 真实 headless e2e 车道**在** `pnpm test` 的发现范围内、但默认自门禁为 skipped（不作为第三条独立 lane）：用 `env NODE_ENV=development pnpm test:e2e:headless`（= `RUN_REAL_HEADLESS_E2E=1 vitest run tests/e2e`）显式开启。它需要本机具备：全局 `dsh` **0.2.1-rc.2**（与本仓依赖族一致；车道本身不钉版本，按 `PATH` 上的 `dsh` 运行，可用 `DSH_REAL_E2E_DSH_BIN` 覆盖）、`fish`、Node 22（`node` 的发现顺序是 `dsh` 同目录优先、再 PATH，可用 `DSH_REAL_E2E_NODE_BIN` 覆盖），以及两个**同级检出**——`../rtk/target/release/rtk`（rtk release 产物，如 v0.50.0）与 `../codegraph/dist/bin/codegraph.js`（codegraph 源码 v1.6.0 的 `npm ci --include=dev && npm run build` 产物）。这两个路径由 `tests/e2e/headless-real-runtime.ts` 钉死并做 realpath 校验，缺失即 fail loud。CI 里由手动触发的 `real-e2e` job（`workflow_dispatch`）自动补齐这两个二进制后跑 `pnpm test:e2e:headless`；push/PR 不跑，因为它依赖第三方下载，确定性流水线不依赖它。守卫见 `tests/vitest-discovery.spec.ts`。
- 类型检查用 `env NODE_ENV=development pnpm typecheck`：依次对 8 个插件 tsconfig 跑 `tsc -p <config> --noEmit`；它同样**不在** `pnpm test` 里（CI 的 test job 有独立步骤）。
- 发布（**唯一**入口是 `.github/workflows/release.yml` 的 `workflow_dispatch`，本机不发布）：
  - 输入 `release_sha`（40 位完整 SHA，必须在 `main` 上且等于 checkout）、`dry_run`（**默认 true**）与可选的 `prior_run_id`（上一次 dispatch 的 run id，用于跨 run 续跑）；一次 dispatch 发布**全部六个**包，不接受"只发一个"。
  - 权限只需 `contents: write`（末尾创建 6 个 annotated tag 与 6 个 GitHub Release）与 `id-token: write`（npm provenance）。认证走 npm Trusted Publishing（tokenless OIDC），不配置长期 secret；`NODE_AUTH_TOKEN` 的旁路以注释保留。**npmjs.com 上的 Trusted Publisher 必须同时允许 publish 与 dist-tag**：本 lane 的 `npm dist-tag add/rm` 也走 OIDC，只授予 publish 的配置会让 finalize 在六个版本已不可逆发布之后失败。
  - **npm CLI 版本是正确性输入**：`publish` 自 11.5.1 起支持 tokenless OIDC，但 `dist-tag add/rm` 直到 **11.21.0** 才支持（实测解包 CLI：11.20.0 的 `lib/commands/dist-tag.js` 无 OIDC，11.21.0 有；12.x 首个是 12.2.0）。workflow 固定 `RELEASE_NPM_VERSION: 11.21.0`，`preflight` 会 fail-fast 校验，低于该版本直接拒绝——否则会发完六个版本再卡在第一次 dist-tag 调用。
  - 顺序固定：全量门禁（`pnpm test` / `typecheck` / `build:agents` / `test:agents:gates`）→ `preflight`（校验 npm 能力、git identity/push remote、SHA、main、clean tree，并预查 registry 上已存在的版本；有 `prior_run_id` 时先核验并**接管**旧 journal）→ `pack`（六包只打包一次并逐包 fail-closed 校验）→ 上传 journal/artifacts（`if: always()`）→ `publish`（**仅** `dry_run: false`，串行、candidate tag `next`、`--provenance --access public`、逐包核验 registry integrity）→ `finalize`（六包全部发布成功后才把 `latest` 提升、删 candidate tag、创建 tags）→ `releases`（幂等创建 6 个 GitHub Release）。
  - workflow 有 `concurrency: release-<repo>` 且 `cancel-in-progress: false`：两次 dispatch 并发会交错 publish/promote 同一个 candidate tag，取消运行则会人为制造半发布。
  - `scripts/release/release.mjs` 是编排本体（`preflight|pack|publish|finalize|releases|report`）；`scripts/release/lib/*` 是纯函数，由 `tests/release-lane.spec.ts` 与 `tests/release-workflow.spec.ts` 覆盖。
  - **partial failure 是明确状态，不是可忽略的噪音**：npm 版本不可变，所以已发布的版本**永不重发**——`pack` 会用 tarball integrity 与 registry 对比，不同即整体中止并要求人工升版本；相同则记为 `skipped`，resume 时跳过。已上传的 journal 是唯一可信证据。`finalize` 逐包幂等（`promoted` 是真实状态，续跑只处理剩下的包），promotion 前会重新核验 registry integrity 与 candidate tag；candidate tag 删除只容忍"确实不存在"，并逐包读回验证。
  - fish-shell 必须从 **workspace 外**（OS 临时目录）的 staged 树打包（hoisted linker + `package-import-method=copy`）；放在仓库内会让 `pnpm install` 以 workspace 作用域运行并摧毁 checkout 的 `node_modules`，脚本用 `assertOutsideWorkspace` fail-closed 校验。agents 必须带 `lib/` 构建产物且其相对 import 全部在 tarball 内。这些由脚本校验，不是提醒。
- 提交信息遵循 conventional commits（`feat:`/`fix:`/`test:`/`docs:`/`ci:`/`chore:`）。
