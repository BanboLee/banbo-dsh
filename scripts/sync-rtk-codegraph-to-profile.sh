#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RTK_BUNDLE="$ROOT/plugins/rtk-shell"
CODEGRAPH_BUNDLE="$ROOT/plugins/codegraph-mcp"
DSH_BIN="${DSH_BIN:-dsh}"

usage() {
	cat <<USAGE
Usage:
  DSH_HOME=\$(mktemp -d) $0 <profile>

Installs both local DSH bundle packages into <profile>:
  dsh plugin --profile <profile> add ./plugins/rtk-shell
  dsh plugin --profile <profile> add ./plugins/codegraph-mcp

Environment:
  DSH_HOME  Required; must point at the Harness home to modify.
  DSH_BIN   Optional dsh executable path/name (default: dsh).
USAGE
}

fail() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

if [[ $# -ne 1 ]]; then
	usage >&2
	fail "expected exactly one profile name"
fi

PROFILE="$1"
if [[ -z "$PROFILE" || "$PROFILE" == "." || "$PROFILE" == ".." || "$PROFILE" == "node_modules" || "$PROFILE" == *"/"* || "$PROFILE" == *"\\"* ]]; then
	fail "invalid profile name: $PROFILE"
fi

if [[ -z "${DSH_HOME:-}" ]]; then
	fail "DSH_HOME must be set explicitly; use an isolated temp directory for QA"
fi

for bundle in "$RTK_BUNDLE" "$CODEGRAPH_BUNDLE"; do
	[[ -f "$bundle/package.json" ]] || fail "missing package.json in $bundle"
	[[ -f "$bundle/cordis.patch.yml" ]] || fail "missing cordis.patch.yml in $bundle"
done

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
	fail "cannot find DSH_BIN executable: $DSH_BIN"
fi

printf 'Installing local DSH bundles into profile %s under DSH_HOME=%s\n' "$PROFILE" "$DSH_HOME"
printf '+ %s plugin --profile %s add %s %s\n' "$DSH_BIN" "$PROFILE" "$RTK_BUNDLE" "$CODEGRAPH_BUNDLE"
"$DSH_BIN" plugin --profile "$PROFILE" add "$RTK_BUNDLE" "$CODEGRAPH_BUNDLE"
printf 'Installed dsh-rtk-shell and dsh-codegraph-mcp into profile %s\n' "$PROFILE"
