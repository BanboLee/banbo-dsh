# dsh-rtk-shell

RTK shell executor for DeepSeek Harness: transparently rewrites every shell
command through `rtk rewrite` before execution while preserving the sandbox
and result semantics of the delegated `bash-sandbox` provider.

## Usage

```bash
dsh plugin --profile <name> add ./plugins/rtk-shell
```

The bundle disables the base `bash-sandbox` executor and mounts `dsh-rtk-shell`
as the single `ctx.shell` provider. Install into any profile with
`dsh plugin --profile <name> add ./plugins/rtk-shell`.

## Behavior

- Exit 0 — rewrite: the command runs as `rtk <command>`.
- Exit 1 — passthrough: the original command runs unchanged.
- Exit 2 — deny: fails closed with a deterministic `RtkDenyError` and zero
  delegate invocations.
- Exit 3 — ask: implemented as rewrite-with-note (no interactive approval);
  a deterministic approval note is appended to the result stderr.
- Missing or hung `rtk`: fails open to passthrough so execution is never
  blocked (mirrors the upstream RTK hook contract).

Sandbox confinement, workdir/env/stdin, timeout, abort, exit code, signal,
stdout/stderr, sandbox facts, and background-process lifecycle are inherited
verbatim from the delegated executor.

## Verification

```bash
pnpm exec vitest run plugins/rtk-shell/tests/*.spec.ts
```
