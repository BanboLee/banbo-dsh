# dsh-fish-shell

Fish shell executor and tool for DeepSeek Harness: run commands with **fish**
instead of bash.

## What this bundle does

- **Executor** (`index.js`, default export): `FishSandboxExecutor`, a
  `SandboxBashExecutor` subclass that confines `fish -c` commands instead of
  `bash -c`. Mounted as `ctx.shell` in place of the base `bash-sandbox`
  executor, so the sandbox backend, denial classification, and the
  `sandboxMode` capability fact (required by `dsh-permission-presets`) are
  inherited unchanged.
- **Tool** (`tool.js`, exported as `dsh-fish-shell/tool`): a model-facing
  `fish` tool that runs commands through `fish -c` and teaches the model fish
  syntax (variables, conditionals, chaining, substitution).
- **Agent preset** (`$DSH_HOME/.agent-presets/fish/`): a copy of the
  `standard` preset whose shell tool row is the `fish` tool instead of
  `tool-bash`. The bundle patch switches the dsh-tui agent-preset roster
  default to this `fish` preset.

## Install

```sh
# from this checkout, into a profile:
dsh plugin --profile <name> add ./plugins/fish-shell
```

For the dsh-tui profile the bundle additionally requires the `fish` agent
preset (see below).

### Deployed copy and the symlink chain

The executor subclasses `SandboxBashExecutor`, importing
`@deepseek-ai/dsh-bash-sandbox`. That import must resolve to the same runtime
instance the harness uses — the launcher-maintained
`profiles/node_modules/@deepseek-ai/*` symlink chain. A plain `link:` to this
checkout (outside the profile tree) would resolve no `@deepseek-ai` package,
so the deployed copy lives at `profiles/node_modules/dsh-fish-shell` (inside
the tree). `scripts/sync-to-profile.sh` copies the plugin there after edits;
a pnpm `file:` dependency points the profile at it. A package published to
npm installs normally (its realpath already lies inside the profile tree).

## Agent preset

The dsh-tui surface composes every agent's tools from an agent-preset roster.
The `fish` preset at `$DSH_HOME/.agent-presets/fish/agent.cordis.yml` is a
copy of the shipped `standard` preset with the shell rows
(`tool-bash`/`tool-pwsh`) replaced by `dsh-fish-shell/tool`. The bundle patch
sets the roster default to `fish`; switch presets at any time with `/preset`
inside the TUI.

## Behavior

- Every shell call spawns a fresh non-login shell under the configured
  sandbox backend; no state (cwd, variables, functions, history) persists
  between calls.
- The `fish` tool collects stdout/stderr with a 64 KiB per-stream cap
  (overflow truncated and flagged), a 120 s default timeout, and the harness
  bash-tool marker contract (`[exit code: N]`, `[stderr]`, `[timed out after
  Nms]`).

## Known Limitations

- Models default to bash idioms; the `fish` tool description teaches fish
  syntax, but a command written in bash dialect fails under fish. This is the
  intended trade of swapping the shell.
- The `fish` tool has no `run_in_background` parameter; long commands must
  finish within the timeout (the executor's `start()` background path is
  available to in-process consumers).
