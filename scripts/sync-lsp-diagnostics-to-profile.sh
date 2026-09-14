#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LSP_DIAGNOSTICS_BUNDLE="$ROOT/plugins/dsh-lsp-diagnostics"
DSH_BIN="${DSH_BIN:-dsh}"

usage() {
	cat <<USAGE
Usage:
  DSH_HOME=\$(mktemp -d) $0 <profile>

Installs the local @banbolee/dsh-lsp-diagnostics bundle package into <profile>:
  dsh plugin --profile <profile> add -w ./plugins/dsh-lsp-diagnostics

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

[[ -f "$LSP_DIAGNOSTICS_BUNDLE/package.json" ]] || fail "missing package.json in $LSP_DIAGNOSTICS_BUNDLE"
[[ -f "$LSP_DIAGNOSTICS_BUNDLE/cordis.patch.yml" ]] || fail "missing cordis.patch.yml in $LSP_DIAGNOSTICS_BUNDLE"

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
	fail "cannot find DSH_BIN executable: $DSH_BIN"
fi

printf 'Installing local @banbolee/dsh-lsp-diagnostics bundle into profile %s under DSH_HOME=%s\n' "$PROFILE" "$DSH_HOME"
printf '+ %s plugin --profile %s add -w %s\n' "$DSH_BIN" "$PROFILE" "$LSP_DIAGNOSTICS_BUNDLE"
"$DSH_BIN" plugin --profile "$PROFILE" add -w "$LSP_DIAGNOSTICS_BUNDLE"
printf 'Installed @banbolee/dsh-lsp-diagnostics into profile %s\n' "$PROFILE"
