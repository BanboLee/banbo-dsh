# banbo-dsh

Local DeepSeek Harness profile bundles for this checkout.

## Install RTK and CodeGraph MCP bundles

Install either bundle into a DSH profile from the repository root:

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp
```

To install both local bundles in one command while keeping profile state
explicit, use:

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <profile>
```

The sync helper requires `DSH_HOME` so tests and manual QA can target isolated
profile state instead of the user's default Harness home.
