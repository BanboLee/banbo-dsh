# @banbolee/dsh-fish-shell

Fish shell executors and tool for DeepSeek Harness: run commands with
**fish** instead of bash. Distribution-ready and surface-agnostic: works in
any profile that mounts it — preset-roster based (dsh-tui, web) or
host-tool based (headless).

## What this bundle does

- **Executor, sandboxed** (`index.js`, default export): `FishSandboxExecutor`,
  a `SandboxBashExecutor` subclass that confines `fish -c` commands instead
  of `bash -c`. Mounted as `ctx.shell` in place of the base `bash-sandbox`
  executor. The sandbox backend, denial classification, runner-failure
  facts, and the `sandboxMode` capability fact (required by
  `dsh-permission-presets`) are inherited. Both the confined and the
  `danger-full-access` paths run fish (the base class's full-access branch
  falls through to hardcoded bash, so it is overridden).
- **Executor, unconfined** (`local.js`, exported as `@banbolee/dsh-fish-shell/local`):
  `FishLocalExecutor`, a `LocalBashExecutor` subclass running `fish -c`
  without a sandbox. For custom compositions that deliberately run without a
  sandbox; composing it with `dsh-permission-presets` fails loud at load.
- **Tool** (`tool.js`, exported as `@banbolee/dsh-fish-shell/tool`): a model-facing
  `fish` tool mounted host-globally, executing through `ctx.shell`. It passes
  the calling session's resolved sandbox policy (so `/permission` switches
  and the session workspace root are honored), collects the managed `DSH_*`
  environment from `ctx.shellEnv`, and renders the harness marker contract
  (`[exit code: N]`, `[stderr]`, `[sandbox: file access denied under <mode>
  mode]`, `[output truncated; full output: <path>]`). Its description teaches
  the model fish syntax.
- **Agent preset** (bundled at `presets/fish/`): a copy of the shipped
  `standard` preset with the shell section removed (the `fish` tool is
  host-global, so the preset needs no shell row). The bundle patch adds the
  package's `presets/` directory as a system preset root and switches the
  preset-roster default to `fish` for both roster row ids (`agent-presets`
  used by web, `dsh-tui-agent-presets` used by dsh-tui). The tool plugin also
  installs the preset under `$DSH_HOME/.agent-presets/fish` create-only
  (never overwrites an existing file, including a user-authored one; a failed
  write is a warning) as a fallback for rosters whose row this bundle does
  not patch.

## Install

**From npm (recommended)** — no clone needed:

```sh
dsh plugin --profile <name> add @banbolee/dsh-fish-shell
```

From this checkout, per profile:

```sh
dsh plugin --profile <name> add ./plugins/fish-shell
```

Add it to every profile that should default to fish (dsh-tui, web, headless,
…). The bundle patch is a no-op (with a warning) for a roster row id that the
profile does not have, so one patch file is safe across surfaces.

### Deployed copy and the symlink chain

The executors subclass `@deepseek-ai/dsh-bash-local` /
`@deepseek-ai/dsh-bash-sandbox`. Those imports must resolve to the same
runtime instance the harness uses — the launcher-maintained
`profiles/node_modules/@deepseek-ai/*` symlink chain. A plain `link:` to this
checkout (outside the profile tree) would resolve no `@deepseek-ai` package,
so the deployed copy lives at `profiles/node_modules/@banbolee/dsh-fish-shell` (inside
the tree). `scripts/sync-to-profile.sh` copies the plugin there after edits
and checks the bundled fish preset for drift against the shipped `standard`
preset; a pnpm `file:` dependency points each profile at the deployed copy. A
package published to npm installs normally (its realpath already lies inside
the profile tree).

## Per-surface behavior

- **Preset-roster surfaces** (dsh-tui, web): agents compose tools from the
  `fish` preset (default) — `standard` minus the shell rows — and see exactly
  one shell tool, `fish`. **Upstream presets (`standard`, `code`) are not
  fish-safe**: they register a `bash`-named tool that still executes through
  the fish executor, so the name/description lie about the shell. Only the
  bundled `fish` preset is fish-only. (`minimal` has no one-shot shell tool.)
- **Host-tool surfaces** (headless): the agent uses host-plane tools; the
  disabled host `tool-bash` and the host-global `fish` tool make fish the
  agent's only shell tool.

## Behavior

- Every shell call spawns a fresh non-login shell (under the configured
  sandbox backend for `FishSandboxExecutor`); no state (cwd, variables,
  functions, history) persists between calls.
- Output is bounded per stream by the executor's configured caps; timeouts
  are clamped to the executor's cap; the model sees the harness marker
  contract.
- Requires `fish` on PATH; the executors fail loud when it is missing.

## Known Limitations

- Models default to bash idioms; the `fish` tool description teaches fish
  syntax, but a command written in bash dialect fails under fish. This is the
  intended trade of swapping the shell.
- The `fish` tool has no `run_in_background` parameter and no sandbox
  escalation (`sandbox_permissions`) parameters yet; long commands must
  finish within the timeout, and a denied command cannot be re-run wider
  (the executor's `start()` and the approval stack are available to
  in-process consumers).
- Upstream presets (`standard`, `code`) are not fish-safe; see
  Per-surface behavior.
- POSIX only: the `fish` binary and the underlying process-group semantics
  are not available on Windows (the pwsh family covers Windows).
