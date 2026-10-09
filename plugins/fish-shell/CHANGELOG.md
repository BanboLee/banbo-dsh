# Changelog

All notable changes to `@banbolee/dsh-fish-shell` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-10-03

This is a **minor** release (`0.7.0` → `0.8.0`): a new capability, no breaking
change — the one-shot `fish` path is untouched.

### Added

- Interactive terminal sessions (L2): the bundle patch now appends a
  `fish-terminal-group` (`cordis:group` + `isolate: { terminals: true }`) that
  mounts the official `@deepseek-ai/dsh-terminal`, this bundle's `terminal.js`
  (the official `@deepseek-ai/dsh-terminal-bash` backend driven with fish argv,
  plus the harness home contract below), the official
  `@deepseek-ai/dsh-tool-terminal`, and this bundle's `terminal-tools` policy.
  The model gets six `terminal_*` tools — `terminal_open`, `terminal_send`,
  `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list` — a
  real fish PTY instead of only one-shot `fish -c`.
- **Harness home contract in interactive sessions.** `terminal.js` adds
  `DSH_HOME` — and `DSH_PROFILE` / `DSH_PROFILE_DIR` when the profile context
  carries them — to the PTY child environment, from the same `ctx.shellEnv`
  registry the one-shot `fish` tool reads. A `dsh` nested inside an interactive
  session now starts on the same harness home and plugin set out of the box;
  before this change it resolved the default `~/.dsh` and had to be pointed at
  the real home by hand (`env -u DSH_SESSION_ID … DSH_HOME=<home> dsh --profile
  <profile>`).
- The `terminalTools` switch (`terminal-tools.js`, exported as
  `@banbolee/dsh-fish-shell/terminal-tools`): `allow` (default) or `deny`
  (restrict the six explicitly enumerated tool names per agent).

### Changed

- `@deepseek-ai/dsh-tool-terminal@0.2.0-rc.1` now ships with the package: it is
  a `dependencies` + `bundledDependencies` entry, so packing requires the
  hoisted linker (`pnpm install --prod --config.node-linker=hoisted` →
  `pnpm pack --config.node-linker=hoisted`). An offline profile install
  resolves it from inside the tarball instead of the profile plane.
- `scripts/sync-to-profile.sh` now takes a `<profile>` argument and deploys the
  packed tarball (`dsh plugin --profile <profile> add -w <tgz> --offline
  --config.auto-install-peers=false`) instead of copying a hand-written list of
  source files.
- The L2 backend row keeps the official backend's configuration contract:
  `terminal.js` re-exports the official `Config` schema and reproduces the
  official configuration resolution and validation (per-dialect defaults,
  validation messages), so an empty `shellPath`/`shellArgs` gets the official
  defaults and an invalid value is rejected exactly as the official backend
  rejects it. `@deepseek-ai/dsh-pwsh-local`, which the pwsh dialect default
  resolves through, is declared as a peer dependency.
- A mounted home registry is the only source of the injected home facts: a
  failing `ctx.shellEnv.collect()` fails the spawn instead of silently falling
  back to the ambient `DSH_HOME`, and a fact the registry does not declare is
  left undeclared rather than borrowed from another source. The public
  `dsh-home-paths` / `profileContext` fallback applies only when no registry is
  mounted at all.

### Documentation

- README (both languages): support matrix, security model, expanded Known
  Limitations and a troubleshooting section (`ERR_MODULE_NOT_FOUND`,
  `ERR_PNPM_NO_OFFLINE_TARBALL`).
- `THIRD-PARTY-NOTICES.md`: origin, version and license of every package
  bundled into the tarball.

### Unchanged

- The legacy one-shot surface keeps its exact code path: `index.js`, `tool.js`,
  `persistent.js` and `terminal-fish.js` are untouched, and so are the
  host-plane patch rows (`bash-sandbox`/`tool-bash` disabled;
  `fish-shell`/`tool-fish`/`fish-preset-policy` inserted).
