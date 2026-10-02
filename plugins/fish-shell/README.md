# @banbolee/dsh-fish-shell

**English** | [中文](./README.zh.md)

Fish shell executors and tool for DeepSeek Harness: run commands with
**fish** instead of bash. The bundle is surface-agnostic by construction —
preset-roster based (dsh-tui, web) or host-tool based (headless) — and the
per-agent policy is written to apply under any agent preset (standard, ptc,
cordis, minimal, or a third-party preset). The **verified envelope is narrower
than the design**: the real lanes cover `dsh-base`-class profiles (an isolated
profile whose bundle layers are `@deepseek-ai/dsh-base` + this bundle), the
`dsh-tui` composition, and the official `minimal` preset. Every other
preset/profile combination is **unverified**, so read **Known Limitations**
below for the authoritative scope before deploying elsewhere.

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
  `fish` tool mounted host-globally, executing through `ctx.shell`. Its
  functional surface is aligned with the official `@deepseek-ai/dsh-tool-bash`
  (with shell wording swapped to fish):
  - **Background execution**: `run_in_background: true` registers the command
    with `ctx.jobs` (`kind: fish`) and returns `{kind: 'background', jobId}`;
    the process's observed streams are handed to the registry as pull sources
    (it owns the lossy-read reporting), the sandbox runner-failure/denial
    facts join the job's terminal detail, and the job controller's
    `job_output`/`job_kill` handle the rest.
  - **Sandbox escalation**: when the mounted executor confines, the schema
    advertises `sandbox_permissions` + `justification`; an escalation is
    resolved through `ctx.approval` BEFORE anything executes (strictly wider
    modes only, fail-closed), and a denial result carries the same-turn
    escalation hint. Headless compositions (no sandboxing executor) expose
    neither field.
  - **Result facts**: foreground results carry the complete canonical facts,
    including the sandbox `enforcement`/`runnerFailed` fields.
  - **UI presentation**: `presentCall`/`presentResult` render foreground calls
    as terminal cards (with an exit-status pill) and background/error
    outcomes as generic fenced console output.
  - **Exit-code prompt section**: registers the `tool:fish` section
    ("Check the [exit code: N] marker on every fish result…") at the
    `TOOL_BASH` position.
  - On top of all that it passes the calling session's resolved sandbox policy
    (so `/permission` switches and the session workspace root are honored),
    collects the managed `DSH_*` environment from `ctx.shellEnv`, renders the
    harness marker contract (`[exit code: N]`, `[stderr]`, `[sandbox: file
    access denied under <mode> mode]`, `[output truncated; full output:
    <path>]`), and its description teaches the model fish syntax with
    per-result `[fish syntax]` hints.
- **Per-agent fish policy** (`policy.js`, exported as
  `@banbolee/dsh-fish-shell/policy`): a host-mounted Cordis plugin that makes
  every agent see fish instead of bash **regardless of which agent preset it
  runs under**. The bundle patch disables the base bash executor
  (`bash-sandbox`) and the host bash tool (`tool-bash`), mounts the fish
  executor and the host-global `fish` tool, and leaves presets untouched —
  it no longer changes the roster default, injects preset roots, or writes
  copies under `$DSH_HOME/.agent-presets/`. Presets still register their own
  `bash`-named tool (standard/minimal do), and on `agent/created` (and again
  on every `tools/change`, i.e. after `/preset` recomposes) the policy hides
  that inherited bash tool per agent via
  `agent.ctx.tools.restrict({ deny: ['bash'] })` and shadows the preset's
  static `tool:bash` prompt guidance with an empty agent-scoped section. The
  agent is left with exactly one shell tool: `fish`. Under `minimal` — whose
  standing bash is the persistent PTY form (parameters carry only `command`,
  output schema is a plain string) — the policy first registers a persistent
  `fish` tool at the agent scope (shadowing the one-shot fish) and then
  hides bash, so minimal sessions keep their persistent semantics in fish.
- **Persistent fish terminal backend** (`terminal-fish.js`, exported as
  `@banbolee/dsh-fish-shell/terminal-fish`): a library — NOT mounted by the
  bundle patch — providing the `fish` PTY backend used by the persistent
  tool. It subclasses the official `BashTerminalBackend`, spawning
  `fish --no-config -i` (config-overridable) with a controlled prompt that
  speaks the harness readiness contract (OSC `133;D;<status>` + `dsh> `),
  confined through the same sandbox policy, with the official
  sandbox-mode fence copied in (the official module does not export it;
  the copy takes an injectable owner-activity check for self-managed use).
  The patch deliberately has no `fish-terminal` host row: the `terminals`
  service is entry-local to the `minimal` preset's isolate realm and
  invisible at the host plane (headless / dsh-tui / composition test
  profiles), so such a row would stay pending forever. `apply` is exported
  for direct assembly and tests (or a composition that explicitly mounts the
  registry).
- **Persistent fish tool** (`persistent.js`, exported as
  `@banbolee/dsh-fish-shell/persistent`): a fish translation of the official
  `dsh-tool-bash-persistent` pattern — a per-agent cached PTY shell whose
  cwd, variables, and functions survive across calls, with marker-wrapped
  commands, serialized execution, deadline/timeout reset, and scrollback
  reads. It deliberately exports no Cordis `apply`: `policy.js` calls
  `registerPersistentFish(ctx, agentCtx)` at the agent boundary for the
  persistent-bash preset. The PTY is **self-managed**: the tool owns one
  `FishTerminalBackend` instance and drives its sessions directly
  (`backend.spawn(...)`, `session.startSend/read/status/close`) instead of
  going through the `terminals` registry, which agent-scope tools cannot
  resolve (the registry lives only inside the minimal preset's entry-local
  realm). Command quoting uses fish single-quote escaping and `eval` with
  one string argument (fish 4 has no `$'...'` ANSI-C quoting and no
  `eval --`), verified against real fish 4.0.0.
- **Interactive terminal sessions** (`terminal-tools.js`, exported as
  `@banbolee/dsh-fish-shell/terminal-tools`): the `terminalTools: 'allow' |
  'deny'` switch for the interactive (L2) surface, whose patch group mounts the
  official `@deepseek-ai/dsh-terminal` registry, this bundle's `terminal.js`
  (the official `@deepseek-ai/dsh-terminal-bash` backend driven with fish argv,
  plus the harness home contract in the PTY child environment), and the
  official `@deepseek-ai/dsh-tool-terminal` (six `terminal_*` tools). See
  **Interactive terminal sessions (L2)** below.

## Support matrix

| Item | Supported | Verified |
|---|---|---|
| `@deepseek-ai/*` dsh family | `0.2.0-rc.1` — the exact pins live in the repository root `package.json` (`pnpm.overrides`) | yes: real isolated profiles in the S0 probe runs |
| `fish` | `3.7+` | yes on `3.7.1`; lower versions are unverified |
| Platform | POSIX only: Linux and macOS. Windows is not supported (the `pwsh` family covers it) | Linux: the real lane with `DSH_REAL_FISH_PTY=1` in the `test` job; macOS: the `fish-pty-macos` job runs the real L2 lane, including the `workspace-write` denial outside the workspace |
| Node.js | `>=22` (`engines.node`) | yes |

## Test coverage matrix

The promises above are only as good as the lanes that assert them. These are
the lanes, what they boot, and what they cover:

| Lane | Boots | Covers |
|---|---|---|
| `plugins/fish-shell/tests/terminal-session-real.spec.ts` | a real isolated `dsh-base` profile, through the `dsh` CLI | six tools; `open`/`send`/`read`/`close`; `terminal_signal`; a background `terminal_send` job with `job_output`/`job_kill`; the mode-switch fence; the `workspace-write` denial outside the workspace; the `read-only` semantics; owner isolation (`FOREIGN_SESSION`); the harness home contract (the session's `$DSH_HOME` is the profile's own home, a nested `dsh --profile <profile> --dump-config` composes that profile, and the same command under a foreign home fails) |
| `tests/composition/fish-pty-dsh-tui.spec.ts` | a real `dsh-tui` composition | the bundle group activates (no pending L2 rows); six tools visible; `open`/`send`/`read`/`close` |
| `tests/composition/fish-pty-minimal.spec.ts` | the official `minimal` preset over `dsh-base` | two `terminals` realms (host fish group + preset `/bin/bash` persistent shell); six tools exactly once; the persistent-fish swap; `open`/`send`/`read`/`close` |
| `tests/composition/fish-pty-bundled-row.spec.ts` | a profile patch that references `@deepseek-ai/dsh-tool-terminal` directly | resolution from inside this bundle only; the row stays `pending (waiting for service: terminals)`; no second registration; the surviving registration still drives a PTY |
| `scripts/qa/fish-packed-offline.mjs` | a packed tarball installed into a temporary profile with `--offline` | the install succeeds and really loads: six tools visible, `listBackends()` non-empty |

CI runs the real lane in the `test` job (Linux) and in `fish-pty-macos`
(macOS), the composition lanes in the `composition` job, and the packed/offline
lane in `fish-packed-offline`.

## Install

**From npm (recommended)** — no clone needed:

```sh
dsh plugin --profile <name> add @banbolee/dsh-fish-shell
```

From this checkout, per profile:

```sh
dsh plugin --profile <name> add ./plugins/fish-shell
```

Add it to every profile that should run fish (dsh-tui, web, headless, …) —
remembering the envelope above: `dsh-base`-class profiles, the `dsh-tui`
composition and the official `minimal` preset are verified today, every other
preset/profile combination is unverified (see **Known Limitations**). The
bundle patch
(`cordis.patch.yml`) is one safe patch across surfaces: it disables the host
bash executor and `tool-bash` rows, mounts the fish executor and the
host-global `fish` tool, and inserts the `fish-preset-policy` row, which hides
the preset-inherited `bash` tool per agent (restriction + empty `tool:bash`
prompt shadow, persistent-fish swap under `minimal`). It also appends the
`fish-terminal-group` for interactive terminal sessions (see **Interactive
terminal sessions (L2)** below). The patch no longer touches the preset roster.

### Deployed copy and the symlink chain

The executors subclass `@deepseek-ai/dsh-bash-local` /
`@deepseek-ai/dsh-bash-sandbox`. Those imports must resolve to the same
runtime instance the harness uses — the launcher-maintained
`profiles/node_modules/@deepseek-ai/*` symlink chain. A plain `link:` to this
checkout (outside the profile tree) would resolve no `@deepseek-ai` package,
so the deployed copy lives at `profiles/node_modules/@banbolee/dsh-fish-shell` (inside
the tree). `scripts/sync-to-profile.sh <profile>` packs the plugin with the hoisted
linker (`pnpm install --prod --config.node-linker=hoisted` then
`pnpm pack --config.node-linker=hoisted`) and installs the resulting tarball
into the profile with
`dsh plugin --profile <profile> add -w <tgz> --offline --config.auto-install-peers=false`.
A pnpm `file:` dependency points each profile at the deployed copy. A
package published to npm installs normally (its realpath already lies inside
the profile tree).

### Release and provenance

Releases are expected to ship with **npm provenance**: `publishConfig` carries
`provenance: true`, so publishing works from an OIDC-capable CI (GitHub
Actions), or with an explicit
`npm publish --provenance --access public`. A local publish has no OIDC
provider to attest the build, so a maintainer releasing from a workstation
has to turn provenance off for that one run with `--no-provenance`. **2FA is a
release prerequisite** — provenance does not replace it and npm checks it on
the account/organization side, which this repository cannot verify. Before
publishing, turn the `[Unreleased]` section of `CHANGELOG.md` into the version
being released (this `0.8.0` cut did exactly that).

## Interactive terminal sessions (L2)

Next to the one-shot `fish` tool, the bundle mounts an interactive terminal
surface: a real fish PTY the model drives with `terminal_open`,
`terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close` and
`terminal_list`. It reuses the official terminal stack: the backend row mounts
`terminal.js`, a subclass of the official `BashTerminalBackend` whose only
difference is the harness home contract in the child environment (**The harness
home contract** below). `spawn()` is inherited, so argv confinement, the
sandbox-mode fence and `session.initialize()` readiness are the official
code.

The patch appends one `insert` group, `fish-terminal-group`, at the end of
`cordis.patch.yml`:

| Row id | Package | Config |
|---|---|---|
| `pty` | `@deepseek-ai/dsh-terminal` | — |
| `terminal-fish-pty` | `@banbolee/dsh-fish-shell/terminal` | `shellPath: fish`, `shellArgs: ["--no-config","-i","-C", <FISH_PROMPT_SETUP>]`, `timeoutMs: 300000` |
| `terminal-tools` | `@deepseek-ai/dsh-tool-terminal` | — |
| `fish-terminal-tools` | `@banbolee/dsh-fish-shell/terminal-tools` | `terminalTools: allow` |

The group row is `cordis:group` with `group: true` and
`isolate: { terminals: true }`: the `terminals` service has to be self-contained
inside the group, because a host-plane row would stay pending in every profile
whose host plane has no `terminals` service. `tools` is deliberately **not**
isolated, so the six `terminal_*` tools registered by `terminal-tools` land in
the host tool registry and are visible to agents.

The prompt setup travels in the `-C` argument (the same `FISH_PROMPT_SETUP`
string that `terminal-fish.js` exports): startup submits nothing, so the motd
stays clean, whereas feeding the same setup through PTY input gets it echoed
back by the fish line editor.

**The harness home contract.** `terminal.js` exists for exactly one reason: a
PTY child's environment is the backend overlay plus `scrubbedParentEnv()`,
which drops every inherited `DSH_*` name, so a `dsh` nested inside an
interactive session used to resolve the default `~/.dsh` while the one-shot
`fish` tool ran on the real harness home. The subclass adds `DSH_HOME` — and
`DSH_PROFILE` / `DSH_PROFILE_DIR` when the context carries them — from the SAME
registry the one-shot tool reads, `ctx.shellEnv.collect()`, through the official
constructor's public `spawnTerminal` seam (the layer the subprocess provider
applies after the ambient scrub). The snapshot is taken at spawn time because
the three home facts are execution-independent: `collect` only reads the
execution to add `DSH_SESSION_ID`, so the session facts (`DSH_SHELL`,
`DSH_SESSION_ID`, `DSH_PTY_SESSION_ID`) stay the official overlay's own values.
Nothing else differs: the config surface is the official schema re-exported
verbatim (`Config`), so `backendType` keeps its `shell` default, which is what
`listBackends()` reports and `terminal_open { type: 'shell' }` opens. The
overlay has exactly ONE source per mounted state: when the registry is not
mounted at all (a custom composition outside `dsh-base`) the same facts come
from their public owners — `resolveDshHome()` and `ctx.get('profileContext')`,
which are the registry's own sources — while a mounted registry is
authoritative, so a `collect` error propagates (like the one-shot path) instead
of silently resolving another home, and a key its snapshot does not declare
stays undeclared instead of being borrowed from the ambient environment.
**Maintenance note:** the row is ours only
because the official row exposes no `env` config field; if
`@deepseek-ai/dsh-terminal-bash` grows one, the row goes back to the official
package and `terminal.js` is deleted.

`fish-terminal-tools` is the only entry this plugin adds for the surface: the
`terminalTools` switch implemented in `terminal-tools.js`. Its default is
`allow` (do nothing, matching every other tool in the deployment); `deny` takes
the six tools away per agent — see **Security model**.

**Why the one-shot path is untouched.** The appended group is purely additive.
The host-plane rows above it stay byte-identical (`bash-sandbox`/`tool-bash`
disabled, `fish-shell`/`tool-fish`/`fish-preset-policy` inserted), and
`ctx.shell` (`index.js`), the one-shot `fish` tool (`tool.js`), the `minimal`
preset's persistent tool (`persistent.js`) and the `terminal-fish.js` library
keep their exact code paths: nothing about a one-shot command changes because
an interactive surface exists.

**The bundled `@deepseek-ai/dsh-tool-terminal`.** The `terminal-tools` row
resolves the official tool package from inside this package, not from the
profile plane: `@deepseek-ai/dsh-tool-terminal@0.2.0-rc.1` is declared in
`dependencies` and `bundledDependencies`, so packing ships it, and its
transitive dependencies, as real files under `node_modules/` inside the
tarball. That is what makes an offline profile install work. It must not be
moved to `peerDependencies`: peer resolution would look for a profile-plane
copy, which is exactly what this design avoids. Versions, origins and licenses
are listed in `./THIRD-PARTY-NOTICES.md`.

## Security model

- **Default: `terminalTools: 'allow'`.** The interactive surface is on by
  default, exactly like every other tool the deployment mounts; a fish profile
  with this bundle installed behaves like any other profile that has the
  official terminal tools. `deny` is the opt-out: set the
  `fish-terminal-tools` row's config to `terminalTools: deny`, and at
  `agent/created`, and again on every `tools/change`, the policy restricts the
  six names per agent through the official
  `agent.ctx.tools.restrict({ deny: [...] })`. The names are
  enumerated one by one (never a `terminal_*` wildcard), so an upstream seventh
  tool cannot silently pass the policy.
- **The six tools**: `terminal_open`, `terminal_send`, `terminal_read`,
  `terminal_signal`, `terminal_close`, `terminal_list`.
- **No privilege escalation.** This plugin registers no tool of its own, wraps
  or replaces no host object, monkey-patches nothing, and offers no
  sudo/elevation entry point. A session process is `fish` running with the
  permissions of the user that launched the profile.
- **Sandbox inheritance.** Confinement is the host's: a `workspace-write`
  profile fences the interactive session through the same sandbox backend as
  any other command (measured: a write to `/etc` is denied). The plugin does
  not bypass the fence and caches nothing outside the sandbox.
- **Secret handling and audit are bounded** — **Known Limitations** below
  states the hidden-input boundary, the unsupported interaction surface and the
  best-effort audit scope.

## Per-surface behavior

- **Preset-roster surfaces** (dsh-tui, web): the roster default is untouched
  (`standard`). The `fish-preset-policy` plugin applies per agent, so an
  agent under **any** preset — `standard`, `ptc`, `cordis`, `minimal`, or a
  plain third-party preset — has its preset-inherited `bash` tool hidden and
  sees exactly one shell tool: `fish`. The preset's static
  `tool:bash` prompt guidance is shadowed (empty agent-scoped section), so
  the model is not told to "check the bash result". Under `minimal` the
  policy detects the preset's persistent bash and swaps in the persistent
  `fish` tool instead, so minimal sessions keep their persistent semantics.
  The persistent PTY is self-managed by the policy (one `FishTerminalBackend`
  driven directly, no `terminals` registry), so it works in every surface —
  the registry is only visible inside the minimal preset's entry-local
  realm, which is exactly why the bundle mounts no `fish-terminal` row.
- **Host-tool surfaces** (headless): the agent uses host-plane tools; the
  disabled host `tool-bash` and the host-global `fish` tool make fish the
  agent's only shell tool.

## Behavior

- **One-shot** (standard, ptc, cordis, third-party presets, and headless):
  every shell call spawns a fresh non-login shell (under the configured
  sandbox backend for `FishSandboxExecutor`); no state (cwd, variables,
  functions, history) persists between calls.
- **Persistent** (`minimal` preset, which mounts the persistent PTY bash
  machinery): the agent's `fish` tool keeps one live fish session per agent.
  The current directory, exported variables, and defined functions survive
  across calls; commands run through the tool are serialized; a command that
  exceeds the tool's deadline is interrupted and the shell is reset (the
  next call starts from the workspace with a fresh shell). The persistent
  fish PTY is spawned and driven by the tool itself through a
  `FishTerminalBackend` (no `terminals` registry involved).
- Output is bounded per stream by the executor's configured caps; timeouts
  are clamped to the executor's cap; the model sees the harness marker
  contract.
- `run_in_background: true` starts long-running commands as background jobs
  (`kind: fish`) and returns a job id immediately; read output with
  `job_output` and stop it with `job_kill`. A background job arms **no
  deadline** (the tool resolves it with `onExpiry: 'none'`, matching 0.1.5's
  `start()` and the official `dsh-tool-bash`): it runs until `job_kill`,
  cancellation, or composition teardown. Requires the jobs services
  (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`) to be composed;
  the tool fails loud when they are not. Killing a job while it is still
  running is verified by the real PTY lane
  (`plugins/fish-shell/tests/terminal-session-real.spec.ts`): `job_output`
  reads a live `terminal_send` job and `job_kill` settles it to the terminal
  `killed` status.
- Under a sandboxing executor, a denied command can be re-run wider in the
  same turn with `sandbox_permissions` (the narrowest wider mode that
  suffices) plus a one-sentence `justification`; the approval prompt raised
  by that retry is how the user consents. Denials are final when approval
  prompts are disabled or the escalation is rejected.
- Requires `fish` on PATH; the executors fail loud when it is missing.

## Known Limitations

- Models default to bash idioms; the `fish` tool description teaches fish
  syntax, but a command written in bash dialect fails under fish. This is the
  intended trade of swapping the shell.
- **The legacy bundled `fish` agent preset was removed**: this bundle ships
  no `presets/fish/` directory, the sync script no longer deploys or
  drift-checks one, and no user copy is written under
  `$DSH_HOME/.agent-presets/fish`. A stale user copy of that directory from
  an older bundle version is inert (the roster no longer points at it) and
  can be deleted manually.
- **Persistent semantics under `minimal`** are provided by the persistent
  `fish` tool (cwd, exported variables, and defined functions survive across
  calls). Like the official persistent bash, a command that overruns the
  deadline is interrupted and the shell is reset; an agent-scoped `fish`
  tool shadows the host-global one-shot tool, so escalation fields
  (`sandbox_permissions`/`justification`) and background execution
  (`run_in_background`) are not part of the persistent surface.
- **Third-party preset boundaries**: the policy hides a `bash`-named tool
  inherited from the preset. A preset that deliberately excludes the global
  `fish` tool (an allowlist that filters it out) or registers its shell tool
  under a different name is left exactly as authored, with a one-time
  warning per agent — the bundle never mutates a third-party preset.
- The `fish` tool's model-facing surface is aligned with the official bash
  tool: background execution (`run_in_background` via `ctx.jobs`), sandbox
  escalation (`sandbox_permissions`/`justification` via `ctx.approval`),
  terminal/generic UI presentation, and the `tool:fish` exit-code prompt
  section are all supported.
- **Secrets: only true hidden input is hidden.** A command line, an argument or
  a `terminal_send` payload is public to the session: the fish line editor
  echoes what it receives and the session keeps the scrollback, so anything
  that entered non-hidden can be read back by `terminal_read`. Never pass a
  secret as a command argument or through `terminal_send`; a real hidden read
  (`read -s` in fish) is the only supported way to keep text out of the echoed
  stream. `stty -echo` is **not** a mitigation: fish's line editor repaints and
  the sentinel stays in the scrollback (measured).
- **Audit is best-effort, not a lifecycle guarantee.** The plugin observes only
  what the model's explicit `terminal_open`/`terminal_close` calls expose
  (session id, PID, status transitions). It does **not** cover host-side
  reclamation, timeout kills, a process exiting on its own, other agents' or
  owners' sessions, or the group's `terminals` realm internals (invisible at
  the host plane). There is no full-lifecycle promise: the official
  `TerminalSessionService` exposes no open/exit/dispose events, and the plugin
  does not invent an audit surface of its own.
- **Text interaction only.** `resize`, named keys (arrow keys, named Ctrl
  combinations), full-screen TUIs (`vim`, `htop`) and `TERM=dumb`-style
  degraded terminals are not supported by the official session API; supporting
  them would require a plugin-owned backend, which is out of scope.
- **Verified L2 behaviors.** Each of these was an open question when the
  interactive surface was first documented; each now has a lane that asserts the
  recorded behavior (the lane index is **Test coverage matrix**):
  - **Preset compositions.** Two `terminals` realms coexist under the official
    `minimal` preset — the host L2 group's (fish) and the preset's own
    persistent-shell group's (`/bin/bash`) — and each of the six `terminal_*`
    tools is visible to the preset-bound agent exactly once; the `dsh-tui`
    composition mounts the same group and drives `open`/`send`/`read`/`close`
    (`tests/composition/fish-pty-minimal.spec.ts`,
    `tests/composition/fish-pty-dsh-tui.spec.ts`).
  - **Mode switch with a live session.** The standing-policy switch is refused
    synchronously with `cannot change sandbox mode … while persistent terminal
    sessions are open`: the mode event is not committed, the effective mode is
    unchanged, the live session keeps working, and the same switch succeeds once
    the session is closed
    (`plugins/fish-shell/tests/terminal-session-real.spec.ts`).
  - **`read-only` mode.** `read-only` is a file-effect mode, not a capability
    gate: the six tools stay visible and the PTY still spawns (motd `dsh>`), but
    the resolved policy has no writable root at all, so even a write inside the
    session workspace is denied — the workspace is not a write boundary under
    `read-only` (same lane).
  - **Cross-agent owner isolation.** A second agent in the same profile sees an
    empty `terminal_list` and cannot read, write or close the first agent's
    session: the tool error is `belongs to another agent` and the registry code
    behind it is `FOREIGN_SESSION`, while the owner's session survives untouched
    (same lane).
  - **A profile patch referencing the bundled package directly.** The name
    resolves from inside this bundle only
    (`…/@banbolee/dsh-fish-shell/node_modules/@deepseek-ai/dsh-tool-terminal`),
    never from the dsh installation; resolution is not activation — because the
    group isolates `terminals`, that row stays
    `pending (waiting for service: terminals)`, so the six tools are never
    registered twice, and the boot reports the pending row on stderr instead of
    swallowing it (`tests/composition/fish-pty-bundled-row.spec.ts`).
- **Unverified (do not read as supported)**:
  - the `FishTerminalBackend` submitted-setup path converging on fish 3.7.1:
    that library is not mounted by the patch, so the L2 surface is unaffected,
    and the legacy persistent path keeps its own specs;
  - a first install in a fully offline, cold-store environment: the packed lane
    (`scripts/qa/fish-packed-offline.mjs`) installs with `--offline`, but its
    store was warmed by the repository install first.
- POSIX only: the `fish` binary and the underlying process-group semantics
  are not available on Windows (the pwsh family covers Windows).

## Troubleshooting

### `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/dsh-tool-terminal`

The bundled tool package did not make it into the installed package, or it was
resolved as a peer (profile-plane) dependency. Build with the hoisted linker:
`pnpm install --prod --config.node-linker=hoisted` and then
`pnpm pack --config.node-linker=hoisted`. Without it pnpm refuses to pack a
bundled dependency and fails with
`ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED`. Check the artefact: the
tarball must contain
`package/node_modules/@deepseek-ai/dsh-tool-terminal/package.json`. One
upstream cause is not ours to fix: `@deepseek-ai/dsh-tool-terminal@0.2.0-rc.1`
declares `exports` entries for `./src/*` that the published tarball does not
contain, so anything resolving through that subpath fails with
`ERR_MODULE_NOT_FOUND`.

### `ERR_PNPM_NO_OFFLINE_TARBALL`

The offline install ran against a cold pnpm store: with `--offline`, pnpm
refuses to go to the network for a tarball it has not cached. Warm the store
once with a networked install (or run the same `dsh plugin ... add` without
`--offline` for the first install), then re-run the offline command. The
plugin's own runtime dependency travels inside the plugin tarball, so this is a
store-state problem, not a missing bundled file.

### Nested `dsh` inside an interactive session

As of this bundle the session carries the harness home contract: its child
environment gets `DSH_HOME` (plus `DSH_PROFILE` / `DSH_PROFILE_DIR` when the
profile context has them) from the same `ctx.shellEnv` registry the one-shot
`fish` tool reads, so the two surfaces cannot drift — **The harness home
contract** above says where and why. The real lane asserts the outcome: inside a
session `echo $DSH_HOME` prints the profile's own home, and
`dsh --profile <profile> --dump-config` composes that profile's tree, while the
same command under a foreign `DSH_HOME` fails. A nested `dsh` therefore starts
on the same home and the same plugin set as the session it was opened in.

Older bundles — and any deployment whose `terminal-fish-pty` row is still the
official `@deepseek-ai/dsh-terminal-bash` — have no such contract, and there was
no config-only fix for them: that row exposes no `env` config field, so an
`env:` written on it was accepted by the schema and silently ignored, and the
backend's `childEnvironment()` is module-private. A nested `dsh` there resolved
`~/.dsh`, which can hold profile and plugin state from an older release — a
stale plugin there can fail the nested boot or disable its rows. Pass the home
explicitly — replace `/path/to/dsh-home` with the Harness home the outer session
was launched with (a one-shot `fish` call prints it: `echo $DSH_HOME`):

```
env -u DSH_SESSION_ID -u DSH_PTY_SESSION_ID -u DSH_SHELL -u DSH_PERMISSION_MODE DSH_HOME=/path/to/dsh-home dsh --profile <profile>
```

**Maintenance note.** Owning the row (`terminal.js`) is the only reason the
contract can be added without editing the official package; if
`@deepseek-ai/dsh-terminal-bash` grows an `env` config field (or the registry
forwards the home facts itself), the row goes back to the official package,
`terminal.js` is deleted, and only the first paragraph of this entry remains —
the real lane keeps its assertions either way. That retirement also has to
update the `NESTED_DSH_ENTRY` contract in
`tests/docs-shape-fish-shell.spec.ts`, which names this module.
