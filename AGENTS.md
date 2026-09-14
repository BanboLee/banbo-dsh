# AGENTS.md

本仓库（banbo-dsh）是 DeepSeek Harness 的插件集合仓库（rtk、codegraph-mcp、fish-shell、lsp-diagnostics、llm-pi-ai-with-session）。对仓库的任何修改请遵守以下约定。

## 插件命名约定（强制）

所有插件包发布到 npm 时统一使用 scoped 命名空间，**延续此方案**：

```
@banbolee/dsh-<name>
```

- 本地目录路径保持 `plugins/<name>`（如 `plugins/rtk`），**目录名与路径不改**。
- `package.json` 的 `name` 字段必须为 `@banbolee/dsh-<name>`；不论名字在 npmjs 上是否被占用，一律走 `@banbolee` scope，**不得**改用其它 unscoped 名称（scoped 名称永不与他人冲突）。
- 现有五个插件（发布名）：
  - `@banbolee/dsh-rtk`
  - `@banbolee/dsh-codegraph-mcp`
  - `@banbolee/dsh-fish-shell`
  - `@banbolee/dsh-lsp-diagnostics`
  - `@banbolee/dsh-llm-pi-ai-with-session`
- 新插件一律命名为 `@banbolee/dsh-<name>`，先确认 npm 可用性再定 `<name>`。

## 新增/改名插件时的联动清单

改包名或加新插件时，以下位置必须同步，否则契约测试会挂：

1. `plugins/<name>/package.json`：`name` + `files` 字段（发布内容白名单）
2. 插件内 `cordis.patch.yml` 的 `name:` 行（= 安装后 cordis 要加载的包名）
3. 契约测试：
   - `tests/package-shape.spec.ts`：`bundleExpectations` 的 `packageName`
   - 各 `tests/docs-shape-*.spec.ts`（安装命令等契约字符串）
   - 插件自带 `tests/bundle.spec.ts`（patch 行名断言）
4. 根 `README.md`：插件总览表、卸载命令（`dsh plugin --profile <p> remove @banbolee/dsh-<name>`）
5. `scripts/qa/lib/profile.mjs`：`[插件目录, 包名]` 映射表
6. `scripts/sync-to-profile.sh`：fish 部署路径 `profiles/node_modules/@banbolee/dsh-fish-shell`
7. `pnpm-lock.yaml`：改名后执行 `pnpm install` 重新生成
8. 测试中的 `pnpm list --filter @banbolee/dsh-<name>` 与断言字符串

## 其它约定

- 依赖族固定在 `@deepseek-ai/* ^0.1.5-rc.1`（与 dsh 0.1.5-rc.1 对齐）；升级依赖族时同步更新测试断言与文档。
- 插件核心约束：不修改 deepseek-harness 内核、不 monkey-patch 官方对象、只通过公开扩展点（`ctx.llm.registerAdapter`、`tools/post-execute` 等）工作；确定性测试不得依赖网络/真实二进制（可选真实 lane 用环境变量显式开启）。
- `.omo/`、`research/`、`dist/`、`node_modules/` 为本地证据/草稿/产物，永不提交。
- 测试统一用 `env NODE_ENV=development pnpm test`（`NODE_ENV=production` 时 pnpm 会跳过 devDependencies，导致安装不全、`pnpm list` 隐藏依赖图）。
- 提交信息遵循 conventional commits（`feat:`/`fix:`/`test:`/`docs:`/`ci:`/`chore:`）。
