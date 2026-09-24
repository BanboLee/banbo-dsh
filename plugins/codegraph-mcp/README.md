# @banbolee/dsh-codegraph-mcp

**English** | [中文](./README.zh.md)

DSH profile bundle that connects the CodeGraph MCP server to any DeepSeek
Harness profile through the official [`@deepseek-ai/dsh-mcp-client`] bridge. It
adds one configurable row, `mcp-codegraph`, which launches
`codegraph serve --mcp` over stdio with `CODEGRAPH_NO_DAEMON=1`.

## Prerequisites

The `codegraph` CLI must be **pre-installed** and reachable on `PATH` for the
bundle to work: the `mcp-codegraph` row launches `codegraph serve --mcp` over
stdio, so without the binary the bridge has no server and no
`mcp__codegraph__*` tools are available. The bundle never downloads or
installs CodeGraph; test against any current release (verified with 1.6.0).

## Usage

**Install from npm (recommended)** — no clone needed:

```sh
dsh plugin --profile <name> add @banbolee/dsh-codegraph-mcp
```

For local development, install the bundle into any DSH profile from the repository root. The
workspace-root flag `-w` is required: without it, pnpm cannot resolve the
local package inside the profile's generated workspace and install fails with
`ERR_PNPM_ADDING_TO_ROOT`.

```bash
dsh plugin --profile <name> add -w ./plugins/codegraph-mcp
```

To install both local bundles (rtk and codegraph-mcp) into one isolated
profile with a single command:

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <name>
```

The sync helper requires `DSH_HOME` so tests and manual QA always target
isolated profile state instead of the user's default Harness home.

## Config

The bundle inserts a single row (see `cordis.patch.yml`):

| Field | Value |
| --- | --- |
| `id` | `mcp-codegraph` |
| `name` | `@deepseek-ai/dsh-mcp-client` |
| `serverName` | `codegraph` |
| `transport` | `stdio` |
| `command` | `codegraph` |
| `args` | `['serve', '--mcp']` |
| `env.CODEGRAPH_NO_DAEMON` | `'1'` |

The `serverName` is `codegraph`, so the bridge registers every advertised MCP
tool under the server-qualified name `mcp__codegraph__<rawName>`.

`CODEGRAPH_NO_DAEMON=1` pins the server to direct mode: `codegraph serve --mcp`
serves this one client over stdio instead of forking a detached background
daemon, which keeps profile use deterministic. No project path is pinned in
the default row: the DSH bridge (`@deepseek-ai/dsh-mcp-client`) does not send a
`rootUri` and does not advertise the MCP `roots` capability, so CodeGraph
derives the project from the server's own working directory — the directory
DSH was launched from. Launch DSH from the indexed project root, or pin the
project explicitly with `--path` (see the profile override below).

## Profile override for project path

A profile patch replaces the row's whole config by id (last write wins; there
is no deep merge). To pin an explicit workspace, restate the row with the path
flag appended:

```yaml
- id: mcp-codegraph
  config:
    serverName: codegraph
    transport: stdio
    command: codegraph
    args: ['serve', '--mcp', '--path', '/abs/path/to/workspace']
    env:
      CODEGRAPH_NO_DAEMON: '1'
```

## Agent instructions

No installation needed — the upstream tool descriptions already teach the
model to reach for CodeGraph first, and this bundle deliberately writes no
AGENTS.md anywhere.

- CodeGraph ships its usage playbook in the MCP `initialize` `instructions`
  (upstream `src/mcp/server-instructions.ts`), which MCP clients surface in the
  agent's system prompt. The DSH bridge (`@deepseek-ai/dsh-mcp-client`) does
  NOT consume those instructions — it bridges MCP tools alone — so that prose
  never reaches the model through the bridge.
- The guidance that DOES cross the bridge is the tool description itself: the
  upstream server describes `codegraph_explore` as
  `PRIMARY TOOL — call FIRST for almost any question OR before an edit`, and
  the other codegraph tools defer to it (`Use codegraph_explore instead`). The
  bridge registers every advertised tool's description verbatim on the harness
  ToolRuntime, so the main agent AND delegated subagents see that emphasis on
  every tool-selection pass.
- This bundle therefore does NOT install any marker-fenced block into
  `$DSH_HOME/AGENTS.md` (or any other AGENTS.md). `$DSH_HOME/AGENTS.md` is
  user-global: `dsh-agent-instructions` (shipped enabled in
  `@deepseek-ai/dsh-base`) loads it into every project and every profile, so a
  codegraph block there would pollute repositories without a `.codegraph/`
  index and profiles without this bundle — guidance with no tool behind it.
  Relying on the tool description keeps the guidance scoped to sessions that
  actually have the MCP tools.

Notes:

- A project that is indexed by CodeGraph is free to mention it in its own
  project `AGENTS.md` (e.g. "this repo is indexed — prefer
  `mcp__codegraph__codegraph_explore` over grep"); that is the project owner's
  call, not this bundle's.
- If an earlier version of this bundle installed a block into some AGENTS.md,
  remove the `<!-- CODEGRAPH_START --> … <!-- CODEGRAPH_END -->` section by
  hand; the marker fence makes the cleanup mechanical.

## Model Experience

Only server-qualified MCP tools are surfaced to the model; raw MCP names are
never registered directly. The deterministic tests observe exactly one public
tool, `mcp__codegraph__echo_context`, and calling it returns the fake server's
`codegraph-ok` text.

## Known Limitations and Deferred Work

- The DSH bridge currently covers tools only; MCP Resources and Prompts have
  no harness consumer and are deferred, so this bundle does not bridge them.
- The DSH bridge does not send a `rootUri` and does not advertise the MCP
  `roots` capability, so CodeGraph cannot learn the project from the client:
  without `--path`, the server derives the project from its launch directory
  (the directory DSH was started from). Pin `--path` per profile to make the
  project explicit and deterministic (see "Profile override for project path").
- The DSH bridge does not consume the MCP `initialize` `instructions`, so
  CodeGraph's usage playbook never reaches the model through the bridge. This
  bundle compensates with what DOES cross the bridge: the upstream tool
  descriptions themselves (see "Agent instructions"), which teach the main
  agent and its subagents to call `mcp__codegraph__codegraph_explore` first —
  the DSH analog of the marker-fenced block upstream installers write into
  CLAUDE.md/AGENTS.md/GEMINI.md for other agents, without writing any file.
- DSH has no static MCP permission allowlist like Claude Code's
  `settings.json` `permissions.allow`. The upstream installer auto-approves
  `mcp__codegraph__*` there to avoid per-call prompts; DSH's approval seam is a
  per-session `ask`/`never` policy with one-shot grants only, so whether a
  codegraph call prompts depends on the composed approval policy — not on this
  bundle. If an interactive profile asks on every codegraph call, set the
  session policy to `never` or use a non-interactive profile.
- The upstream Claude Code installer also wires an opt-in `UserPromptSubmit`
  hook running `codegraph prompt-hook`, which front-loads codegraph context on
  structural ("how / where / trace") prompts so the agent reaches for the graph
  without being told. DSH has no equivalent prompt hook surface (the
  `dsh-agent-instructions` chain is static, not prompt-reactive), so codegraph
  guidance reaches the model only through the tool descriptions — the
  prompt-hook front-loading is deferred, not replicated here.
- Deterministic fake-MCP tests are the authoritative acceptance for this
  bundle. They run against `tests/fixtures/fake-mcp-server.mjs` and require no
  live `codegraph` binary, no network, and no daemon. Deterministic acceptance
  runs without a daemon.
- Real CodeGraph smoke remains optional. A real `codegraph` binary is never
  required to install, test, or run the bundle; `scripts/smoke-codegraph-mcp.sh`
  is a best-effort diagnostic that skips when the binary is absent.
- A real `codegraph serve --mcp` server is telemetry-default-on and performs a
  background update-availability check at startup (verified against the
  CodeGraph source). Profiles that want to opt out add environment variables
  to the row's `env`:
  - `DO_NOT_TRACK=1` disables both anonymous usage telemetry and the
    background update check.
  - `CODEGRAPH_TELEMETRY=0` disables telemetry only; it takes precedence over
    the stored default-on choice.
  - `CODEGRAPH_NO_UPDATE_CHECK=1` disables the background update check only.
  The default row leaves telemetry and update-check behavior at CodeGraph's
  own defaults; the bundle does not change them.

## Verification

Deterministic tests mount the bundle row through the official bridge against a
fake stdio MCP server; no live `codegraph` binary or daemon is required:

```bash
pnpm exec vitest run plugins/codegraph-mcp/tests/*.spec.ts
```

Documentation shape test (required sections and contract strings, including
the agent-guidance strategy — no AGENTS.md writes, guidance via tool
descriptions):

```bash
pnpm exec vitest run tests/docs-shape-codegraph.spec.ts
```

Optional real-CodeGraph smoke, only when a real `codegraph` is on PATH and
never a required acceptance:

```bash
scripts/smoke-codegraph-mcp.sh
```
