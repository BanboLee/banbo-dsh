# @banbolee/dsh-rtk

RTK rewrite decorator for DeepSeek Harness: a plain Cordis function plugin
(`name`/`inject`/`Config`/`apply`) that decorates the live `ctx.shell`
executor — wrapping its `run`/`start` with the `rtk rewrite` oracle — and
that compresses the model-facing `grep` tool's output through `rtk pipe`.
Because it wraps rather than replaces the shell, it coexists with any shell
executor (bash, fish, ...) and never registers a duplicate shell provider.
Sandbox confinement and result semantics are inherited from the mounted
executor.

## Prerequisites

The `rtk` CLI must be **pre-installed** and reachable on `PATH` (or pinned via
the `rtkBinary` config) for this bundle to have any effect. Without `rtk`, the
plugin still installs and runs, but every command fails open to passthrough —
no `rtk rewrite` happens and `grep` output is never compressed. The bundle
never downloads or installs `rtk` itself; test against any current `rtk`
release (verified with 0.47.0).

## Usage

Install the bundle into any DSH profile from the repository root. The
workspace-root flag `-w` is required: without it, pnpm cannot resolve the
local package inside the profile's generated workspace and install fails with
`ERR_PNPM_ADDING_TO_ROOT`.

```bash
dsh plugin --profile <name> add -w ./plugins/rtk
```

To install both local bundles (rtk and codegraph-mcp) into one isolated
profile with a single command:

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-rtk-codegraph-to-profile.sh <name>
```

The sync helper requires `DSH_HOME` so tests and manual QA always target
isolated profile state instead of the user's default Harness home.

The plugin is a function plugin that decorates the mounted shell executor: it
wraps the live `ctx.shell` object's `run`/`start` with the `rtk rewrite`
oracle and registers a `tools/post-execute` listener that compresses `grep`
output. It never mounts (or replaces) a shell provider, so it coexists with
any executor the host mounts as `ctx.shell` (bash, fish, ...) without a
duplicate service registration.

## Config

The plugin accepts three active optional knobs and one deprecated compatibility field:

- `rtkBinary`: the `rtk` executable to invoke for `rtk rewrite` and
  `rtk pipe` (default `rtk`). Bare names are resolved once from the Harness
  startup PATH; relative paths are resolved once from the Harness startup
  directory. Requests cannot replace the pinned executable through `PATH` or
  reinterpret a relative path through their workdir. On Windows the resolved
  target must be directly executable (`.exe` or `.com`); batch shims are not
  launched through a command shell.
- `rewriteTimeoutMs`: the bound on one `rtk rewrite` oracle call before it
  fails open to passthrough (default `5000`).
- `grepCompress`: when enabled, `grep` tool output is piped through
  `rtk pipe -f grep` after the tool runs (default `true`).
- `askNote`: deprecated and ignored. It remains accepted for profile
  compatibility, but exit-3 (`ask`) rewrites are always silent.

The three active knobs ride through the plugin's `Config` schema untouched, so
profiles can override their runtime behavior without changing package code.
`askNote` is retained only for profile parsing compatibility and has no runtime
effect.

## Behavior

Every shell command goes through `rtk rewrite` before the mounted shell
executor runs it. The exit-code contract matches `rtk rewrite`:

- Exit 0, rewrite: the rewritten command from stdout runs in place of the
  original, for example `git status` becomes `rtk git status`. If RTK echoes
  the command unchanged, the original runs as-is.
- Exit 1, passthrough: no RTK equivalent; the original command runs unchanged.
- Exit 2, deny: fails closed. Foreground runs throw a typed `RtkDenyError`
  (name `RtkDenyError`, code `RTK_DENY`) with zero delegate invocations;
  background starts settle as killed processes with the deny reason surfaced
  once through the read path.
- Exit 3, ask: no interactive approval is requested. The rewritten command
  runs silently; the plugin adds no RTK-specific text to foreground stderr or
  background output.
- Missing, hung, or signal-killed `rtk`: fails open to passthrough so command
  execution is never blocked.

Model-facing `grep` tool results are compressed: after the `grep` tool
executes, its accepted text content is piped through `rtk pipe -f grep`. A
pipe failure fails open to the original output, so grep results are never
lost or blocked.

Sandbox confinement, workdir/env/stdin, timeout, abort, exit code, signal,
stdout/stderr, sandbox facts, and background-process lifecycle are inherited
verbatim from the delegated executor. The package never bypasses the sandbox
and never mounts a shell provider.

## Model Experience

From the model's point of view the shell tool behaves exactly like the
mounted executor (bash, fish, or whatever the profile configures), except
commands route through RTK's transparent rewrite before running, and `grep`
tool results may come back compressed through `rtk pipe -f grep`. Observable
differences are limited to what the tests prove:

- A rewritten command runs as `rtk <command>` and its output is the delegate's
  genuine output.
- An exit 3 (`ask`) rewrite runs the rewritten command without adding an
  RTK-specific message to the model-facing result.
- A deny surfaces as `RtkDenyError` and the command never runs.
- A `grep` result may be returned compressed; when the pipe fails open the
  original text is returned unchanged.

This integration does not quantify token or KV-cache savings; RTK's actual
reduction depends on the real binary, its rules, and the commands being run.

## Known Limitations and Deferred Work

- Exit 3 (`ask`) runs the rewritten command silently, not through interactive
  approval. A human is never prompted, and no interactive approval flow is planned.
- Deterministic fake-RTK tests are the authoritative acceptance for this
  plugin. They use a fake `rtk` fixture on a temporary PATH and never touch a
  user-global `rtk`, user-global DSH profiles, or the network.
- Real `rtk` remains optional. A real binary is never required to install,
  test, or run the plugin; when present, `rtk rewrite` on this machine exits 3
  (`ask`), which maps to a silent rewrite.
- `start()` (background processes) consults the oracle synchronously so
  delegate startup errors propagate from the call itself. This briefly blocks
  the event loop for up to `rewriteTimeoutMs` while the oracle runs, and fails
  open on a hang. Foreground `run()` is fully async.
- Scope boundaries: this plugin decorates the mounted shell executor (wrapping
  its `run`/`start` with the `rtk rewrite` oracle) and compresses
  model-facing `grep` output through `rtk pipe`. It never mounts a shell
  provider, never bypasses the sandbox, and does not modify DSH core, RTK, or
  CodeGraph.

## Verification

Deterministic package-local tests (fake `rtk` fixture, no user-global state):

```bash
pnpm exec vitest run plugins/rtk/tests/*.spec.ts
```

Documentation shape test (required sections and contract strings):

```bash
pnpm exec vitest run tests/docs-shape-rtk.spec.ts
```

Optional real-RTK smoke, only when a real `rtk` is on PATH and never a
required acceptance:

```bash
scripts/smoke-rtk.sh
```
