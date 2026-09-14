# @banbolee/dsh-codegraph-mcp agent instructions

Marker-fenced CodeGraph usage block, written into an `AGENTS.md` file by
`scripts/install-codegraph-instructions.sh` (or appended by hand).

DSH's `dsh-agent-instructions` plugin (shipped enabled in `@deepseek-ai/dsh-base`)
loads the user-global `$DSH_HOME/AGENTS.md` and the project chain of
`AGENTS.md`/`CLAUDE.md` into model context for the main agent AND for delegated
subagents. That is the only surface that reaches both: the DSH MCP bridge
(`@deepseek-ai/dsh-mcp-client`) does not consume the MCP `initialize`
instructions, so codegraph's own server instructions never reach the model.
This block is the DSH equivalent of what the upstream codegraph installer
writes into CLAUDE.md/AGENTS.md/GEMINI.md for every supported agent.

Keep the block SHORT — the main agent reads it every turn.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when the @banbolee/dsh-codegraph-mcp bundle is installed): `mcp__codegraph__codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If the call reports no default project (the DSH bridge does not send a rootUri, so the server may have derived the project from its launch directory), pass `projectPath` explicitly.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
