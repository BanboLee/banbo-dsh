#!/usr/bin/env bash
set -euo pipefail

# Optional real-CodeGraph smoke for the dsh-codegraph-mcp bundle.
#
# The deterministic fake-MCP tests in plugins/codegraph-mcp/tests (see README
# "Verification") remain the authoritative acceptance for this bundle. This
# script is a best-effort diagnostic that only runs when a real `codegraph`
# binary is on PATH; when codegraph is absent it reports "skipped" and exits
# 0, so it is safe to run in any environment and is never a required
# acceptance gate.
#
# It never starts an MCP server and never spawns a daemon: it only checks the
# installed binary understands the exact flags the bundle row uses
# (`codegraph serve --mcp` with `-p/--path` and `CODEGRAPH_NO_DAEMON`).
# Deterministic acceptance for the bundle comes from the fake-server tests.

usage() {
	cat <<USAGE
Usage:
  scripts/smoke-codegraph-mcp.sh [--help]

Optional real-CodeGraph smoke for dsh-codegraph-mcp. Skips (exit 0) when
codegraph is not on PATH. Verifies \`codegraph --version\` and that
\`codegraph serve --help\` advertises the --mcp and -p/--path flags the bundle
row uses. Never starts an MCP server or daemon.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

# Defensive: even the read-only probes below must never fork a daemon.
export CODEGRAPH_NO_DAEMON=1

if ! command -v codegraph >/dev/null 2>&1; then
	echo "smoke-codegraph-mcp: codegraph not on PATH; skipping real smoke (deterministic fake tests are authoritative)"
	exit 0
fi

VERSION="$(codegraph --version)"
echo "smoke-codegraph-mcp: codegraph version: $VERSION"

SERVE_HELP="$(codegraph serve --help 2>&1)"
if ! printf '%s' "$SERVE_HELP" | grep -q -- '--mcp'; then
	echo "smoke-codegraph-mcp: 'codegraph serve --help' does not advertise --mcp" >&2
	exit 1
fi
if ! printf '%s' "$SERVE_HELP" | grep -q -- '--path'; then
	echo "smoke-codegraph-mcp: 'codegraph serve --help' does not advertise -p/--path" >&2
	exit 1
fi

echo "smoke-codegraph-mcp: codegraph serve --mcp --path contract verified (no server started, no daemon spawned)"
