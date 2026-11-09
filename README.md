# banbo-dsh

[![CI](https://img.shields.io/github/actions/workflow/status/BanboLee/banbo-dsh/ci.yml?label=CI&logo=github)](https://github.com/BanboLee/banbo-dsh/actions/workflows/ci.yml)

**English** | [中文](./README.zh.md)

A collection of DeepSeek Harness (DSH) plugins: four maintained bundles published
on npm under `@banbolee/dsh-*`, plus two deprecated bundles frozen at 0.3.4.
The maintained bundles install into a DSH profile without cloning this MIT-licensed repository.

## Quick install (users)

Prerequisites: `dsh` 0.2.2-rc.1, `dsh-tui` 0.19.0 for TUI profiles, Node.js >= 24.9.0 (CI and upgrade QA use Node 26), pnpm 9.x.

Install whichever bundles you need:

```sh
dsh plugin --profile <profile> add @banbolee/dsh-rtk
dsh plugin --profile <profile> add @banbolee/dsh-fish-shell
dsh plugin --profile <profile> add @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> add @banbolee/dsh-agents
```

## Bundles

| Bundle | What it does | Binary it needs |
| --- | --- | --- |
| [`@banbolee/dsh-rtk`](plugins/rtk/README.md) | Decorates the mounted shell executor: every command is rewritten through the `rtk rewrite` oracle, and model-facing `grep` output is compressed via `rtk pipe` | `rtk` |
| [`@banbolee/dsh-fish-shell`](plugins/fish-shell/README.md) | Fish executors (sandboxed and local) plus a model-facing `fish` tool and a per-agent policy that swaps bash for fish under any agent preset | fish |
| [`@banbolee/dsh-lsp-diagnostics`](plugins/dsh-lsp-diagnostics/README.md) | After `write`/`edit`/`str_replace_editor` mutations, appends a persistent LSP diagnostics notice to the next model inference; also registers a model-callable `lsp_diagnostics(file_path)` tool | `typescript-language-server`, `gopls` (opt-in: `clangd`, `rust-analyzer`, `pyright-langserver`) |
| [`@banbolee/dsh-agents`](plugins/agents/README.md) | Define your own Agent team in YAML: named `agent_<id>` tools, a persona and a tool surface per Agent, an explicit delegation graph, and absolute depth/concurrency budgets; ships its presets as `@deepseek-ai/dsh-agent-preset` rows on the profile's preset registry | none |

**Deprecated / frozen at 0.3.4:** [`@banbolee/dsh-codegraph-mcp`](plugins/codegraph-mcp/README.md) and [`@banbolee/dsh-llm-pi-ai-with-session`](plugins/dsh-llm-pi-ai-with-session/README.md). Their source, legacy docs and tests remain for reference, but they are excluded from workspace installs, active tests, typechecks, upgrades and publication. Their DSH 0.2.1 baseline is not part of the DSH 0.2.2-rc.1 support boundary; do not add them to current profiles.

See each plugin README for full details.

## External dependencies (important — read before installing)

`rtk`, fish, and the LSP servers must be **pre-installed by you**;
the bundles never download or install them:

| Binary | Used by |
| --- | --- |
| `rtk` | `@banbolee/dsh-rtk` — **must be pre-installed** or rewrites/grep-compression fail open to passthrough |
| fish | `@banbolee/dsh-fish-shell` executors and tool |
| `typescript-language-server`, `gopls` (opt-in: `clangd`, `rust-analyzer`, `pyright-langserver`) | `@banbolee/dsh-lsp-diagnostics` automatic diagnostics |

Put the binaries on `PATH` (or pin them through the bundle config). A missing
binary never blocks install or tests — the affected feature fails open.

## Uninstall

```sh
dsh plugin --profile <profile> remove @banbolee/dsh-rtk
dsh plugin --profile <profile> remove @banbolee/dsh-codegraph-mcp
dsh plugin --profile <profile> remove @banbolee/dsh-fish-shell
dsh plugin --profile <profile> remove @banbolee/dsh-lsp-diagnostics
dsh plugin --profile <profile> remove @banbolee/dsh-llm-pi-ai-with-session
dsh plugin --profile <profile> remove @banbolee/dsh-agents
```

The two deprecated package names above may also be removed with `dsh plugin --profile <profile> remove <package>` from legacy profiles; no restart of existing sessions is required by this repository cutover.

> A normal uninstall of `@banbolee/dsh-agents` **keeps** your data
> (`$DSH_HOME/banbo-agents/`: YAML definitions, personas, the ABI manifest), so
> reinstalling restores it; the bundle simply stops being mounted at runtime and
> its preset rows go with it. A full wipe is an explicit destructive operation — see
> [plugins/agents/README.md](plugins/agents/README.md).

## Local development / install from source (contributors)

```sh
git clone git@github.com:BanboLee/banbo-dsh.git
cd banbo-dsh
env NODE_ENV=development pnpm install
```

Install into a profile from the repository root (the `-w` flag is required for
the local path installs below, otherwise pnpm fails with
`ERR_PNPM_ADDING_TO_ROOT`; `@banbolee/dsh-fish-shell` is the exception — no `-w`,
it has its own deploy-and-symlink story documented in its README):

```sh
dsh plugin --profile <profile> add -w ./plugins/rtk
dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics
dsh plugin --profile <profile> add -w ./plugins/agents
dsh plugin --profile <profile> add ./plugins/fish-shell
```

Only the four maintained directories participate in `pnpm install`, tests and
typecheck. Do not install the frozen directories into this rc.1 workspace.

Sync helpers for isolated profiles (they require `DSH_HOME` to point at isolated state):

```sh
DSH_HOME="$(mktemp -d)" scripts/sync-lsp-diagnostics-to-profile.sh <profile>
scripts/sync-to-profile.sh <profile>            # fish-shell: pack the bundle, then install the tarball
```

### Testing

```sh
env NODE_ENV=development pnpm test
```

`NODE_ENV=development` matters: with `NODE_ENV=production` pnpm skips
devDependencies entirely, which breaks installs and the dependency-graph
assertions. Per-bundle verification commands are documented in each plugin
README.

### Legacy headless E2E (frozen)

The CodeGraph-based `tests/e2e/**` sources remain as legacy evidence only.
They are excluded from active test discovery, CI and publication; the old
headless E2E npm script has been removed. The four maintained plugins are
covered by `pnpm test`, `pnpm test:composition`, and the G4–G6 DSH/TUI QA lane.

### Releasing (maintainers)

Releases go through one manual workflow, [`.github/workflows/release.yml`](./.github/workflows/release.yml),
and a dispatch releases **only the four maintained bundles at one commit**:

```sh
gh workflow run release.yml -f release_sha=<40-character SHA on main> -f dry_run=true
```

`dry_run` defaults to `true`: it packs and validates all four tarballs and uploads
the release journal without touching the registry. Set `dry_run=false` to
publish. The lane runs every deterministic gate first, then packs once, publishes
serially under the `next` candidate tag with `npm publish --provenance --access
public`, verifies each version's registry integrity, and only after all four
succeed promotes `latest`, removes the candidate tag, and creates four annotated
tags plus four GitHub Releases at the same commit. The two frozen packages are never packed or published by this lane.

Authentication is npm Trusted Publishing (OIDC, no long-lived secret); the
`id-token: write` permission is what signs provenance. Two things must be true on
npmjs.com for this to work: the Trusted Publisher has to authorise **both publish
and dist-tag** (the lane moves `latest` and removes the candidate tag with the same
OIDC identity), and the npm CLI has to be **11.21.0 or newer** — `publish` speaks
tokenless OIDC from 11.5.1, but `dist-tag` only from 11.21.0, so an older CLI would
publish all four versions and then fail at the first promotion. The workflow pins
that version and `preflight` refuses to start on anything older.

A published npm version is immutable, so a partial failure is **never** retried
blindly: the uploaded journal records what reached the registry. Re-dispatch with
`prior_run_id` and the journal is verified (same commit, tag and
versions) and resumed — already-published versions are skipped, `finalize` only
promotes what has not been promoted yet, and an existing GitHub Release is accepted
only when its tag, target and title match this dispatch.

## License

MIT — see [LICENSE](LICENSE).
