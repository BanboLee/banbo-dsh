# banbo-dsh

[![CI](https://img.shields.io/github/actions/workflow/status/BanboLee/banbo-dsh/ci.yml?label=CI&logo=github)](https://github.com/BanboLee/banbo-dsh/actions/workflows/ci.yml)

[中文](./README.md) | **English**

A collection of DeepSeek Harness (DSH) plugins: five ready-to-use bundles published
on npm under `@banbolee/dsh-*`, installable into any DSH profile with a single
command — no need to clone this repository. MIT licensed.

## Quick install (users)

Prerequisites: `dsh` (0.1.5-rc.1 family), Node.js >= 22, pnpm 9.x.

Install whichever bundles you need:

```sh
dsh plugin --profile <profile> add @banbolee/dsh-rtk
dsh plugin --profile <profile> add @banbolee/dsh-codegraph-mcp
dsh plugin --profile <profile> add @banbolee/dsh-fish-shell
dsh plugin --profile <profile> add @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> add @banbolee/dsh-llm-pi-ai-with-session
```

## Bundles

| Bundle | What it does | Binary it needs |
| --- | --- | --- |
| [`@banbolee/dsh-rtk`](plugins/rtk/README.md) | Decorates the mounted shell executor: every command is rewritten through the `rtk rewrite` oracle, and model-facing `grep` output is compressed via `rtk pipe` | `rtk` |
| [`@banbolee/dsh-codegraph-mcp`](plugins/codegraph-mcp/README.md) | Adds an `mcp-codegraph` row that serves the CodeGraph MCP server over stdio through the official DSH bridge, plus an agent-instructions install helper | `codegraph` |
| [`@banbolee/dsh-fish-shell`](plugins/fish-shell/README.md) | Fish executors (sandboxed and local) plus a model-facing `fish` tool and a per-agent policy that swaps bash for fish under any agent preset | fish |
| [`@banbolee/dsh-lsp-diagnostics`](plugins/dsh-lsp-diagnostics/README.md) | After `write`/`edit`/`str_replace_editor` mutations, appends a persistent LSP diagnostics notice to the next model inference; also registers a model-callable `lsp_diagnostics(file_path)` tool | `typescript-language-server`, `gopls` (opt-in: `clangd`, `rust-analyzer`, `pyright-langserver`) |
| [`@banbolee/dsh-llm-pi-ai-with-session`](plugins/dsh-llm-pi-ai-with-session/README.md) | Generic session wrapper over `llm-pi-ai`: registers explicit session provider routes that carry a dynamic session id header (default `x-session-id`) on every LLM request | none (reuses `llm-pi-ai` providers) |

See each plugin README for full details.

## External dependencies (important — read before installing)

`rtk`, `codegraph`, fish, and the LSP servers must be **pre-installed by you**;
the bundles never download or install them:

| Binary | Used by |
| --- | --- |
| `rtk` | `@banbolee/dsh-rtk` — **must be pre-installed** or rewrites/grep-compression fail open to passthrough |
| `codegraph` | `@banbolee/dsh-codegraph-mcp` — **must be pre-installed** or the MCP bridge has no server and no `mcp__codegraph__*` tools |
| fish | `@banbolee/dsh-fish-shell` executors and tool |
| `typescript-language-server`, `gopls` (opt-in: `clangd`, `rust-analyzer`, `pyright-langserver`) | `@banbolee/dsh-lsp-diagnostics` automatic diagnostics |

Put the binaries on `PATH` (or pin them through the bundle config). A missing
binary never blocks install or tests — the affected feature fails open.

## Uninstall

```sh
dsh plugin --profile <profile> remove @banbolee/dsh-rtk
dsh plugin --profile <profile> remove @banbolee/dsh-codegraph-mcp
dsh plugin --profile <profile> remove @banbolee/dsh-fish-shell
dsh plugin --profile <profile> remove @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> remove @banbolee/dsh-llm-pi-ai-with-session
```

## Local development / install from source (contributors)

```sh
git clone git@github.com:BanboLee/banbo-dsh.git
cd banbo-dsh
env NODE_ENV=development pnpm install
```

Install into a profile from the repository root (the `-w` flag is required for
the local path installs below, otherwise pnpm fails with
`ERR_PNPM_ADDING_TO_ROOT`; `@banbolee/dsh-fish-shell` is the exception — no `-w`,
it has its own deploy-and-symlink story documented in its README):

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
dsh plugin --profile <profile> add ./plugins/fish-shell
```

Sync helpers for isolated profiles (they require `DSH_HOME` to point at
isolated state):

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <profile>
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
scripts/sync-to-profile.sh            # fish-shell: copy the plugin into the profile tree
```

### Testing

```sh
env NODE_ENV=development pnpm test
```

`NODE_ENV=development` matters: with `NODE_ENV=production` pnpm skips
devDependencies entirely, which breaks installs and the dependency-graph
assertions. Per-bundle verification commands are documented in each plugin
README.

### Real headless E2E (optional)

Build the sibling RTK release binary and CodeGraph distribution, then run the
opt-in real profile suite:

```sh
(cd ../rtk && cargo build --release)
(cd ../codegraph && npm run build)
corepack pnpm test:e2e:headless
```

Requires Node 22, `dsh`, and fish. Override executable locations with
`DSH_REAL_E2E_DSH_BIN`, `DSH_REAL_E2E_NODE_BIN`, `DSH_REAL_E2E_RTK_BIN`, and
`DSH_REAL_E2E_CODEGRAPH_BIN`.

## License

MIT — see [LICENSE](LICENSE).
