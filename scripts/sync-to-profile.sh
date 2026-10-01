#!/usr/bin/env bash
# Sync the fish-shell plugin from this git checkout into a DSH profile as its
# PACKED form:
#   stage a copy of the bundle outside the workspace
#   pnpm install --prod --config.node-linker=hoisted --config.auto-install-peers=false
#   pnpm pack --config.node-linker=hoisted
#   dsh plugin --profile <profile> add -w <tgz> --offline --config.auto-install-peers=false
#
# Why not the flat `cp` of nine hand-written file names: the plugin ships
# `@deepseek-ai/dsh-tool-terminal` as a bundledDependency, so the dependency
# tree has to travel INSIDE the package (`node_modules/` in the tarball). A
# hand-written list cannot express that — and it silently drifted behind the
# package (`job-kind.d.ts`, `README.zh.md` were already missing). Packing is
# the same path QA and CI take, so the deployment copy is the published
# artefact.
#
# Why a staging copy: `pnpm install` walks up to the repository's pnpm
# workspace, so installing `--prod` inside the checkout would prune the whole
# workspace's devDependencies and rewrite its node_modules with the hoisted
# layout. The staged copy lives in a temp directory outside the workspace, so
# the install only ever touches the staged package.
#
# Why hoisted: pnpm refuses to pack bundledDependencies resolved with the
# default isolated linker (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED), and
# only a hoisted tree holds the bundled dependency as real files — the tarball
# must not ship the symlinks an isolated layout would produce.
#
# Why the tarball is parked under DSH_HOME: `dsh plugin add -w <tgz>` records
# the tarball in the profile manifest as a `file:` dependency, so it has to
# outlive this script — removing it would break every later install of that
# profile. It is kept at
# $DSH_HOME/.cache/banbo-dsh-fish-shell/<name>-<version>-<sha256 prefix>.tgz,
# next to the profile it serves, not under the checkout (whose node_modules the
# documented dependency-refresh workflow deletes and rebuilds). The content
# digest in the name is load-bearing: pnpm compares the `file:` SPECIFIER, so a
# version-only name makes a re-sync of the same version look "already
# satisfied" and leaves the profile on the OLD code; and overwriting a file a
# profile currently references would desync that profile's lock/integrity from
# the bytes on disk if the add failed. Every sync therefore writes a new name
# and removes only tarballs that no profile manifest references any more, after
# the add has succeeded.
#
# Why PACK_HOME is locked: every run parks its tarball under a content-addressed
# name and then removes the parked tarballs that no profile manifest references.
# Two overlapping runs would delete each other's brand-new tarball before it has
# been referenced — the loser then fails at `dsh plugin add` with a `file:`
# specifier that no longer exists. The lock is an atomically created
# `<PACK_HOME>.lock` directory that records pid/host/start and is released by an
# EXIT trap, so every normal and error path frees it. A run that cannot take the
# lock fails fast with the holder named instead of waiting; a lock left behind by
# a killed process is reported with the exact removal command rather than
# guessed at. `mkdir` is the primitive because it is atomic on every POSIX
# filesystem and needs no `flock`.
#
# Usage: scripts/sync-to-profile.sh <profile>
#
# Environment:
#   DSH_HOME  Optional; Harness home to install into (default: ~/.config/dsh).
#   DSH_BIN   Optional dsh executable path/name (default: dsh).
#   PNPM_BIN  Optional pnpm executable path/name (default: pnpm).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/plugins/fish-shell"
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.config/dsh}"
DSH_BIN="${DSH_BIN:-dsh}"
PNPM_BIN="${PNPM_BIN:-pnpm}"

if [[ $# -ne 1 ]]; then
	echo "usage: $0 <profile>" >&2
	exit 2
fi

PROFILE="$1"
if [[ -z "$PROFILE" || "$PROFILE" == "." || "$PROFILE" == ".." || "$PROFILE" == "node_modules" || "$PROFILE" == *"/"* || "$PROFILE" == *"\\"* ]]; then
	echo "invalid profile name: $PROFILE" >&2
	exit 2
fi

STAGE="$(mktemp -d)"
PACK_HOME="$DSH_HOME_RESOLVED/.cache/banbo-dsh-fish-shell"
LOCK_DIR="$PACK_HOME.lock"

cleanup() {
	rm -rf "$STAGE"
	if [[ -n "${LOCK_DIR:-}" ]]; then
		rm -rf "$LOCK_DIR"
	fi
}
trap cleanup EXIT

# Serialize on PACK_HOME before any packing or parking: `mkdir` fails when the
# directory exists, which is the portable atomic test-and-set.
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	holder="$(cat "$LOCK_DIR/owner" 2>/dev/null || true)"
	echo "error: another sync-to-profile run holds the packed-artifact lock" >&2
	echo "error:   lock:   ${LOCK_DIR}" >&2
	echo "error:   holder: ${holder:-unknown (the holder had not written its claim yet)}" >&2
	echo "error: concurrent runs delete each other's parked tarballs, so this run stops instead of waiting." >&2
	echo "error: wait for that run to finish, then retry; if it is gone the lock is stale — remove it with: rm -rf '${LOCK_DIR}'" >&2
	exit 1
fi
printf 'pid=%s host=%s started=%s\n' "$$" "$(hostname 2>/dev/null || echo unknown)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$LOCK_DIR/owner"

# The staged copy omits `node_modules/`: its entries are symlinks into the
# checkout, while the install below recreates the tree as real hoisted files.
mkdir -p "$STAGE/pkg" "$STAGE/packs"
tar -C "$SRC" --exclude='./node_modules' -cf - . | tar -C "$STAGE/pkg" -xf -

echo "packing $SRC in $STAGE/pkg"
(cd "$STAGE/pkg" && "$PNPM_BIN" install --prod --config.node-linker=hoisted --config.auto-install-peers=false)
"$PNPM_BIN" --config.node-linker=hoisted --dir "$STAGE/pkg" pack --pack-destination "$STAGE/packs" >/dev/null

TARBALL=""
for candidate in "$STAGE/packs"/*.tgz; do
	[[ -e "$candidate" ]] || continue
	if [[ -n "$TARBALL" ]]; then
		echo "expected exactly one tarball in $STAGE/packs" >&2
		exit 1
	fi
	TARBALL="$candidate"
done
if [[ -z "$TARBALL" ]]; then
	echo "expected exactly one tarball in $STAGE/packs, found none" >&2
	exit 1
fi

# Park the tarball under a CONTENT-ADDRESSED name before installing: the profile
# manifest records it as a `file:` dependency and pnpm compares that specifier,
# so reusing `<name>-<version>.tgz` would make a re-sync of the same version look
# "already satisfied" (the profile keeps the old code), and overwriting a file a
# profile references would desync its lock from the bytes on disk if the add
# failed. A digest suffix makes every content change a new specifier, and the
# tarball is renamed into place so no recorded path is ever modified.
if command -v sha256sum >/dev/null 2>&1; then
	TARBALL_DIGEST="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
	TARBALL_DIGEST="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
else
	echo "need sha256sum or shasum to name the tarball by content" >&2
	exit 1
fi

mkdir -p "$PACK_HOME"
TARBALL_NAME="$(basename "$TARBALL" .tgz)-${TARBALL_DIGEST:0:16}.tgz"
PARTIAL="$PACK_HOME/.$TARBALL_NAME.part"
cp -f "$TARBALL" "$PARTIAL"
mv -f "$PARTIAL" "$PACK_HOME/$TARBALL_NAME"
STABLE_TARBALL="$PACK_HOME/$TARBALL_NAME"

echo "installing $STABLE_TARBALL into profile $PROFILE under DSH_HOME=$DSH_HOME_RESOLVED"
DSH_HOME="$DSH_HOME_RESOLVED" "$DSH_BIN" plugin --profile "$PROFILE" add -w "$STABLE_TARBALL" --offline --config.auto-install-peers=false

# Only after a successful add: drop the parked tarballs no profile manifest
# references any more. Nothing referenced is removed, so a failed add above
# leaves the previous artefact — and the profile entry pointing at it — intact.
referenced_names="$(
	grep -oh 'file:[^"]*' "$DSH_HOME_RESOLVED"/profiles/*/package.json 2>/dev/null |
		sed 's|.*/||' |
		sort -u || true
)"
for candidate in "$PACK_HOME"/*.tgz; do
	[[ -e "$candidate" ]] || continue
	candidate_name="$(basename "$candidate")"
	if [[ "$candidate_name" == "$TARBALL_NAME" ]]; then
		continue
	fi
	case $'\n'"$referenced_names"$'\n' in
		*$'\n'"$candidate_name"$'\n'*) continue ;;
	esac
	echo "removing unreferenced tarball $candidate"
	rm -f "$candidate"
done
echo "synced $SRC -> profile $PROFILE"
