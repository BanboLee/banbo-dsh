# dsh-fish-shell

Fish shell executors and tool for DeepSeek Harness: run commands with
**fish** instead of bash. Distribution-ready and surface-agnostic: works in
any profile that mounts it, preset-roster based (dsh-tui, web) or
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
- **Executor, unconfined** (`local.js`, exported as `dsh-fish-shell/local`):
  `FishLocalExecutor`, a `LocalBashExecutor` subclass running `fish -c`
  without a sandbox. For custom compositions that deliberately run without a
  sandbox; do not mount it alongside `dsh-permission-presets`.
- **Tool** (`tool.js`, exported as `dsh-fish-shell/tool`): a model-facing
  `fish` tool mounted host-globally, executing through `ctx.shell` — not its
  own subprocess — so every call inherits the executor's sandbox, credential
  scrub, bounded output, timeout clamping, and result facts. Its description
  teaches the model fish syntax (variables, conditionals, chaining,
  substitution) and it renders the harness marker contract (`[exit code: N]`,
  `[stderr]`, `[sandbox: file access denied under <mode> mode]`).
- **Agent preset** (bundled at `presets/fish/`): a copy of the shipped
  `standard` preset with the shell section removed (the `fish` tool is
  host-global, so the preset needs no shell row). The bundle patch adds the
  package's `presets/` directory as a system preset root and switches the
  preset-roster default to `fish` for both roster row ids (`agent-presets`
  used by web, `dsh-tui-agent-presets` used by dsh-tui); the tool plugin also
  idempotently installs the preset under `$DSH_HOME/.agent-presets/fish` as a
  fallback for surfaces whose roster row this bundle does not patch.

## Install

```sh
# from this checkout, per profile:
dsh plugin --profile <name> add ./plugins/fish-shell
```

For a published npm package: `dsh plugin --profile <name> add dsh-fish-shell`.

Add it to every profile that should default to fish (dsh-tui, web, headless,
…). The bundle patch is a no-op (with a warning) for a roster row id that the
profile does not have, so one patch file is safe across surfaces.

### Deployed copy and the symlink chain

The executors subclass `@deepseek-ai/dsh-bash-local` /
`@deepseek-ai/dsh-bash-sandbox`. Those imports must resolve to the same
runtime instance the harness uses — the launcher-maintained
`profiles/node_modules/@deepseek-ai/*` symlink chain. A plain `link:` to this
checkout (outside the profile tree) would resolve no `@deepseek-ai` package,
so the deployed copy lives at `profiles/node_modules/dsh-fish-shell` (inside
the tree). `scripts/sync-to-profile.sh` copies the plugin there after edits
and checks the fish agent preset for drift against the shipped `standard`
preset; a pnpm `file:` dependency points each profile at the deployed copy. A
package published to npm installs normally (its realpath already lies inside
the profile tree).

## Per-surface behavior

- **Preset-roster surfaces** (dsh-tui, web): agents compose tools from the
  `fish` preset (default) — `standard` minus the shell rows — and see exactly
  one shell tool, `fish`. Other presets stay available via `/preset`.
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

## Known Limitations

- Models default to bash idioms; the `fish` tool description teaches fish
  syntax, but a command written in bash dialect fails under fish. This is the
  intended trade of swapping the shell.
- The `fish` tool has no `run_in_background` parameter and no sandbox
  escalation (`sandbox_permissions`) parameters yet; long commands must
  finish within the timeout, and a denied command cannot be re-run wider
  (the executor's `start()` and the approval stack are available to
  in-process consumers).
