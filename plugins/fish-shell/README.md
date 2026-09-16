# @banbolee/dsh-fish-shell

Fish shell executors and tool for DeepSeek Harness: run commands with
**fish** instead of bash. Distribution-ready and surface-agnostic: works in
any profile that mounts it — preset-roster based (dsh-tui, web) or
host-tool based (headless) — and under **any agent preset** (standard, ptc,
cordis, minimal, or a third-party preset).

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
    output reads carry the lossy-read and sandbox runner-failure/denial
    notices, and the job controller's `job_output`/`job_kill` handle the rest.
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

## Install

**From npm (recommended)** — no clone needed:

```sh
dsh plugin --profile <name> add @banbolee/dsh-fish-shell
```

From this checkout, per profile:

```sh
dsh plugin --profile <name> add ./plugins/fish-shell
```

Add it to every profile that should run fish (dsh-tui, web, headless, …).
The bundle patch (`cordis.patch.yml`) is one safe patch across surfaces: it
disables the host bash executor and `tool-bash` rows, mounts the fish
executor and the host-global `fish` tool, and inserts the
`fish-preset-policy` row, which hides the preset-inherited `bash` tool per
agent (restriction + empty `tool:bash` prompt shadow, persistent-fish swap
under `minimal`). The patch no longer touches the preset roster.

### Deployed copy and the symlink chain

The executors subclass `@deepseek-ai/dsh-bash-local` /
`@deepseek-ai/dsh-bash-sandbox`. Those imports must resolve to the same
runtime instance the harness uses — the launcher-maintained
`profiles/node_modules/@deepseek-ai/*` symlink chain. A plain `link:` to this
checkout (outside the profile tree) would resolve no `@deepseek-ai` package,
so the deployed copy lives at `profiles/node_modules/@banbolee/dsh-fish-shell` (inside
the tree). `scripts/sync-to-profile.sh` copies the plugin there after edits.
A pnpm `file:` dependency points each profile at the deployed copy. A
package published to npm installs normally (its realpath already lies inside
the profile tree).

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
  `job_output` and stop it with `job_kill`. Requires the jobs services
  (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`) to be composed;
  the tool fails loud when they are not.
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
- POSIX only: the `fish` binary and the underlying process-group semantics
  are not available on Windows (the pwsh family covers Windows).
