# @banbolee/dsh-codegraph-mcp

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

Install the bundle into any DSH profile from the repository root. The
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

CodeGraph ships its usage playbook in the MCP `initialize` `instructions` (the
upstream `src/mcp/server-instructions.ts`), which MCP clients surface in the
agent's system prompt. The DSH bridge (`@deepseek-ai/dsh-mcp-client`) does NOT
consume those instructions — it bridges MCP tools alone — so neither the main
agent nor delegated subagents see codegraph's guidance through the bridge. The
upstream codegraph installer closes this gap for agents that have an
instructions file — Claude Code (CLAUDE.md), Codex CLI (AGENTS.md), opencode
(AGENTS.md), Gemini (GEMINI.md), … — by writing a short marker-fenced block
into that file. (Cursor is the exception: upstream writes only its `mcp.json`
with a `--path`-injected entry and relies on the initialize instructions
alone.) DSH's `dsh-agent-instructions` plugin (shipped enabled in
`@deepseek-ai/dsh-base`) loads `$DSH_HOME/AGENTS.md` plus the project chain of
`AGENTS.md`/`CLAUDE.md` into model context automatically — the DSH equivalent
of that file.

This bundle ships the block in `instructions/CODEGRAPH.md`. Install it once per
Harness home (or per project) with the idempotent helper:

```bash
scripts/install-codegraph-instructions.sh            # $DSH_HOME/AGENTS.md, else ~/.dsh/AGENTS.md
scripts/install-codegraph-instructions.sh <target>   # explicit AGENTS.md path
```

The write is marker-fenced (`<!-- CODEGRAPH_START/END -->`): re-running with an
identical block reports `unchanged` and touches nothing, and only the fenced
section is ever replaced, so surrounding content is preserved. The block points
the agent (and its subagents) at `mcp__codegraph__codegraph_explore` first, and
mentions `projectPath` for the no-default-project case. To remove it later,
delete the fenced section (or re-run a future uninstall story).

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
  CodeGraph's usage playbook never reaches the model through the bridge. The
  marker-fenced block in `instructions/CODEGRAPH.md` (installed via
  `scripts/install-codegraph-instructions.sh` into `AGENTS.md`) is the
  supported way to teach the agent and its subagents to call
  `mcp__codegraph__codegraph_explore` — the DSH analog of what the upstream
  installer writes into CLAUDE.md/AGENTS.md/GEMINI.md for other agents.
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
  `dsh-agent-instructions` chain is static, not prompt-reactive), so the
  marker-fenced block in `instructions/CODEGRAPH.md` is the only way codegraph
  guidance reaches the model — the prompt-hook front-loading is deferred, not
  replicated here.
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

Documentation shape test (required sections and contract strings):

```bash
pnpm exec vitest run tests/docs-shape-codegraph.spec.ts
```

Agent-instructions block and idempotent install script (deterministic, no live
codegraph, no network, no daemon):

```bash
pnpm exec vitest run plugins/codegraph-mcp/tests/instructions.spec.ts
```

Optional real-CodeGraph smoke, only when a real `codegraph` is on PATH and
never a required acceptance:

```bash
scripts/smoke-codegraph-mcp.sh
```
