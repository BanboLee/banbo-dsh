# banbo-dsh

Local DeepSeek Harness profile bundles for this checkout.

## Install RTK, CodeGraph MCP, and session wrapper bundles

Install either bundle into a DSH profile from the repository root:

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
```

`dsh-llm-pi-ai-with-session` 是 `llm-pi-ai` 的一个通用 session wrapper：注册一个
LLM provider 路由（默认 `pi-ai-session`），复用 pi-ai 的 openai-completions 实现并在
每次请求里带上可配置的会话 header（默认 `x-session-id`）；
见 [plugins/dsh-llm-pi-ai-with-session/README.md](plugins/dsh-llm-pi-ai-with-session/README.md)。

To install both local bundles in one command while keeping profile state
explicit, use:

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <profile>
```

The sync helper requires `DSH_HOME` so tests and manual QA can target isolated
profile state instead of the user's default Harness home.

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
