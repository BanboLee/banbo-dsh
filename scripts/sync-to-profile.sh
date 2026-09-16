#!/usr/bin/env bash
# Sync the fish-shell plugin from this git checkout to the dsh profile
# deployment copy.
#
# The harness resolves plugin dependencies from the realpath of the plugin
# module, so the deployed copy must live inside the profile tree
# (`profiles/node_modules/@banbolee/dsh-fish-shell`) where the launcher-maintained
# `@deepseek-ai/*` symlink chain is reachable. A plain `link:` to this
# checkout (outside the tree) would resolve no `@deepseek-ai` packages.
#
# Usage: scripts/sync-to-profile.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/plugins/fish-shell"
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.config/dsh}"
DST="$DSH_HOME_RESOLVED/profiles/node_modules/@banbolee/dsh-fish-shell"

mkdir -p "$DST"
cp "$SRC/index.js" "$SRC/local.js" "$SRC/tool.js" "$SRC/policy.js" "$SRC/terminal-fish.js" "$SRC/persistent.js" "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/README.md" "$DST/"
echo "synced $SRC -> $DST"
