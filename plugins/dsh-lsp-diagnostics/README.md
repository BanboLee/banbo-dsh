# dsh-lsp-diagnostics

Host-plane Cordis bundle plugin for DeepSeek Harness: after an official
`write`/`edit`/`str_replace_editor` mutation lands inside the session
workspace, the tool result still succeeds and the next model inference carries
a single persistent LSP diagnostics plugin notice.

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
| `enabled` | `true` | With `enabled=false` the plugin creates zero collector, runtime, and coordinator, registers zero listeners/effects, and spawns zero processes. |
| `timeoutMs` | `5000` | Single non-extendable deadline for one post-execute aggregate. |
| `settleMs` | `200` | Quiet window; must be `< timeoutMs`. |
| `shutdownTimeoutMs` | `1000` | Graceful `shutdown`/`exit` budget. |
| `killGraceMs` | `500` | Process-tree TERM→KILL grace. |
| `maxDocumentBytes` | `2097152` | Hard UTF-8 byte cap for the document sent via `didOpen`. |
| `maxMessageBytes` | `4194304` | LSP message body cap. |
| `maxStderrBytes` | `16384` | Bounded stderr tail cap. |
| `maxDiagnostics` | `50` | Global cap on retained diagnostic lines. |
| `maxResultChars` | `8000` | Unicode code-point cap on the final aggregate text. |
| `reportClean` | `true` | Whether explicit empty results render `Status: clean`. |
| `servers` | fixed set | Exactly `typescript` and `go`, see below. |

The extension route is a closed set with exactly `.ts` → typescript/typescript,
`.tsx` → typescript/typescriptreact, and `.go` → go/go; any other
extension key, missing entry, duplicate normalized key, or rewritten language
id fails loud at load time; other extensions at runtime are silently ignored.
The `typescript` server defaults to `typescript-language-server --stdio` and
`go` to `gopls`; per-server `env`, `configuration`, and
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
stop admission → offPost → offObserved → abort coordinator operations → await all active augment promises → await all `retiredIo` → `runtime.dispose()`.
Every operation's outermost `finally` clears the deadline timer and removes
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
fresh-instance retry.

`timeoutMs` is a single non-extendable deadline for the whole post-execute;
the final freshness round is a one-shot final stat/deadline/generation gate.
A deadline/caller/cleanup loss never waits for late final stats: unsettled
records are retired into `retiredIo` before the decision returns. Session
teardown is the single order: `shutdown` request → `exit` notification/
natural-close wait → conditional `handle.terminate()` (only while still alive)
→ await `handle.done` and `waitForExit()` → `processLifetimeController.abort()`;
`terminate()` is the only hard stop.

## Model Experience

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
  editors that bypass `ctx.fs`/`fs/observed` are not covered; there is no
  filesystem watcher and no project-root probing — the session cwd is the
  workspace root.
- Agentless tool execution, missing/empty or non-directory cwd, and
  outside-workspace targets are silently out of scope; they never produce a
  notice of any kind.
- The plugin does not install or download `typescript-language-server` or
  `gopls`; install them yourself and make them available on PATH (or via the
  server `env`). A missing server fails open with `diagnostics unavailable
  (server not found)`; tests use the repository fixture server, never a real
  server or the network.
- Implementation and tests are pinned to `0.1.1-rc.2`; the peers
  `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-subprocess`,
  and `@deepseek-ai/dsh-tools` are `>=0.1.1-rc.2 <0.1.2-0`, and 0.1.2-* is not supported.

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
pnpm exec tsc -p plugins/dsh-lsp-diagnostics/tsconfig.json --noEmit
bash scripts/sync-lsp-diagnostics-to-profile.sh --help
```
