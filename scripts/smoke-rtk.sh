#!/usr/bin/env bash
set -euo pipefail

# Optional real-RTK smoke for the @banbolee/dsh-rtk bundle.
#
# The deterministic fake-RTK tests in plugins/rtk/tests (see README
# "Verification") remain the authoritative acceptance for this plugin. This
# script is a best-effort diagnostic that only runs when a real `rtk` binary
# is on PATH; when rtk is absent it reports "skipped" and exits 0, so it is
# safe to run in any environment and is never a required acceptance gate.
#
# Real `rtk rewrite` exits 0 (rewrite), 1 (passthrough), 2 (deny), or
# 3 (ask, which the plugin maps to a silent rewrite). The smoke runs one
# rewrite and verifies the observed exit code is one of those four contract
# values.

usage() {
	cat <<USAGE
Usage:
  scripts/smoke-rtk.sh [--help]

Optional real-RTK smoke for @banbolee/dsh-rtk. Skips (exit 0) when rtk is not on
PATH. Runs \`rtk rewrite '<command>'\` and verifies the exit code is one of the
documented contract values 0/1/2/3.

Environment:
  RTK_SMOKE_COMMAND  The command to rewrite (default: "git status").
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

if ! command -v rtk >/dev/null 2>&1; then
	echo "smoke-rtk: rtk not on PATH; skipping real smoke (deterministic fake tests are authoritative)"
	exit 0
fi

CMD="${RTK_SMOKE_COMMAND:-git status}"
set +e
OUTPUT="$(rtk rewrite "$CMD" 2>&1)"
CODE=$?
set -e

case "$CODE" in
0) echo "smoke-rtk: rtk rewrite exit 0 (rewrite) -> $OUTPUT" ;;
1) echo "smoke-rtk: rtk rewrite exit 1 (passthrough) -> $OUTPUT" ;;
2) echo "smoke-rtk: rtk rewrite exit 2 (deny) -> $OUTPUT" ;;
3) echo "smoke-rtk: rtk rewrite exit 3 (ask, silent rewrite) -> $OUTPUT" ;;
*)
	echo "smoke-rtk: unexpected rtk rewrite exit $CODE (expected 0/1/2/3): $OUTPUT" >&2
	exit 1
	;;
esac
