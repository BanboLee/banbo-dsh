#!/usr/bin/env bash
# Sync the fish-shell plugin from this git checkout to the dsh profile
# deployment copy, and keep the user fish agent preset in sync with the
# shipped `standard` preset (only the shell section may differ).
#
# The harness resolves plugin dependencies from the realpath of the plugin
# module, so the deployed copy must live inside the profile tree
# (`profiles/node_modules/dsh-fish-shell`) where the launcher-maintained
# `@deepseek-ai/*` symlink chain is reachable. A plain `link:` to this
# checkout (outside the tree) would resolve no `@deepseek-ai` packages.
#
# Usage: scripts/sync-to-profile.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/plugins/fish-shell"
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.config/dsh}"
DST="$DSH_HOME_RESOLVED/profiles/node_modules/dsh-fish-shell"

mkdir -p "$DST"
cp "$SRC/index.js" "$SRC/local.js" "$SRC/tool.js" "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/README.md" "$DST/"
mkdir -p "$DST/presets/fish"
cp "$SRC/presets/fish/agent.cordis.yml" "$DST/presets/fish/agent.cordis.yml"
echo "synced $SRC -> $DST"

# The fish agent preset must stay a copy of the shipped `standard` preset with
# only the shell rows swapped. Check drift; refresh when `standard` changed.
STANDARD="$DSH_HOME_RESOLVED/profiles/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml"
PRESET="$DSH_HOME_RESOLVED/.agent-presets/fish/agent.cordis.yml"
if [ ! -f "$STANDARD" ]; then
  echo "warning: cannot find shipped standard preset at $STANDARD; skipping drift check"
elif [ ! -f "$PRESET" ]; then
  echo "warning: fish preset missing at $PRESET; create it from the standard preset with the shell rows swapped"
else
  # Normalize both by blanking the shell section, then diff.
  norm() {
    awk '
      /^# ── shell ─/ { skip = 1; next }
      /^# ── filesystem ─/ { skip = 0; print; next }
      !skip { print }
    ' "$1"
  }
  if ! diff -q <(norm "$STANDARD") <(norm "$PRESET") >/dev/null 2>&1; then
    echo "warning: $PRESET drifted from $STANDARD (outside the shell section)."
    echo "Refresh it manually: cp \"$STANDARD\" \"$PRESET\" and swap the tool-bash/tool-pwsh rows for:"
    echo "  - id: tool-fish"
    echo "    name: dsh-fish-shell/tool"
  else
    echo "fish preset at $PRESET matches standard (shell section aside)."
  fi
fi
