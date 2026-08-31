# dsh-codegraph-mcp

DSH profile bundle that connects the CodeGraph MCP server to any DeepSeek
Harness profile through the official [`@deepseek-ai/dsh-mcp-client`] bridge. It
adds one configurable row, `mcp-codegraph`, which launches
`codegraph serve --mcp` over stdio with `CODEGRAPH_NO_DAEMON=1`.

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
the default row; CodeGraph derives it from the client's rootUri at connect
time.

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

## Model Experience

Only server-qualified MCP tools are surfaced to the model; raw MCP names are
never registered directly. The deterministic tests observe exactly one public
tool, `mcp__codegraph__echo_context`, and calling it returns the fake server's
`codegraph-ok` text.

## Known Limitations and Deferred Work

- The DSH bridge currently covers tools only; MCP Resources and Prompts have
  no harness consumer and are deferred, so this bundle does not bridge them.
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

Optional real-CodeGraph smoke, only when a real `codegraph` is on PATH and
never a required acceptance:

```bash
scripts/smoke-codegraph-mcp.sh
```
