# dsh-rtk-shell

RTK shell executor for DeepSeek Harness: transparently rewrites every shell
command through `rtk rewrite` before execution while preserving the sandbox
and result semantics of the delegated `bash-sandbox` provider.

## Usage

Install the bundle into any DSH profile from the repository root. The
workspace-root flag `-w` is required: without it, pnpm cannot resolve the
local package inside the profile's generated workspace and install fails with
`ERR_PNPM_ADDING_TO_ROOT`.

```bash
dsh plugin --profile <name> add -w ./plugins/rtk-shell
```

To install both local bundles (rtk-shell and codegraph-mcp) into one isolated
profile with a single command:

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <name>
```

The sync helper requires `DSH_HOME` so tests and manual QA always target
isolated profile state instead of the user's default Harness home.

The bundle disables the base `bash-sandbox` executor and mounts
`dsh-rtk-shell` as the single `ctx.shell` provider. Only one shell provider is
mounted; a second would fail loud on a duplicate service registration.

## Config

The plugin accepts the bash-sandbox configuration keys plus three RTK knobs,
all optional:

- `rtkBinary`: the `rtk` executable to invoke for `rtk rewrite` (default
  `rtk`, resolved from PATH).
- `rewriteTimeoutMs`: the bound on one `rtk rewrite` oracle call before it
  fails open to passthrough (default `5000`).
- `askNote`: the deterministic note stamped on the result for exit 3 (`ask`)
  rewrites (default `rtk rewrite exit 3 (ask) ran the rewritten command
  without interactive approval`).

These knobs ride through the inherited bash-local config schema untouched, so
profiles can override them without changing package code.

## Behavior

Every shell command goes through `rtk rewrite` before the delegated
bash-sandbox executor runs it. The exit-code contract matches `rtk rewrite`:

- Exit 0, rewrite: the rewritten command from stdout runs in place of the
  original, for example `git status` becomes `rtk git status`. If RTK echoes
  the command unchanged, the original runs as-is.
- Exit 1, passthrough: no RTK equivalent; the original command runs unchanged.
- Exit 2, deny: fails closed. Foreground runs throw a typed `RtkDenyError`
  (name `RtkDenyError`, code `RTK_DENY`) with zero delegate invocations;
  background starts settle as killed processes with the deny reason surfaced
  once through the read path.
- Exit 3, ask: implemented as rewrite-with-note, never interactive approval.
  The command runs rewritten and a deterministic approval note is appended to
  the result stderr (foreground) or prefixed to the first background read.
- Missing, hung, or signal-killed `rtk`: fails open to passthrough so command
  execution is never blocked.

Sandbox confinement, workdir/env/stdin, timeout, abort, exit code, signal,
stdout/stderr, sandbox facts, and background-process lifecycle are inherited
verbatim from the delegated executor. The package never bypasses the sandbox
and never mounts a second shell provider.

## Model Experience

From the model's point of view the shell tool behaves exactly like the base
sandbox shell, except commands route through RTK's transparent rewrite and
compression path before running. Observable differences are limited to what
the tests prove:

- A rewritten command runs as `rtk <command>` and its output is the delegate's
  genuine output.
- An exit 3 (`ask`) rewrite surfaces a deterministic note on the result
  stderr alongside the delegate's own stderr, so the model sees that the
  command was rewritten without interactive approval.
- A deny surfaces as `RtkDenyError` and the command never runs.

This integration does not quantify token or KV-cache savings; RTK's actual
reduction depends on the real binary, its rules, and the commands being run.

## Known Limitations and Deferred Work

- Exit 3 (`ask`) is rewrite-with-note, not interactive approval. A human is
  never prompted, and no interactive approval flow is planned.
- Deterministic fake-RTK tests are the authoritative acceptance for this
  plugin. They use a fake `rtk` fixture on a temporary PATH and never touch a
  user-global `rtk`, user-global DSH profiles, or the network.
- Real `rtk` remains optional. A real binary is never required to install,
  test, or run the plugin; when present, `rtk rewrite` on this machine exits 3
  (`ask`), which maps to rewrite-with-note.
- `start()` (background processes) consults the oracle synchronously so
  delegate startup errors propagate from the call itself. This briefly blocks
  the event loop for up to `rewriteTimeoutMs` while the oracle runs, and fails
  open on a hang. Foreground `run()` is fully async.
- Scope boundaries: this bundle only replaces the shell executor seam. It
  preserves sandbox confinement and every result fact, does not bypass the
  sandbox, and does not modify DSH core, RTK, or CodeGraph.

## Verification

Deterministic package-local tests (fake `rtk` fixture, no user-global state):

```bash
pnpm exec vitest run plugins/rtk-shell/tests/*.spec.ts
```

Documentation shape test (required sections and contract strings):

```bash
pnpm exec vitest run tests/docs-shape-rtk.spec.ts
```

Optional real-RTK smoke, only when a real `rtk` is on PATH and never a
required acceptance:

```bash
scripts/smoke-rtk-shell.sh
```
