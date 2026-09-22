# @banbolee/dsh-agents

[中文](./README.md) | **English**

Define your own agent team in YAML and delegate explicitly inside DSH through **named tools** (`agent_<id>`). This bundle takes over the Web `agent-presets` seat or the dsh-tui `dsh-tui-agent-presets` seat, mounts the shipped presets together with the compiled user main agents onto the roster, and adds a settings card under Plugin Configuration.

The full design and decision record lives in [`docs/agents-plugin-plan.md`](../../docs/agents-plugin-plan.md).

## Current status

Stages 1–4 of plan §16 are complete, and the Gate A–E platform probes are green:

- **Host assembly**: reads the built-in catalog (`catalog/*.yaml`, 7 agents) and the user catalog (`$DSH_HOME/banbo-agents/agents/*.yaml`), merges under constraints, and validates the whole graph; compiles user main agents into an **immutable generation** activated by an atomic `current` pointer; writes the ABI manifest that protects published `toolName` / `presetId` / main-child shape / `child.continuation`.
- **Personas**: user `prompts/` wins, shipped `prompts/` is the fallback; strict UTF-8, dual size caps, single trailing-newline normalization.
- **Delegation runtime**: `agent_<id>`, `delegate_batch`, the authorisation graph and absolute-depth checks, root-Session concurrency budget, one-shot/continuable lifecycle, HolderRegistry, and structured privacy-safe logging.
- **CatalogRemote**: a read-only, startup-static catalog view (no persona, paths, composition, or settings) with Host/client descriptors produced by the official Typert generator.
- **Web settings card**: the official `settings.plugin.item` seat (key `banbo-agents`) reads the catalog through the strict Typert Remote and reads/writes enabled/model through the official `settingsScope`.

## Install

```sh
dsh plugin --profile <profile> add @banbolee/dsh-agents
```

From source:

```sh
dsh plugin --profile <profile> add -w ./plugins/agents
```

Restart the profile afterwards: catalog and generation complete before the Host reports ready, so a broken configuration fails startup and names the file.

### Roster ownership compatibility

One package supports the different roster row ids of DSH Web `0.1.5-rc.2` and dsh-tui `0.10.2`. Because Cordis warns and skips a patch target that does not exist, every start shows **one expected warning**: Web reports the missing `dsh-tui-agent-presets`, TUI reports the missing `agent-presets`, and the row that does match still activates.

This bundle owns a roster seat: it is incompatible with another bundle covering the same Web/TUI roster seat unless you merge the full `roots` by hand. The Host checks the package and generated roots and fails loud rather than silently accepting an override.

## The team

Seven agents ship built in. A `main` form appears in the official Session preset picker; a `child` form is reachable only through a named delegation tool.

| Agent | Forms | Continuation | May delegate to | maxDepth |
|---|---|---|---|---|
| `banbo` | main | — | planner, research, explorer, implement, review, executor | 2 |
| `planner` | main + child | optional | research, explorer, review | 1 |
| `executor` | child | optional | research, explorer, implement, review | — |
| `implement` | child | optional | research, explorer | — |
| `review` | child | optional | research, explorer | — |
| `research` | child | one-shot | — | — |
| `explorer` | child | one-shot | — | — |

`maxDepth` is an **absolute** cap, not a relative level count. `banbo`'s 2 allows `Banbo → Executor → Implement`, and `Implement` cannot delegate a third level.

## Delegation semantics

- **Foreground (default)**: wait when the next step depends on the child's result or would edit the same file.
- **Background**: use `run_in_background: true` only when genuinely independent, non-conflicting work exists.
- **Batch**: use `delegate_batch` when several independent one-shot results must all return before continuing. A batch rejects agents that need to keep a conversation.
- **One-shot**: `research` / `explorer` are one-shot; no continuable session survives settlement, so a reuse-style instruction never gets a second delivery.
- **Continuable**: an `optional`-continuation child is still one-shot when called in the foreground; only a background call keeps it continuable. To continue one expert with its context, use `list_agents` to find an idle continuable child and reuse it with `send_message`.

A child may deliver the same conclusion **twice**, as a direct message and as a settlement notice; treat both as one completion keyed by `childId`, and do not act twice.

## Partial states and concurrency

- A `deadline` that expires yields `partial_timeout`: continue from the partial result.
- Neither `cancel_requested` nor `cleanup_deferred` means the work completed.
- **Concurrency limits fail fast**: when the root Session budget is exhausted, a new delegation fails immediately with the reason and a repair path. Nothing is queued and nothing degrades silently.
- The concurrency count does **not** survive a restart: the budget starts at zero and prior usage is not re-counted.

## Personas and overrides

Built-in personas are split by runtime form and always carry the eight sections `Role`, `Responsibilities`, `Non-goals`, `Tool Policy`, `Delegation Policy`, `Collaboration Protocol`, `Output Contract`, and `Failure Policy`. Lint checks them mechanically: unique headings, fixed order, non-empty sections, and no unauthorised tool name or generic delegation entry point.

Do not edit the shipped `prompts/`. Two override paths exist:

1. **Same-name automatic override**: put a file with the **same name** as a built-in into `$DSH_HOME/banbo-agents/prompts/`, for example `prompts/planner-child.md`. It overrides the shipped persona with no YAML change.
2. **Custom filename**: place the file, then reference it explicitly in a user agent YAML:

```yaml
main:
  persona: prompts/my-lead-main.md
```

Overrides obey the same UTF-8, 64 KiB per-file and total-size limits. Configuration changes take effect on the next profile start.

## Settings

On the Web side, **Plugin Configuration → `banbo-agents`** provides a settings card over the official `banbo-agents` settings namespace.

Editable:

- `includeDefaults`: enable every **built-in** agent (default on). User-defined agents are always enabled.
- Per-agent `enabled`: reversible deactivation without deleting a definition.
- The `model` of a `child` form: `{ provider, model, reasoningEffort? }` or `{ default: true }`.

Not editable (each with an explicit reason):

- **The model of a `main` form**: a main agent's model is owned solely by the official Session model selector. Writing a model for a main-only agent is rejected as `model-on-main-only`.
- **A retired agent**: shown read-only and cannot be re-enabled.

The card uses **staged edits plus a single commit**: changes first enter a draft, and submitting runs one `mutate` with the revision the card read. A stale revision keeps the draft and reports the conflict instead of overwriting someone else's change. Clearing a model uses a path-level `unset`, so sibling fields of the same agent are untouched.

Shape example:

```yaml
includeDefaults: true
agents:
  planner:
    enabled: false
  implement:
    model:
      provider: default-provider
      model: default-model
```

**Live state vs frozen descriptor**: `enabled` / `model` are live and apply to **newly created** children (a main agent's model still belongs to the official selector). The `persona` / `toolFilter` frozen into a continuable child's descriptor at creation is never rewritten by a later settings change; existing continuable children keep the composition they were created with. That is why `enabled: false` is preferred over deleting a definition, and why a retired agent keeps a same-named shell tool: a cold resume still has to name that tool inside its frozen `toolFilter`, or the official `tools.restrict()` throws.

## Data layout

```text
$DSH_HOME/banbo-agents/
├── agents/*.yaml              your agent definitions (the only directory you edit)
├── prompts/*.md               your personas; a same-named file overrides the shipped one
├── .generated/                Host-generated preset output; never edit by hand
│   ├── generations/<hash>/    one immutable generation: presets/ + abi.json + complete
│   └── current -> generations/<hash>   the atomically replaced pointer
└── .children/<childId>.json   identity sidecar of one continuable child
```

Only this bundle writes to and cleans `.generated/`, and it only removes directories carrying its own `complete` marker; anything else you put there is neither followed nor deleted. If pointer replacement fails, the **previous pointer stays exactly as it was**, compilation fails loudly, and no half-activated generation exists.

### Sidecar portability

One immutable JSON file per continuable child lives at `.children/<childId>.json`, keyed by `childId`. A write stages the content in a temp file and publishes it with an atomic **`link`** (create-if-absent): an existing record is **never overwritten** — byte-identical content counts as an idempotent retry, different content fails with `already-exists`. Filesystems without hard links fall back to a checked rename, which keeps the refusal semantics. Concurrent writes to different children touch different paths and cannot conflict. The content holds no absolute paths, so:

- backing up or migrating the whole `$DSH_HOME/banbo-agents/` directory preserves child identity;
- moving `DSH_HOME` while carrying that directory works the same way;
- deleting one sidecar only stops that child from being reused by identity and leaves the others alone.

## Uninstall and data retention

```sh
dsh plugin --profile <profile> remove @banbolee/dsh-agents
```

A normal uninstall **keeps** everything under `$DSH_HOME/banbo-agents/` (YAML, personas, generated presets, the ABI manifest, identity sidecars). Reinstalling restores the catalog, the retired shells, and the identity of old continuable children. Uninstalling only means the bundle no longer mounts at runtime and the official roster returns to its default.

## Destructive removal (irreversible)

Only a manual delete truly clears state:

```sh
rm -rf "$DSH_HOME/banbo-agents"
```

This removes YAML, personas, generated presets, the ABI manifest, and retired-shell records together. **Consequence of deleting the ABI manifest**: the `agent_<id>` names frozen into old continuable children's `toolFilter` disappear, and cold resume can no longer proceed.

## Three explicit non-promises

1. `send_message` reuse is **not exactly counted**: it is best-effort session reuse and does not promise how many times one child Session is reused.
2. The concurrency count does **not** survive a restart: the budget starts at zero and prior usage is not re-counted.
3. Deleting a `main`-form agent **invalidates its whole subtree** (including every continuable child beneath it, because cold resume needs a live direct parent Session). This is intended, not a defect.

Prefer `enabled: false` over deleting a definition file: deactivation can be undone at any time, while deletion retires the agent (taking its whole subtree with it when it has a `main` form). Restoring the same file revives it, but **change meaning under a new id**.

### Putting the YAML back revives the agent, on a new composition

Deleting a definition file **retires** that id: its generated preset directory goes away too, and old main sessions hit the official `agent-preset/not-found`. **Restoring a file with the same name and restarting revives the id** — the generated preset is rebuilt, the old session's preset resolves again, and it continues under current-policy resume semantics.

Know the boundary:

- **Upside**: after an accidental delete, putting the original file back is the natural recovery path.
- **Risk**: if the restored file has been **rewritten**, the old session continues on a new composition and its history may contain tool calls the new composition cannot make.
- **Recommendation**: change meaning under a **new id**, never by reusing an old one. A revived definition still obeys the ABI narrowing checks — it may not drop a published main/child form, change the preset id, or switch `continuation`; startup fails loudly if it tries.

## Web settings card and build

The Host Remote, the Typert descriptors, and the Web client all have build output, so source changes require a rebuild:

```sh
pnpm --filter @banbolee/dsh-agents build   # node scripts/build.mjs
```

The build:

1. clears `lib/` first;
2. calls the official Typert generator from a temporary workspace adapter, producing `lib/typert.host.*` and `lib/typert.remote-client.*`;
3. runs `tsc` for the Host Remote and the client types (`lib/types/**`);
4. runs `tsdown` for the single-file classic client bundle `lib/client.js` (a `window.__ModuleLoader__` factory, no code splitting).

Troubleshooting:

- **The settings card is missing**: confirm the build ran and `lib/client.js` exists in the profile, then refresh. The client registers the locale and slot only after the Remote mount and `list()` succeed; any failure rolls the whole startup back.
- **A persona/YAML change had no effect**: configuration applies on the **next profile start**; when the change targets an existing continuable child's frozen descriptor, create a new child.
- **Startup fails and names a file**: that is the intended fail-loud. Fix the YAML at the reported field; the previous generation and the `current` pointer stay untouched.
- **A missing-sibling warning appears**: see "Roster ownership compatibility" above; one per side is expected.

## Development

```sh
env NODE_ENV=development pnpm test                              # whole repo
env NODE_ENV=development npx vitest run --dir plugins/agents    # this bundle only
node scripts/build.mjs                                          # rebuild artifacts
```

Gate probes live under `tests/gates/`, separate from product unit tests:

```sh
env NODE_ENV=development npx vitest run --dir plugins/agents    # ordinary lane, this bundle
env NODE_ENV=development pnpm test:agents:gates                 # Gate + packed lane
```

`tests/packed.spec.ts` runs a real `npm pack` and asserts the published surface and pure-ESM imports; build once before running it.
