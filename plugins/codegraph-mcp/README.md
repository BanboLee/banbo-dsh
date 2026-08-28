# dsh-codegraph-mcp

DSH profile bundle that connects the CodeGraph MCP server to any DeepSeek
Harness profile through the official [`@deepseek-ai/dsh-mcp-client`] bridge. It
adds one configurable row, `mcp-codegraph`, which launches
`codegraph serve --mcp` over stdio with `CODEGRAPH_NO_DAEMON=1`.

## Install

```bash
dsh plugin --profile <name> add ./plugins/codegraph-mcp
```

## Bundle row

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

The bridge registers every CodeGraph MCP tool under the server-qualified name
`mcp__codegraph__<rawName>`.

## Profile override for a project path

A profile patch replaces the row's whole config (no deep merge). To pin an
explicit workspace, restate the row with `--path` appended:

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

## Verification

Deterministic tests run the bundle row against a fake stdio MCP server; no
live `codegraph` binary or daemon is required:

```bash
pnpm exec vitest run plugins/codegraph-mcp/tests/*.spec.ts
```
