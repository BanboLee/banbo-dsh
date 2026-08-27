# dsh-fish-shell

Self-contained **fish shell tool** for DeepSeek Harness: replaces the default
bash execution with fish.

- Registers a `fish` tool that runs every command through `fish -c`.
- **Zero `@deepseek-ai/*` dependencies**: imports only Node built-ins, so
  installing it into a profile cannot collide with the harness's own package
  copies (no duplicate-Cordis-instance risk).
- Ships as a `dsh.bundle`: its patch disables the base profile's
  `bash-sandbox` executor and `tool-bash` tool, then inserts the `fish` tool.

## Install

```sh
dsh plugin --profile <name> add dsh-fish-shell
```

or, from a local checkout:

```sh
dsh plugin --profile <name> add ./plugins/fish-shell
```

## Behavior

- Each call spawns a fresh non-login `fish -c <command>`; no state (cwd,
  variables, functions, history) persists between calls.
- stdout/stderr are collected with a 64 KiB in-memory cap per stream;
  overflow is truncated and flagged.
- Default per-call timeout is 120 s (overridable via `timeoutMs`); on
  timeout/cancel the whole process group is killed.
- Results use the harness bash-tool marker contract
  (`[exit code: N]`, `[stderr]`, `[timed out after Nms]`) so the model reads
  both shells identically.

## Known Limitations

- No sandbox: commands run with the harness process's authority. The base
  `bash-sandbox` executor is disabled by this bundle.
- No background-job registration (`run_in_background`); long commands must
  finish within the timeout.
- No spill files: truncated output is not recoverable.
