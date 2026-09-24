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
5. `scripts/qa/lib/profile.mjs`：`[插件目录, 包名]` 映射表
6. `scripts/sync-to-profile.sh`：fish 部署路径 `profiles/node_modules/@banbolee/dsh-fish-shell`
7. `pnpm-lock.yaml`：改名后执行 `pnpm install` 重新生成
8. 测试中的 `pnpm list --filter @banbolee/dsh-<name>` 与断言字符串

## 其它约定

- 依赖族固定在 `@deepseek-ai/* ^0.1.5-rc.2`（与 dsh 0.1.5-rc.2 对齐）；升级依赖族时同步更新测试断言与文档。
- 插件核心约束：不修改 deepseek-harness 内核、不 monkey-patch 官方对象、只通过公开扩展点（`ctx.llm.registerAdapter`、`tools/post-execute` 等）工作；确定性测试不得依赖网络/真实二进制（可选真实 lane 用环境变量显式开启）。
- `.omo/`、`research/`、`dist/`、`node_modules/` 为本地证据/草稿/产物，永不提交。
- 测试统一用 `env NODE_ENV=development pnpm test`（`NODE_ENV=production` 时 pnpm 会跳过 devDependencies，导致安装不全、`pnpm list` 隐藏依赖图）。
- 提交信息遵循 conventional commits（`feat:`/`fix:`/`test:`/`docs:`/`ci:`/`chore:`）。
