# dsh-tui Real-Run Test Plan

## Purpose

This is the mandatory regression plan for any change to:

- an `@deepseek-ai/dsh-*` or `@deepseek-ai/cordis` dependency;
- `@deepseek-harness-tui/dsh-tui`;
- a local bundle, its `cordis.patch.yml`, or its profile synchronization;
- local profile configuration that changes a bundle's runtime behavior.

The test profile is `dsh-tui`. The plan exercises the real `dsh` Loader, the
actual profile dependency graph, and the installed local bundles. Unit tests
are necessary but do not replace this plan.

The bundles in scope are:

| Bundle | Runtime role |
| --- | --- |
| `dsh-fish-shell` | Replaces the Bash shell provider and exposes the `fish` tool. |
| `dsh-rtk` | Decorates the active shell's `run` and `start` methods with `rtk rewrite`; optionally compresses grep results. |
| `dsh-codegraph-mcp` | Registers the CodeGraph MCP server through the official MCP client. |
| `dsh-llm-pi-ai-with-session` | Adds session-affinity LLM provider routes and request headers. |
| `dsh-lsp-diagnostics` | Adds bounded post-write TypeScript/TSX/Go diagnostics. |

## Required QA Harness Deliverables

G4-G6 are blocked until these checked-in files exist. This plan is not a
release gate until their tests pass:

| Path | Command | Required behavior |
| --- | --- | --- |
| `docs/dsh-tui-qa-version-matrix.json` | Input to every QA script | Declares `dsh`, `dsh-tui`, `cordis`, `pi-ai`, Node major, and all five bundle versions. |
| `scripts/qa/validate-dsh-tui-graph.mjs` | `"$QA_NODE" scripts/qa/validate-dsh-tui-graph.mjs --profile dsh-tui --matrix docs/dsh-tui-qa-version-matrix.json` | Reads `dsh plugin --profile dsh-tui list --depth=8 --json`; rejects missing bundles, target-version mismatch, and incompatible duplicate DSH/Cordis/pi-ai families. |
| `scripts/qa/run-dsh-tui-pty.mjs` | `"$QA_NODE" scripts/qa/run-dsh-tui-pty.mjs --case startup --env-file "$QA_ROOT/env.json"` | Starts the QA-local TUI through its QA-local dsh wrapper, waits for input, issues `/exit`, and enforces PID cleanup. |
| `scripts/qa/run-dsh-tui-real.mjs` | `"$QA_NODE" scripts/qa/run-dsh-tui-real.mjs --all-core --env-file "$QA_ROOT/env.json"` | Starts the loopback SSE fixture and executes every Core ID through named scenarios; exits nonzero when any case is missing, skipped, or fails. |
| `scripts/qa/fixtures/loopback-openai-sse.mjs` | Started by `run-dsh-tui-real.mjs` | Emits scripted SSE sequences and records only sanitized header presence, opaque identity equality, selected tool names, and terminal status. |
| `scripts/qa/fixtures/dsh-tui-qa-settings.yaml` | Copied into `QA_DSH_HOME/settings.yaml` | Defines only the loopback provider, session route, model, and QA credential variable. |
| `scripts/qa/fixtures/dsh-tui-qa.patch.yml` | Copied into the QA profile | Defines only local CodeGraph, local LSP, explicit preset rows, and no external MCP entries. |
| `scripts/qa/run-dsh-tui-upgrade.mjs` | `"$QA_NODE" scripts/qa/run-dsh-tui-upgrade.mjs --gates G4,G5,G6 --qa-root "$QA_ROOT" --matrix docs/dsh-tui-qa-version-matrix.json` | Allocates the loopback port, writes `env.json`, renders templates, runs graph/config validation and PTY startup, executes all Core scenarios, and reaps every owned child. |

The version matrix schema is:

```json
{
  "nodeMajor": 26,
  "dsh": "0.1.2-rc.1",
  "dshTui": "0.10.0-beta.5",
  "cordis": "4.0.2",
  "piAi": "0.84.4",
  "bundles": {
    "dsh-fish-shell": "0.4.0",
    "dsh-rtk": "0.1.0",
    "dsh-codegraph-mcp": "0.1.0",
    "dsh-llm-pi-ai-with-session": "0.1.0",
    "dsh-lsp-diagnostics": "0.1.0"
  }
}
```

`piAi` is the exact version that `pnpm-lock.yaml` resolves for the
`dsh-llm-pi-ai-with-session` importer (its declared range is `^0.84.2`, which
resolves to `0.84.4`). The graph validator enforces this exact version; a range
base is never an acceptable matrix value.

`run-dsh-tui-upgrade.mjs` is the only operator entrypoint for G4-G6:

```sh
"$QA_NODE" scripts/qa/run-dsh-tui-upgrade.mjs \
  --gates G4,G5,G6 \
  --qa-root "$(mktemp -d)" \
  --matrix docs/dsh-tui-qa-version-matrix.json
```

It validates that the supplied QA root is isolated, records it in the evidence
record, allocates the loopback port, writes `env.json`, creates the Node 26 dsh
wrapper, packs every local bundle, installs the target TUI and packed bundles,
renders QA settings and patch files, invokes graph/config validation and the
PTY driver, executes all Core IDs, and reaps every owned child. It passes every
child an environment reconstructed solely from `env.json`.

## Preconditions

Run all commands from the repository root:

```sh
cd /data00/home/lixingxin/project/banbo-dsh
```

Record the following before changing dependencies:

```sh
node --version
dsh --version
dsh-tui version
dsh-tui doctor
pnpm --version
pnpm list --filter dsh-fish-shell --depth=8
```

Expected baseline:

- Node meets every upgraded package's `engines` requirement.
- `dsh-tui doctor` reports aligned launcher and profile versions.
- `dsh --version` matches the intended Harness line.
- The fish-shell graph contains one coherent Harness family. For the current
  RC.1 line, every `@deepseek-ai/dsh-*` package reported by the graph test is
  `0.1.2-rc.1`.

Set the target before every run. Do not rely on `latest`:

```sh
export TARGET_DSH_VERSION=0.1.2-rc.1
export TARGET_TUI_VERSION=0.10.0-beta.5
export QA_NODE=/home/lixingxin/.local/share/nvm/v26.7.0/bin/node
export QA_DSH=/home/lixingxin/.local/share/nvm/v26.7.0/bin/dsh
export QA_PNPM=/home/lixingxin/.local/share/pnpm/pnpm
"$QA_NODE" --version
"$QA_DSH" --version
"$QA_PNPM" --version
```

All new QA drivers run on Node 26. The current legacy
`test:e2e:headless` suite has a Node 22 assumption and is not an upgrade gate
until it is migrated to Node 26. After that migration it must use the same
Node 26 runtime and target `dsh`:

```sh
PATH=/home/lixingxin/.local/share/nvm/v26.7.0/bin:$PATH \
DSH_REAL_E2E_DSH_BIN="$QA_DSH" \
DSH_REAL_E2E_NODE_BIN="$QA_NODE" \
"$QA_PNPM" test:e2e:headless
```

Preflight must fail unless `"$QA_NODE" --version` begins with `v26.` and
`"$QA_DSH" --version` equals `"$TARGET_DSH_VERSION"`.

Build the sibling RTK artifact:

```sh
(cd ../rtk && cargo build --release)
```

The legacy source-based `test:e2e:headless` suite still expects a sibling
CodeGraph build and cannot be used until its Node 22/source assumptions are
migrated. New Node 26 QA uses the official bundled CLI:

```sh
export QA_CODEGRAPH=/home/lixingxin/.codegraph/versions/v1.6.0/bin/codegraph
test -x "$QA_CODEGRAPH"
"$QA_CODEGRAPH" --version
```

`QA_CODEGRAPH` must resolve under `~/.codegraph/versions/`, not under the
sibling source checkout. The official CLI bundles its supported Node runtime;
do not execute `../codegraph/dist/bin/codegraph.js` with Node 26.

Do not use production credentials. The plan uses a loopback gateway fixture,
local CodeGraph, and local LSP servers. Never inherit `C4C_user_code`,
`C7_API_KEY`, `FIGMA_API_KEY`, `DEEPSEEK_API_KEY`, or user profile MCP rows.

## Upgrade Sequence

Run these gates in order. Stop at the first failure. A later gate never
compensates for an earlier failure.

| Gate | Goal | Command / activity | Required evidence |
| --- | --- | --- | --- |
| G0 | Manifest and lockfile consistency | `pnpm install --frozen-lockfile` | No resolution or lockfile mutation. |
| G1 | Local deterministic regression | `pnpm exec vitest run` | `524 passed` or the current suite's expected equivalent; explain skips. |
| G2 | Workspace dependency graph | `pnpm exec vitest run tests/fish-shell-dependency-graph.spec.ts` | The test proves no mixed old sandbox/new LLM tree. |
| G3 | Real isolated Loader composition | `pnpm exec vitest run tests/composition/fish-rtk-coexist.spec.ts tests/composition/rtk-codegraph-profile.spec.ts tests/composition/lsp-diagnostics.spec.ts` | Real profiles boot through `dsh-app-boot`; no loader import failure. |
| G4 | Create isolated dsh-tui QA profile | Use `QA_DSH_HOME`, `QA_HOME`, target TUI package, and the five-bundle install below. | Profile-local graph validator accepts all target versions. |
| G5 | Real interactive startup and clean exit | Start the isolated TUI with a PTY, wait for input, issue `/exit`, and reap the process group. | Input screen appears; status is zero; no owned TUI/MCP/LSP process remains. |
| G6 | Deterministic real-run matrix | Drive the isolated TUI through the loopback gateway fixture and Loader driver. | Every required Core ID has a fixture, expected observable result, and sanitized evidence. |

For an upgraded pre-release, G0-G5 are mandatory even when the package manager
reports no manifest conflict. Pre-release peer ranges can resolve to a valid
but incompatible graph.

`dsh-llm-pi-ai-with-session` and the dsh-tui visual surface do not currently
have equivalent automated real-profile coverage. Their G6 cases are mandatory
for every dependency-family, dsh-tui, or pi-ai upgrade.

## Isolated dsh-tui QA Profile

Never use the user's normal profile as a test target. The following is
orchestrator implementation pseudocode, not a standalone gate:

```sh
export QA_ROOT="$(mktemp -d)"
export QA_HOME="$QA_ROOT/home"
export QA_DSH_HOME="$QA_ROOT/dsh-home"
export QA_SESSION_ROOT="$QA_ROOT/sessions"
export QA_WORKSPACE="$QA_ROOT/workspace"
mkdir -p "$QA_HOME" "$QA_DSH_HOME" "$QA_SESSION_ROOT" "$QA_WORKSPACE"
mkdir -p "$QA_ROOT/bin" "$QA_ROOT/packs"

cat >"$QA_ROOT/bin/dsh" <<EOF
#!/usr/bin/env sh
exec "$QA_NODE" "$QA_DSH" "\$@"
EOF
chmod +x "$QA_ROOT/bin/dsh"
export QA_DSH_WRAPPER="$QA_ROOT/bin/dsh"

for bundle in \
  plugins/fish-shell \
  plugins/rtk \
  plugins/codegraph-mcp \
  plugins/dsh-llm-pi-ai-with-session \
  plugins/dsh-lsp-diagnostics
do
  "$QA_PNPM" --dir "$bundle" pack --pack-destination "$QA_ROOT/packs"
done

env -i \
  HOME="$QA_HOME" \
  PATH="/home/lixingxin/.local/share/nvm/v26.7.0/bin:/usr/local/bin:/usr/bin:/bin" \
  DSH_HOME="$QA_DSH_HOME" \
  DSH_TUI_SESSION_ROOT="$QA_SESSION_ROOT" \
  DSH_TELEMETRY_MODE=DISABLED \
  DO_NOT_TRACK=1 \
  CODEGRAPH_NO_UPDATE_CHECK=1 \
  "$QA_DSH_WRAPPER" plugin --profile dsh-tui add -w \
  "@deepseek-harness-tui/dsh-tui@$TARGET_TUI_VERSION" \
  "$QA_ROOT"/packs/dsh-fish-shell-0.4.0.tgz \
  "$QA_ROOT"/packs/dsh-rtk-0.1.0.tgz \
  "$QA_ROOT"/packs/dsh-codegraph-mcp-0.1.0.tgz \
  "$QA_ROOT"/packs/dsh-llm-pi-ai-with-session-0.1.0.tgz \
  "$QA_ROOT"/packs/dsh-lsp-diagnostics-0.1.0.tgz
```

Generate a QA-only `cordis.patch.yml` and settings file after the install. They
must contain only:

- a loopback OpenAI-SSE gateway fixture and its disposable credential;
- the official bundled CodeGraph CLI;
- local TypeScript and Go language server paths;
- the test workspace and no external MCP rows.

The runner binds the loopback gateway on `127.0.0.1:0`, writes the selected
port to `$QA_ROOT/env.json`, renders the templates below, and launches every
child from that file alone. It never spreads `process.env`.

The rendered QA settings file must select the route explicitly:

```yaml
llm-pi-ai:
  providers:
    qa-loopback:
      api: openai-completions
      baseURL: http://127.0.0.1:<rendered-loopback-port>/v1
      apiKeyEnv: QA_LOOPBACK_API_KEY
      models:
        - id: qa-model
          contextWindow: 32768
          maxTokens: 4096
agent-default-model:
  provider: qa-session
  model: qa-model
```

The rendered QA profile patch must bind `qa-session` to `qa-loopback`, use the
configured session header, and have no fallback provider:

```yaml
- id: llm-pi-ai-with-session
  config:
    sessionHeader: x-session-affinity
    routes:
      - route: qa-session
        source: qa-loopback
        displayName: QA Session
- id: mcp-codegraph
  config:
    serverName: codegraph
    transport: stdio
    command: <rendered-QA_CODEGRAPH>
    args: [serve, --mcp, --path, <rendered-qa-workspace>]
    env:
      CODEGRAPH_NO_DAEMON: "1"
      CODEGRAPH_NO_UPDATE_CHECK: "1"
    cwd: <rendered-qa-workspace>
    failOnStartupError: true
    reconnect:
      enabled: false
      initialDelayMs: 10
      maxDelayMs: 10
      maxAttempts: 1
- id: lsp-diagnostics
  config:
    enabled: true
    servers:
      typescript:
        command: <rendered-QA_TS_LSP>
        args: [--stdio]
        env: {}
      go:
        command: <rendered-QA_GOPLS>
        args: []
        env: {}
- id: rtk
  config:
    rtkBinary: <rendered-QA_RTK>
```

Do not override `dsh-tui-agent-presets`: its whole-config replacement would
discard the fish bundle's preset roots. The startup-failure scenario renders an
otherwise identical patch and changes only `mcp-codegraph.config.command` to a
missing QA path. It must fail during Loader boot, then discard the whole QA
profile and recreate it before any later scenario.

The profile-graph validator is a required checked-in helper to add before this
plan is made mandatory. It runs:

```sh
"$QA_DSH_WRAPPER" plugin --profile dsh-tui list --depth=8 --json
```

It rejects any resolved version outside the declared matrix for:

- `@deepseek-ai/dsh-*`;
- `@deepseek-ai/cordis`;
- `@earendil-works/pi-ai`;
- `@deepseek-harness-tui/dsh-tui`.

It also resolves every target package and every `@deepseek-ai/*` import from
the installed bundle realpath. It rejects a bundle realpath outside
`$QA_DSH_HOME` or an import that resolves through this repository's
`node_modules`.

Then run:

```sh
env -i \
  HOME="$QA_HOME" \
  PATH="$QA_ROOT/bin:/home/lixingxin/.local/share/nvm/v26.7.0/bin:/usr/local/bin:/usr/bin:/bin" \
  DSH_HOME="$QA_DSH_HOME" \
  DSH_TUI_SESSION_ROOT="$QA_SESSION_ROOT" \
  DSH_TUI_WORKSPACE_TARGET="$QA_WORKSPACE" \
  DSH_TELEMETRY_MODE=DISABLED \
  DO_NOT_TRACK=1 \
  CODEGRAPH_NO_UPDATE_CHECK=1 \
  QA_LOOPBACK_API_KEY=qa-only-token \
  "$QA_DSH_WRAPPER" --profile dsh-tui --dump-config
```

The output must contain `fish-shell`, `tool-fish`, `rtk`, `mcp-codegraph`,
`llm-pi-ai-with-session`, and `lsp-diagnostics`. The fish patch must target
the current TUI row `dsh-tui-agent-presets`; a missing patch entry is a failure.

Every G4-G6 command must be launched through the same `env -i` whitelist shown
above. The QA driver writes that whitelist to `$QA_ROOT/env.json` and rejects
ambient `C4C_user_code`, `C7_API_KEY`, `FIGMA_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENAI_API_KEY`, proxy credentials, and user profile paths. It uses
`DSH_TUI_WORKSPACE_TARGET="$QA_WORKSPACE"` for every PTY launch.

Existing sync and smoke helpers are useful narrow checks, but they do not
replace the isolated five-bundle QA profile:

| Helper | Scope |
| --- | --- |
| `scripts/sync-to-profile.sh` | Fish deployment copy and preset drift warning. |
| `scripts/sync-rtk-codegraph-to-profile.sh <profile>` | RTK and CodeGraph installation into an explicit `DSH_HOME`. |
| `scripts/sync-lsp-diagnostics-to-profile.sh <profile>` | LSP bundle installation into an explicit `DSH_HOME`. |
| `scripts/smoke-rtk.sh` | RTK command smoke. |
| `scripts/smoke-codegraph-mcp.sh` | CodeGraph MCP startup smoke. |

## G5 Startup Smoke Test

Use a PTY driver, not `timeout script`. The driver is a required checked-in
fixture to add before this plan is mandatory. It must:

1. start `dsh-tui` in a new process group with `HOME`, `DSH_HOME`,
   `DSH_TUI_SESSION_ROOT`, and `QA_WORKSPACE` from the isolated QA profile;
2. wait for the input prompt with a bounded deadline;
3. record the TUI process and every child PID it starts;
4. type `/exit` and wait for status zero;
5. require every recorded TUI, MCP, and LSP child to be gone;
6. if normal exit misses the deadline, send TERM to the whole process group,
   then KILL after a second bounded grace period, and mark the case failed.

The PTY child command is exactly:

```sh
"$QA_NODE" \
  "$QA_DSH_HOME/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js"
```

Before G5, the orchestrator requires:

```sh
test "$("$QA_DSH_WRAPPER" --version)" = "$TARGET_DSH_VERSION"
test "$("$QA_NODE" -p \
  "require('$QA_DSH_HOME/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json').version")" \
  = "$TARGET_TUI_VERSION"
```

Pass criteria:

1. The TUI renders its initial input screen.
2. It does not report an ESM named-export failure, especially `assertNever`.
3. It does not report an unresolved package, Loader entry failure, or inactive
   required service.
4. `/exit` is the normal successful completion path. A watchdog cleanup is
   evidence of a failure, not success.

Keep only sanitized status, version, and PID-cleanup results. Remove raw PTY
transcripts because they can contain workspace or environment details.

## Deterministic G6 Drivers

Before declaring this plan operational, add these checked-in QA fixtures:

| Driver | Required purpose |
| --- | --- |
| Loopback OpenAI-SSE gateway | Emits scripted text, tool-call, tool-result continuation, malformed chunk, and interrupted-stream cases; records sanitized header-presence and session-identity equality booleans. |
| dsh-tui PTY driver | Implements G5 and sends scripted slash commands without depending on a model. |
| Full-profile graph validator | Parses `dsh plugin --profile dsh-tui list --depth=8 --json` and validates the exact dependency matrix. |
| Loader driver | Boots the QA profile through the real Loader and exposes `ctx.shell.start`, tool catalog, and plugin disposal for cases that the model-facing TUI cannot invoke directly. |
| Local server fixtures | Provides deterministic CodeGraph MCP, RTK, TypeScript/Go LSP, and workspace fixture behavior. |

Every Core ID below must name one of these drivers or an existing exact test
command. A model prompt is never a test driver.

The runner writes this complete environment file after allocating the loopback
port and renders all placeholders before any profile process starts:

```json
{
  "HOME": "<qa-home>",
  "PATH": "<qa-bin>:<node26-bin>:/home/lixingxin/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "DSH_HOME": "<qa-dsh-home>",
  "DSH_TUI_SESSION_ROOT": "<qa-session-root>",
  "DSH_TUI_WORKSPACE_TARGET": "<qa-workspace>",
  "DSH_TELEMETRY_MODE": "DISABLED",
  "DO_NOT_TRACK": "1",
  "CODEGRAPH_NO_UPDATE_CHECK": "1",
  "QA_LOOPBACK_API_KEY": "qa-only-token",
  "QA_LOOPBACK_PORT": "<allocated-port>",
  "QA_RTK": "/data00/home/lixingxin/project/rtk/target/release/rtk",
  "QA_CODEGRAPH": "/home/lixingxin/.codegraph/versions/v1.6.0/bin/codegraph",
  "QA_TS_LSP": "/data00/home/lixingxin/.local/share/nvim/mason/bin/typescript-language-server",
  "QA_GOPLS": "/data00/home/lixingxin/.local/bin/trae-gopls"
}
```

Before rendering the QA patch, the orchestrator requires `QA_RTK`,
`QA_CODEGRAPH`, `QA_TS_LSP`, and `QA_GOPLS` to exist and be executable.
`QA_CODEGRAPH` must resolve below `~/.codegraph/versions/`; it must not resolve
to the sibling source build.

`run-dsh-tui-real.mjs --all-core` must execute these scenario names:

```text
fish-provider
fish-catalog
fish-syntax
profile-graph
profile-dump
profile-loader
rtk-run
rtk-start
rtk-deny
rtk-grep
codegraph-read
codegraph-registration
codegraph-missing-command
codegraph-cleanup
llm-route
llm-affinity
llm-stream
lsp-ts-error
lsp-ts-clean
lsp-tsx-go
lsp-editor-actions
lsp-run-code
tui-preset
tui-preset-baseline
tui-preset-persistence
tui-persistence
tui-resume
tui-turn
tui-affinity
tui-privacy
tui-exit
```

The authoritative acceptance set is the individual Plan IDs, not this scenario
list. The runner emits one sanitized result for every mandatory ID and fails on
any missing, skipped, duplicate, or unknown ID:

```text
SH-01 SH-02 SH-03
FISH-01 FISH-02 FISH-03 FISH-04
RTK-01 RTK-02 RTK-03 RTK-04
CG-01 CG-02 CG-03
LLM-01 LLM-02 LLM-03
LSP-01 LSP-02 LSP-03 LSP-04 LSP-05
TUI-01 TUI-02 TUI-03 TUI-04 TUI-05 TUI-06 TUI-07 TUI-08
```

The loopback gateway may
record `headerPresent`, `sameSessionEqual`, `differentSessionDifferent`,
`toolName`, `resultKind`, and `processCleanup`; it must not write raw tokens,
headers, prompts, or session IDs.

| Plan IDs | Runner scenario | Preset / execution mode |
| --- | --- | --- |
| SH-01, SH-02, SH-03 | `profile-graph`, `profile-dump`, `profile-loader` | Fresh `fish` QA profile. |
| FISH-01 through FISH-04 | `fish-provider`, `fish-catalog`, `fish-syntax`, `tui-preset` | `fish`. |
| RTK-01 through RTK-04 | `rtk-run`, `rtk-start`, `rtk-deny`, `rtk-grep` | `fish`; `rtk-start` uses the Loader driver rather than a model-facing tool. |
| CG-01 | `codegraph-registration` | `fish`; one MCP namespace and process registration. |
| CG-02 | `codegraph-read` | `fish`; real read against the local indexed fixture. |
| CG-03 | `codegraph-missing-command` | Missing-command uses a recreated QA profile and fails at Loader boot. |
| TUI-08 | `codegraph-cleanup`, `tui-exit` | CodeGraph cleanup is supporting evidence for normal TUI exit. |
| LLM-01 through LLM-03 | `llm-route`, `llm-affinity`, `llm-stream` | `fish` and loopback SSE. |
| LSP-01 through LSP-03 | `lsp-ts-error`, `lsp-ts-clean`, `lsp-tsx-go` | `fish` with scripted official write/edit calls. |
| LSP-04 | `lsp-editor-actions` | Switch to `minimal`, run create/replace/insert/view, then restore `fish`. |
| LSP-05 | `lsp-run-code` | Switch to `ptc`, run the nested write plus next turn, then restore `fish`. |
| TUI-01 | `tui-preset-baseline` | Fresh state selects fish and advertises the fish-only catalog. |
| TUI-02 | `tui-preset-persistence` | `/preset` survives restart and restores fish. |
| TUI-03 | `tui-persistence` | Controlled turn writes isolated JSONL through one owner. |
| TUI-04 | `tui-resume` | Resume preserves prior history and affinity identity. |
| TUI-05 | `tui-turn` | Controlled tool turn is visible in the TUI transcript. |
| TUI-06 | `tui-affinity` | Session route equality/difference assertions pass. |
| TUI-07 | `tui-privacy` | Telemetry and package inventory are disabled. |
| TUI-08 | `tui-exit` | Normal `/exit` removes all owned children. |

## Plugin Test Matrix

Every dependency upgrade runs all **Core** cases. Run every **Edge** case when
the upgraded package owns the relevant capability, dependency, configuration,
or Loader behavior. Run all edge cases for a major/minor/pre-release family
change.

### 1. Shared Profile and Loader

| ID | Level | Case | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| SH-01 | Core | Full-profile dependency closure | Full-profile graph validator after the isolated five-bundle install. | All selected DSH, Cordis, pi-ai, and TUI versions match the target matrix; no incompatible duplicate family. |
| SH-02 | Core | Current profile parsing | Run the isolated `--dump-config` command. | Expected rows are present; no unknown patch target or malformed YAML error. |
| SH-03 | Core | Module resolution from real bundle paths | Full-profile Loader driver and G3 composition tests. | Local packages resolve their Harness imports through the profile fallback, not a stale workspace copy. |
| SH-04 | Edge | Clean profile installation | Set `DSH_HOME=$(mktemp -d)` and install the required test bundles before booting. | No dependency relies on a prior user profile or cache. |
| SH-05 | Edge | Stale profile recovery | Reinstall the same bundles after an upgrade without deleting the profile. | Package manager refreshes the graph; old package peers are not selected. |
| SH-06 | Edge | Optional service absence | Start with optional external MCP credentials absent. | Disabled rows remain disabled; required local bundles still load. |
| SH-07 | Edge | Profile disposal | Run an isolated composition test twice in one process. | No duplicate service provider, port, temporary process, or leftover profile state. |

### 2. fish-shell

| ID | Level | Case | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| FISH-01 | Core | Provider replacement | Loopback gateway emits the `fish` tool call `printf "ok\n"`; the Loader driver records the shell service target. | Output is `ok`; the active shell provider is `dsh-fish-shell`. |
| FISH-02 | Core | Bash tool suppression | Gateway records the advertised tool catalog under the effective fish preset. | Exactly one `fish` tool is visible and no `bash` tool is visible. |
| FISH-03 | Core | Fish syntax guidance | Gateway emits a Bash-only construct through `fish`. | Tool output contains the original error and the fish-specific correction hint. |
| FISH-04 | Core | Preset installation and precedence | Fresh QA state starts on fish, switches `/preset`, restarts, then restores fish. | The effective default is fish; each persisted preference is honored after restart. |
| FISH-05 | Edge | Existing user preset | Put a user-edited fish preset at the target path before starting. | Bundle startup does not overwrite it. |
| FISH-06 | Edge | Sandbox denial propagation | Attempt a write outside the selected workspace under read-only mode. | Result preserves `sandbox.denied`; fish output does not hide the denial. |
| FISH-07 | Edge | Dependency graph mismatch | Force or inspect a graph containing old `dsh-sandbox` with a newer `dsh-llm`. | G2 fails before TUI startup; do not accept a runtime-only failure. |
| FISH-08 | Edge | Patch-row migration | Upgrade dsh-tui or dsh-base and run G4. | No missing patch entry warning; preset roots remain valid. |

### 3. RTK

| ID | Level | Case | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| RTK-01 | Core | Foreground rewrite | Loopback gateway emits a known rewrite command and the local RTK fixture supplies the matching response. | Command is rewritten exactly once and the rewritten command executes. |
| RTK-02 | Core | Background rewrite | Loader driver calls `ctx.shell.start` directly with the same deterministic RTK fixture. | Process status, output, exit code, signal, and sandbox facts are preserved. |
| RTK-03 | Core | Deny path | Loader driver exercises foreground and background with the fixture's deny result. | Foreground returns `RtkDenyError`; background is killed/noted; delegate has zero calls. |
| RTK-04 | Core | Grep compression | Gateway emits grep and the RTK fixture returns compressed output under two mounts. | One compressed model-facing result is emitted; duplicate mounts do not double-compress. |
| RTK-05 | Edge | RTK unavailable | Temporarily make `rtk` unavailable or force a timeout. | Command fails open to the original shell behavior. |
| RTK-06 | Edge | Delegate error | Make sandbox confinement fail. | The original provider error escapes unchanged; RTK does not relabel it as a rewrite failure. |
| RTK-07 | Edge | Mount/unmount ordering | Mount the RTK bundle twice in an isolated profile, dispose in non-LIFO order. | Decoration remains until the final owner is disposed and then restores exact original methods. |
| RTK-08 | Edge | Fish coexistence | Run RTK and fish together through G3. | There is one fish shell provider, not a second Bash/RTK provider. |

### 4. CodeGraph MCP

| ID | Level | Case | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| CG-01 | Core | MCP process registration | Gateway emits a safe CodeGraph read tool call against the local MCP fixture. | Tool namespace is registered once and the MCP process starts. |
| CG-02 | Core | End-to-end read request | Use the official bundled CodeGraph CLI against a known indexed fixture. | Response comes from the configured CodeGraph server and includes the requested result. |
| CG-03 | Core | Startup failure policy | QA patch points the MCP command at a missing executable. | The configured failure policy is observed and the failure identifies the MCP row. |
| CG-04 | Edge | Unexpected server tool set | Use the fake MCP fixture from composition tests. | The client exposes the fixture's advertised tool, not an assumed hard-coded tool name. |
| CG-05 | Edge | Process cleanup | Close the profile after using CodeGraph. | No owned MCP child process remains. |
| CG-06 | Edge | External auth absence | Leave optional Context4Code/Context7 credentials absent. | Their rows are disabled without breaking CodeGraph MCP. |

### 5. Session-aware pi-ai LLM Route

| ID | Level | Case | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| LLM-01 | Core | Route registration | Full-profile graph validator and QA settings choose the session route. | The route is present with the expected provider and display name. |
| LLM-02 | Core | Session header injection | Loopback gateway records header presence and opaque session-identity equality for two requests. | Every request carries the configured header; same session is equal and different sessions differ. |
| LLM-03 | Core | Stream compatibility | Loopback SSE fixture emits text, tool call, usage, finish, malformed chunk, and interrupted stream scripts. | Valid chunks preserve the adapter contract; invalid scripts surface an error without corrupting later requests. |
| LLM-04 | Edge | Route misconfiguration | Configure an unknown source/provider or malformed route. | Profile load fails loudly at the earliest resolvable point. |
| LLM-05 | Edge | Missing credential | Remove the gateway credential. | The request error is attributable to credentials; no silent fallback selects a different provider. |
| LLM-06 | Edge | Concurrent sessions | Send controlled requests from two sessions. | Each request carries its own session header; no cross-session leakage. |
| LLM-07 | Edge | Upstream stream error | Have the controlled gateway send an invalid chunk or terminate mid-stream. | Error is surfaced through the adapter without corrupting future requests. |

### 6. LSP Diagnostics

| ID | Level | Case | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| LSP-01 | Core | TypeScript write diagnostic | Loopback gateway emits an official write call to the QA workspace and local TypeScript server. | The next model-facing result contains a bounded diagnostics notice. |
| LSP-02 | Core | TypeScript clean transition | Gateway emits a valid edit to the same file. | A subsequent result reports clean state. |
| LSP-03 | Core | TSX and Go routing | Gateway repeats the error-to-clean fixture for `.tsx` and `.go`. | Correct server/language route is selected and notice is accurate. |
| LSP-04 | Core | `str_replace_editor` coverage | Gateway emits create, replace, insert, and view scripts. | Mutations diagnose; view produces no diagnostic action. |
| LSP-05 | Core | `run_code` durability | Gateway emits nested `run_code` write followed by a second controlled turn. | The notice persists into the next request and `snapshotEvents()` entry. |
| LSP-06 | Edge | Unsupported/outside target | Write an unsupported extension, a target outside the workspace, and a session without cwd. | All are silently ignored; no misleading unavailable notice. |
| LSP-07 | Edge | Server failure modes | Exercise missing executable, crash, malformed output, initialize timeout, shutdown timeout, and EPIPE. | Tool call remains fail-open with the documented bounded unavailable reason. |
| LSP-08 | Edge | Result bounds | Exercise large files, too many diagnostics, oversized one-line diagnostics, and multibyte text. | Byte/item/character limits apply to the complete emitted notice. |
| LSP-09 | Edge | Protocol ordering | Send stale, future-version, versionless re-open, cross-URI, and server-request frames through the fixture. | Only valid current publications are accepted; invalid protocol is isolated as documented. |
| LSP-10 | Edge | Cleanup | Dispose while diagnostics or a server request is pending. | Admission closes, I/O is drained/terminated in order, and no fake LSP process remains. |

## dsh-tui Surface Cases

These cases use the isolated QA profile and the deterministic G6 drivers. They
are mandatory for every dependency-family, dsh-tui, preset, persistence, or
pi-ai upgrade.

| ID | Case | Driver | Pass criteria |
| --- | --- | --- | --- |
| TUI-01 | Fresh preset baseline | PTY driver on empty `QA_HOME` | Effective preset is `fish`; exactly one `fish` tool is advertised; no `bash` tool is advertised. |
| TUI-02 | Preset persistence | PTY driver switches `/preset`, exits, restarts, then restores fish | The selected preset survives restart and fish is restored at the end. |
| TUI-03 | JSONL session persistence | Loopback gateway completes one controlled turn; PTY exits; driver reads isolated session metadata | A session is written below `QA_SESSION_ROOT` and no second persistence writer is active. |
| TUI-04 | Resume and identity | PTY launches `dsh-tui --resume <id>` using the isolated session ID | Prior history is present and the loopback gateway reports the same opaque session identity. |
| TUI-05 | Tool catalog and turns | Loopback gateway scripts fish, RTK, CodeGraph, and LSP tool calls | Each core plugin result is visible in the TUI transcript without a host-owned duplicate tool. |
| TUI-06 | Model route and affinity | Loopback gateway selects the session-aware route twice and then from a second session | Route display name is correct; same-session affinity equals; cross-session affinity differs. |
| TUI-07 | Privacy defaults | Config dump and loopback gateway's sanitized request metadata | Telemetry is disabled, package inventory is disabled, and no credentials/header values are persisted in evidence. |
| TUI-08 | Normal shutdown | PTY driver runs `/exit` after the controlled turn | Status zero; no TUI, MCP, LSP, or loopback child remains. |

For upgrades that change only a single bundle, all TUI cases still run. The
bundle-specific matrix determines which edge cases are additionally required.

## Evidence Record

Create one upgrade record outside source control or in the change review:

```text
Upgrade:
Date:
Operator:
Baseline commit:
Baseline manifest checksum:
Baseline lockfile checksum:
dsh version:
dsh-tui launcher/profile version:
Node / pnpm:
Bundles and commit:
QA profile lockfile checksum:

G0:
G1:
G2:
G3:
G4:
G5:
G6 cases:

Failures, expected skips, or deviations:
Rollback decision:
```

Attach only sanitized logs. Never attach API keys, authentication headers,
session headers, full prompt text, or unrelated user workspace data.

## Failure Triage and Rollback

| Symptom | First check | Required response |
| --- | --- | --- |
| Named export missing, especially `assertNever` | G2 graph output and `pnpm-lock.yaml` peer instances | Stop. Restore one coherent Harness family; do not patch package files in `node_modules`. |
| `ERR_MODULE_NOT_FOUND` from a Loader entry | `dsh --profile dsh-tui --dump-config`, global `dsh` dependency installation, profile module fallback | Repair the declared dependency closure, then repeat G3-G5. |
| Patch entry not found | Current `--dump-config` row IDs | Update the bundle patch and add a regression case before retrying. |
| Pending Loader entry | Required service graph in the active profile | Add/restore the owning service entry; do not weaken plugin injection. |
| Unit test passes but G3/G5 fails | Isolated profile module fallback and real Loader rows | Treat as release-blocking; unit tests did not prove deployable resolution. |
| Real gateway/MCP failure | Controlled fixture, credentials, and external service status | Distinguish environment failure from plugin behavior; preserve sanitized evidence. |

Rollback is executable:

```sh
git restore --source <baseline-commit> -- \
  package.json pnpm-lock.yaml plugins
"$QA_PNPM" install --frozen-lockfile
rm -rf "$QA_ROOT"
```

If a live-profile check is explicitly approved, first copy its
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and
`cordis.patch.yml` into the evidence directory. Restore those files, run the
following exact command, and verify the restored graph before reusing the
profile:

```sh
DSH_HOME="<recorded-live-dsh-home>" \
"<recorded-dsh-executable>" plugin --profile dsh-tui install --frozen-lockfile
```

The evidence record must contain the live `DSH_HOME`, dsh executable path,
launcher version, profile version, and checksums of all four copied files.
Do not mix a restored global `dsh` line with a newer local bundle graph.
