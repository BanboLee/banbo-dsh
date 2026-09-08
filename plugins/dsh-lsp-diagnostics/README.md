# dsh-lsp-diagnostics

Host-plane Cordis bundle plugin for DeepSeek Harness: after an official
`write`/`edit`/`str_replace_editor` mutation lands inside the session
workspace, the tool result still succeeds and the next model inference carries
a single persistent LSP diagnostics plugin notice. It also registers the
model-callable `lsp_diagnostics(file_path)` tool for explicit diagnosis.

The plugin is a named namespace function plugin: it exports `name`, `inject`,
`Config`, and `apply`, and has no default export. The real Loader reads the
module namespace (`exports.default ?? exports`) and Cordis reads
`inject`/`Config` from the plugin object, so every public metadata field
survives installation. The plugin never modifies `deepseek-harness`, never
extends `ctx.lsp`, never imports `@deepseek-ai/*/src/*`, and never
monkey-patches official objects.

## Usage

Install the bundle into any DSH profile from the repository root. The
workspace-root flag `-w` is required: without it pnpm cannot resolve the local
package inside the profile's generated workspace.

```bash
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
```

To install into an isolated profile with a single command:

```bash
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
```

The sync helper requires `DSH_HOME` so tests and manual QA always target
isolated profile state, never the user's default Harness home.

The plugin registers one real three-parameter `tools/post-execute` waterfall
listener `(exec, _result, next)`: it calls `await next()` exactly once,
outside any plugin catch, and never consumes the `_result` placeholder.

## Config

All knobs ride through the plugin's `Config` schema with a strict validator.
Unknown keys, invalid JSON-representable values, invalid timers/caps, or any
deviation from the closed extension route fail loud at load time.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | With `enabled=false` the plugin creates zero collector, runtime, coordinator, or tool, registers zero tools/listeners/effects, and spawns zero processes. |
| `timeoutMs` | `5000` | Single non-extendable deadline for one post-execute aggregate. |
| `settleMs` | `200` | Quiet window; must be `< timeoutMs`. |
| `shutdownTimeoutMs` | `1000` | Graceful `shutdown`/`exit` budget. |
| `killGraceMs` | `500` | Process-tree TERM→KILL grace. |
| `maxDocumentBytes` | `2097152` | Hard UTF-8 byte cap for the document sent via `didOpen`. |
| `maxMessageBytes` | `4194304` | LSP message body cap. |
| `maxStderrBytes` | `16384` | Bounded stderr tail cap. |
| `maxDiagnostics` | `50` | Global cap on automatic diagnostic lines and per-call cap on the canonical direct-tool diagnostics array. |
| `maxResultChars` | `8000` | Unicode code-point cap on the final aggregate text. |
| `reportClean` | `true` | Whether explicit empty results render `Status: clean`. |
| `servers` | TypeScript + Go | Closed provider catalog; TypeScript and Go are enabled by default, while `clangd`, `rust`, and `python` are opt-in. |

The extension route is closed: `.ts` → typescript/typescript, `.tsx` →
typescript/typescriptreact, `.go` → go/go, `.c` → clangd/c,
`.cc`/`.cpp`/`.cxx` → clangd/cpp, `.h`/`.hh`/`.hpp`/`.hxx` → clangd/cpp,
`.rs` → rust/rust, and `.py`/`.pyi` → python/python; any other extension key,
missing canonical provider entry, cross-provider collision, or rewritten
language id fails loud at load time, while other extensions at runtime are
silently ignored.

The `servers` block is a provider-level partial overlay: omitting `servers` or
supplying `servers: {}` keeps exactly the TypeScript and Go defaults, while
supplying a known optional `clangd`, `rust`, or `python` key activates that
provider. For example, `servers: { go: { command: '/path/trae-gopls' } }`
changes only Go without requiring a TypeScript block. The legacy
`extensionToLanguage` field is accepted only when it exactly equals that
provider's canonical mapping; it never defines new routes.

Default commands are `typescript-language-server --stdio`, `gopls`, `clangd`,
`rust-analyzer`, and `pyright-langserver --stdio`. clangd, rust-analyzer, and
gopls receive no default arguments. Per-server `env`, `configuration`, and
`initializationOptions` may be overridden and must be JSON-representable.

## Behavior

Only a non-empty `session.header.cwd` that canonicalizes to a directory and
contains the target is eligible; missing or empty cwd, non-directory
canonicalization, and outside-workspace targets are ineligible and silently
ignored — never a `workspace unavailable` or `outside workspace` notice.
Workspace, cwd, and URI are always derived through the public `ctx.fs` API
(`resolve`/`stat`/`contains`/`targetKey`/`processPath`/`fileUrl`), never from
`displayPath` or the host `process.cwd()`.

Fail-open is plugin-owned post-processing failure only: after the downstream
`await next()` decision succeeded, a diagnostics error, missing or crashed
server, protocol failure, read error, or timeout never changes the decision or
result and never returns `kind: 'block'`. Caller abort is decided by the
ToolRuntime and downstream listeners; a caller abort is never swallowed,
rewritten, or promised to become a success by this plugin.

Freshness uses the post-write `FsVersion` plus an independent per-target
monotonic generation counter whose values are never reused within one plugin lifetime.
`retireIfCurrent` removes only the matching active marker (generation + version)
and never touches the counter. When a generation counter is exhausted the
plugin fails safe and every older candidate stays stale.

Eligible targets are ordered by the single shared comparator
`(renderPath, String(targetKey), canonicalUri)` compared by Unicode
code points, and the same order drives both diagnosis scheduling and
rendered sections — raw `displayPath` tuples, `localeCompare`, and
default UTF-16 sorts are never used.

One exec produces at most one aggregate notice with exactly one title
`[LSP diagnostics after write]`, one section per retained file, exactly one
blank line between sections, and no leading or trailing newline. After the
global `maxDiagnostics` count cap, a diagnostics file with zero retained lines
is omitted entirely, never leaving an empty section; clean and unavailable
sections do not consume the cap. Exactly one global advisory is appended,
separated by one blank line, only when at least one diagnostic line is
retained. The `maxResultChars` cap is applied only after the complete
canonical aggregate is built: the fixed marker `…(truncated)` replaces the
truncated suffix, and the output never exceeds the cap.

Documents are read with a bounded `ctx.fs.readBytes(target, signal,
maxDocumentBytes)` after a `stat.size` preflight, with strict UTF-8 decoding;
an unbounded `readText` is never used. A known size above the cap, or an unknown-size read that throws `FsError`
with `code === 'FS_TOO_LARGE'`, maps to `document too large`; any other read
error maps to `diagnostics unavailable`. The public seam guarantees a
successful `readBytes` is complete with `bytes.length <= maxDocumentBytes`;
the plugin never relies on or returns over-cap bytes.

`publishDiagnostics` is correlated exact-URI-first, then by document version;
only the consumed fields `range`, `severity`, `code`, `source`, and `message`
are validated, while standard optionals `tags`, `relatedInformation`,
`codeDescription`, `data` and unknown extension fields are safely ignored and
never enter the normalized schema or renderer. Positions are 0-based UTF-16
and render as 1-based start-end coordinates.

The coordinator owns both the active augment-operation registry and the
`retiredIo` late-final-stat registry. Unload quiesces in the exact order:
stop direct-tool admission → stop coordinator admission (which closes runtime
admission) → offTool → offPost → offObserved → abort coordinator operations →
abort direct-tool operations → await all active augment promises → await all
active direct-tool promises → await all `retiredIo` → `runtime.dispose()`.
Cleanup continues after individual failures and aggregates them; therefore no
direct call can race runtime disposal. Every operation's outermost `finally` clears the deadline timer and removes
the caller/cleanup relay listeners, leaving zero residue.

`stopAdmission()` only closes the gate and the runtime's own admission; it
never aborts operations. Active operations are aborted at the later abort
step, after both listener disposers have run, exactly as the documented order
states. A listener that already entered but is still blocked in downstream
`next()` has no plugin-owned cancellation seam, so cleanup tracks every such
invocation in a pending-invocation registry and awaits its settlement (it
takes and retires the exec's candidates before the downstream result or error
returns, including when `next()` throws synchronously). The deadline uses an
injected monotonic clock, never `Date.now()`, so wall-clock rollback cannot
extend a hard deadline.

Session teardown also owns the protocol write quiescence: every in-flight
server-request handler and the serialized write tail settle before cleanup
returns, and no new server-request handlers start while closing — so no queued
frame (responses, `shutdown`, `exit`) can be written after cleanup resolves.
A matching `publishDiagnostics` that races the `didOpen` write is buffered
until the open write succeeds; only a successfully written open generation
accepts notifications, and a failed `didOpen` write still allows the allowed
fresh-instance retry. The shared runtime applies a generic correctness-over-performance policy: it
still pools one provider/workspace session across distinct canonical URIs, but
before a URI already opened by that session is diagnosed again it evicts and
asynchronously retires the session, then opens the URI at version 1 in a fresh
process; this avoids provider VFS caches returning stale same-URI diagnostics,
and retired teardown remains tracked and drained on unload.

`timeoutMs` is a single non-extendable deadline for the whole post-execute;
the final freshness round is a one-shot final stat/deadline/generation gate.
The direct tool likewise captures one absolute deadline from its injected
monotonic clock, and every gate transitions to timeout when `now() >= deadlineAt`
even if event-loop starvation has not run the scheduled timer callback yet.
A deadline/caller/cleanup loss never waits for late final stats: unsettled
records are retired into `retiredIo` before the decision returns. Session
teardown is the single order: `shutdown` request → `exit` notification/
natural-close wait → conditional `handle.terminate()` (only while still alive)
→ await `handle.done` and `waitForExit()` → `processLifetimeController.abort()`;
`terminate()` is the only hard stop.

## Model Experience

`lsp_diagnostics(file_path)` is a model-callable, read-only tool for one
existing file that `ctx.fs` permits the session to read. It accepts a
workspace-relative or absolute path and uses every configured provider and the
closed extension route documented above. It has the same path authority as the
official `read` tool: the session cwd is only the LSP project root, so an
explicit direct call may diagnose a readable file outside that root. It never
creates, edits, or deletes a file. Invalid requests fail explicitly with
`file_path must be a non-empty string`, `session workspace cwd`, `session
workspace is not an existing directory`, `target does not exist`, `target is
not a regular file`, `no configured diagnostics provider`, or `target changed
during diagnosis`.

The direct tool has exactly three canonical outcomes: `diagnostics` with the
normalized list sorted by the same comparator as automatic rendering and sliced
to `maxDiagnostics` before ToolRuntime/PTC receives it, plus an always-present
nonnegative integer `omitted_diagnostics`; `no_diagnostics`, rendered as `No
diagnostics reported for this file snapshot.`; and `unavailable` with one closed
reason. The renderer preserves the omission marker from that canonical count.
Call it to
diagnose an existing file explicitly, especially after a shell command,
formatter, or generator bypasses automatic `fs/observed` feedback; avoid
redundant calls when fresh automatic feedback already exists. Automatic
post-write feedback remains the default after supported write/edit mutations,
while the direct tool is deliberate and reports path/workspace errors instead
of silently treating them as ineligible.

From the model's point of view each mutation tool (`write`, `edit`,
`str_replace_editor` create/str_replace/insert) returns its original result
unchanged; the plugin appends one bounded aggregate notice to
`decision.additionalContexts` for the next inference. A notice contains:

- one `File: <renderPath>` section per retained file — `- <severity>
  <startLine>:<startCharacter>-<endLine>:<endCharacter> source=... code=...
  message` lines for diagnostics, `Status: clean`, or `Status: diagnostics
  unavailable (<reason>)` — in the shared code-point order;
- exactly one global advisory when at least one diagnostic line is retained;
- nothing for unsupported extensions, ineligible workspaces, `enabled=false`,
  or sessions without a workspace.

Unavailable reasons are closed: `server not found`, `server crashed`,
`timeout`, `malformed response`, `document too large`, `diagnostics
unavailable`.

## Known Limitations and Deferred Work

- shell redirection, `sed -i`, scripts, formatters, generators, and external
  editors that bypass `ctx.fs`/`fs/observed` are out of scope for automatic
  feedback; the model may call `lsp_diagnostics(file_path)` afterward. There is no
  filesystem watcher and no project-root probing — the session cwd is the
  workspace root.
- For automatic feedback, agentless tool execution, missing/empty or
  non-directory cwd, and outside-workspace targets are silently out of scope
  and never produce a notice. Direct calls use official `read`-equivalent path
  authority instead: a readable file outside the session cwd is eligible, while
  that cwd remains the LSP project root.
- The plugin does not install or download `typescript-language-server`,
  `gopls`, `clangd`, `rust-analyzer`, or `pyright-langserver`; install requested
  executables yourself and configure their paths. A missing server fails open
  with `diagnostics unavailable (server not found)`.
- Portable deterministic tests use the repository fixture server and never use
  a real server or the network. The separate explicit real-server lane is
  opt-in, local-filesystem/process-only, and never installs or downloads tools.
- Implementation and tests use the `0.1.2-rc.1` dependency family; the peers
  `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-subprocess`,
  and `@deepseek-ai/dsh-tools` are `^0.1.2-rc.1`.

## Verification

Deterministic package-local tests (fixture server, no network, no real LSP
server, isolated temp workspaces/profiles):

```bash
pnpm exec vitest run plugins/dsh-lsp-diagnostics tests/package-shape.spec.ts
```

Documentation shape test (required sections and contract strings):

```bash
pnpm exec vitest run tests/docs-shape-lsp-diagnostics.spec.ts
```

Type check and sync script help:

```bash
pnpm dlx --package=typescript@6.0.3 tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit
bash scripts/sync-lsp-diagnostics-to-profile.sh --help
```

Explicit real-server verification is separate from portable coverage. It
requires `RUN_REAL_LSP_SERVERS=1`, a non-empty `REAL_LSP_PROVIDERS` list, an
explicit executable path for every requested provider, and an evidence path:

```bash
RUN_REAL_LSP_SERVERS=1 \
REAL_LSP_PROVIDERS=rust \
REAL_LSP_RUST_COMMAND=/data00/home/lixingxin/.cargo/bin/rust-analyzer \
REAL_LSP_EVIDENCE_PATH=/tmp/dsh-real-rust.json \
pnpm exec vitest run tests/composition/lsp-real-servers.spec.ts
```

The operator wrapper performs the same check:

```bash
node scripts/qa/run-lsp-real-servers.mjs \
  --providers rust \
  --rust-command /data00/home/lixingxin/.cargo/bin/rust-analyzer \
  --evidence /tmp/dsh-real-rust.json
```

Each requested provider must complete bad → diagnostic → repair → clean. The
JSON file is machine-readable evidence; a missing requested executable records
`status: "blocked"` and exits nonzero rather than skipping or passing.
