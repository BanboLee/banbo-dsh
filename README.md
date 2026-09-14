# banbo-dsh

[![CI](https://img.shields.io/github/actions/workflow/status/BanboLee/banbo-dsh/ci.yml?label=CI&logo=github)](https://github.com/BanboLee/banbo-dsh/actions/workflows/ci.yml)

Local DeepSeek Harness profile bundles for this checkout: a curated set of
DSH plugin bundles (rtk, codegraph-mcp, fish-shell, lsp-diagnostics,
llm-pi-ai-with-session) with a deterministic test harness. MIT licensed.

## Prerequisites

| Requirement | Version | Needed by |
| --- | --- | --- |
| Node.js | >= 22 | all bundles (tests, runtime) |
| pnpm | 9.x (pinned via `packageManager: pnpm@9.3.0`) | installs and tests |
| `dsh` (DeepSeek Harness) | `0.1.5-rc.1` family (`@deepseek-ai/*` `^0.1.5-rc.1`) | all bundles |
| `rtk` CLI | any current release | `dsh-rtk` — **must be pre-installed** or rewrites/grep-compression fail open to passthrough |
| `codegraph` CLI | any current release | `dsh-codegraph-mcp` — **must be pre-installed** or the MCP bridge has no server |
| fish | any current release | `dsh-fish-shell` executors and tool |
| LSP servers | see plugin README | `dsh-lsp-diagnostics` (defaults: `typescript-language-server`, `gopls`; opt-in: `clangd`, `rust-analyzer`, `pyright-langserver`) |

`rtk`, `codegraph`, and the LSP servers are never downloaded or installed by
the bundles: install the executables yourself and make sure they are on
`PATH` (or pinned through the bundle config). A missing binary never blocks
install or tests — the affected feature fails open.

## Bundles

| Bundle | What it does | Binary it needs |
| --- | --- | --- |
| [`dsh-rtk`](plugins/rtk/README.md) | Decorates the mounted shell executor: every command is rewritten through the `rtk rewrite` oracle, and model-facing `grep` output is compressed via `rtk pipe` | `rtk` |
| [`dsh-codegraph-mcp`](plugins/codegraph-mcp/README.md) | Adds an `mcp-codegraph` row that serves the CodeGraph MCP server over stdio through the official DSH bridge, plus agent-instructions install helper | `codegraph` |
| [`dsh-fish-shell`](plugins/fish-shell/README.md) | Fish executors (sandboxed and local) plus a model-facing `fish` tool and a fish agent preset | fish |
| [`dsh-lsp-diagnostics`](plugins/dsh-lsp-diagnostics/README.md) | After `write`/`edit`/`str_replace_editor` mutations, appends a persistent LSP diagnostics notice to the next model inference; also registers a model-callable `lsp_diagnostics(file_path)` tool | `typescript-language-server`, `gopls` (+ opt-in servers) |
| [`dsh-llm-pi-ai-with-session`](plugins/dsh-llm-pi-ai-with-session/README.md) | Generic session wrapper over `llm-pi-ai`: registers explicit session provider routes that carry a dynamic session id header (default `x-session-id`) on every LLM request | none (reuses `llm-pi-ai` providers) |

`dsh-llm-pi-ai-with-session` 是 `llm-pi-ai` 的一个通用 session wrapper：按配置显式注册
session provider 路由，复用 pi-ai 的 openai-completions 实现并在每次请求里带上
可配置的会话 header（默认 `x-session-id`）；
见 [plugins/dsh-llm-pi-ai-with-session/README.md](plugins/dsh-llm-pi-ai-with-session/README.md)。

## Install

Install any bundle into a DSH profile from the repository root. The
workspace-root flag `-w` is required for the four `-w` bundles below: without
it, pnpm cannot resolve the local package inside the profile's generated
workspace and install fails with `ERR_PNPM_ADDING_TO_ROOT`.

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
dsh plugin --profile <profile> add ./plugins/fish-shell
```

(`dsh-fish-shell` is the exception: no `-w`; it uses its own deploy-and-symlink
story documented in its README.)

To install several bundles into one isolated profile with a single command,
the sync helpers keep profile state explicit and require `DSH_HOME` so tests
and manual QA target isolated state instead of the user's default Harness
home:

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <profile>
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
scripts/sync-to-profile.sh            # fish-shell: copy the plugin into the profile tree
scripts/install-codegraph-instructions.sh   # codegraph: marker-fenced block into AGENTS.md
```

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-rtk
dsh plugin --profile <profile> remove dsh-codegraph-mcp
dsh plugin --profile <profile> remove dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> remove dsh-lsp-diagnostics
dsh plugin --profile <profile> remove dsh-fish-shell
```

## Testing

Run the deterministic suite (fixture servers only; no network, no real
binaries):

```sh
env NODE_ENV=development pnpm test
```

`NODE_ENV=development` matters: with `NODE_ENV=production` pnpm skips
devDependencies entirely, which breaks installs and the dependency-graph
assertions. Per-bundle verification commands are documented in each plugin
README.

## Real headless E2E

Build the sibling RTK release binary and CodeGraph distribution, then run the
opt-in real profile suite:

```sh
(cd ../rtk && cargo build --release)
(cd ../codegraph && npm run build)
corepack pnpm test:e2e:headless
```

The command requires Node 22, `dsh`, and fish, installs all three local bundles
into an isolated profile, and fails loudly when a prerequisite is unavailable.
Override the DSH and Node executable locations with `DSH_REAL_E2E_DSH_BIN` and
`DSH_REAL_E2E_NODE_BIN`. `DSH_REAL_E2E_RTK_BIN` and
`DSH_REAL_E2E_CODEGRAPH_BIN` may point through alternate paths or symlinks, but
must resolve to this workspace's sibling RTK and CodeGraph build artifacts; the
suite rejects unrelated compatible binaries.

If the ambient `node` is not Node 22, pin the DSH and Node 22 executables:

```sh
PATH=/path/to/node-22/bin:$PATH \
DSH_REAL_E2E_DSH_BIN=/path/to/node-22/bin/dsh \
DSH_REAL_E2E_NODE_BIN=/path/to/node-22/bin/node \
corepack pnpm test:e2e:headless
```

## License

MIT — see [LICENSE](LICENSE).
