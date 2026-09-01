#!/usr/bin/env bash
set -euo pipefail

# Install the CodeGraph agent-instructions block into an AGENTS.md file so DSH
# loads it into model context for the main agent AND delegated subagents.
#
# Why this exists: DSH's `dsh-agent-instructions` plugin (shipped enabled in
# @deepseek-ai/dsh-base) loads $DSH_HOME/AGENTS.md plus the project chain of
# AGENTS.md/CLAUDE.md into every request. The DSH MCP bridge
# (@deepseek-ai/dsh-mcp-client) does NOT consume the MCP `initialize`
# instructions, so codegraph's own server instructions never reach the model.
# This block is the DSH equivalent of what the upstream codegraph installer
# writes into CLAUDE.md/AGENTS.md/GEMINI.md for every supported agent — without
# it, subagents (and often the main agent) never learn to call
# `mcp__codegraph__codegraph_explore` first.
#
# The write is marker-fenced (<!-- CODEGRAPH_START/END -->) and idempotent:
# re-running with an identical block reports "unchanged" and touches nothing;
# re-running after a stale block replaces only the fenced section, preserving
# all surrounding content. Every write ends with exactly one trailing newline.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCK_FILE="$ROOT/plugins/codegraph-mcp/instructions/CODEGRAPH.md"
START_MARKER='<!-- CODEGRAPH_START -->'
END_MARKER='<!-- CODEGRAPH_END -->'

usage() {
	cat <<USAGE
Usage:
  $0 [<target>]

Upserts the marker-fenced CodeGraph instructions block into <target>.

<target> defaults to:
  1. \$DSH_HOME/AGENTS.md        (user-global; applies to every project)
  2. else ~/.dsh/AGENTS.md        (harness default home, when DSH_HOME is unset)

Prints one line: "created" | "appended" | "updated" | "unchanged".

Environment:
  DSH_HOME  Optional Harness home; used to derive the default target.
  HOME      Fallback home when DSH_HOME is unset (~/.dsh/AGENTS.md).
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

if [[ ! -f "$BLOCK_FILE" ]]; then
	printf 'error: missing instructions block: %s\n' "$BLOCK_FILE" >&2
	exit 1
fi

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
	if [[ -n "${DSH_HOME:-}" ]]; then
		TARGET="$DSH_HOME/AGENTS.md"
	else
		# Match dsh-home-paths' resolveDshHome fallback (harness default home
		# is ~/.dsh when DSH_HOME is unset) so a no-arg install is really
		# user-global, not project-scoped ./AGENTS.md.
		TARGET="${HOME:?HOME is unset}/.dsh/AGENTS.md"
	fi
fi

# Normalize a bare relative name (e.g. "AGENTS.md") to ./<name>; absolute and
# explicit ./-relative paths pass through unchanged.
case "$TARGET" in
	/* | ./* | ../*) ;;
	*) TARGET="./$TARGET" ;;
esac

# Extract ONLY the fenced block (start marker through end marker, inclusive)
# from the source file, so documentation prose around it never leaks into the
# target AGENTS.md. Command substitution strips trailing newlines, so BLOCK
# holds the fenced text with no trailing newline; each write below re-adds
# exactly one.
BLOCK="$(awk -v s="$START_MARKER" -v e="$END_MARKER" '
	$0 == s { inside = 1 }
	inside { print }
	$0 == e { exit }
' "$BLOCK_FILE")"
if [[ -z "$BLOCK" ]]; then
	printf 'error: block file has no fenced %s … %s section\n' "$START_MARKER" "$END_MARKER" >&2
	exit 1
fi

mkdir -p "$(dirname "$TARGET")"

if [[ ! -f "$TARGET" ]]; then
	printf '%s\n' "$BLOCK" > "$TARGET"
	echo "created"
	exit 0
fi

# Command substitution also strips trailing newlines from the target, which
# keeps the replace/unchanged comparison and write on the same normalized text.
CONTENT="$(cat "$TARGET")"

# No start marker yet → append at end (with a blank-line separator if the file
# has existing content).
if ! grep -qF "$START_MARKER" <<<"$CONTENT"; then
	SEP=''
	if grep -q '[^[:space:]]' <<<"$CONTENT"; then
		SEP=$'\n\n'
	fi
	printf '%s%s%s\n' "$CONTENT" "$SEP" "$BLOCK" > "$TARGET"
	echo "appended"
	exit 0
fi

# A start marker exists. Require a matching end marker after it; a half-written
# fence is a hand-fix job, not something to guess around.
if ! grep -qF "$END_MARKER" <<<"$CONTENT"; then
	printf 'error: %s has %s without %s — fix by hand\n' \
		"$TARGET" "$START_MARKER" "$END_MARKER" >&2
	exit 1
fi

# Replace the whole fenced section (from the first start marker through the
# first following end marker) with the current block.
PREFIX="${CONTENT%%$START_MARKER*}"
REST="${CONTENT#*$START_MARKER}"
REST="${REST#*$END_MARKER}"   # drop everything through the first end marker
SUFFIX="$REST"

if [[ "$PREFIX$BLOCK$SUFFIX" == "$CONTENT" ]]; then
	echo "unchanged"
	exit 0
fi

printf '%s%s%s\n' "$PREFIX" "$BLOCK" "$SUFFIX" > "$TARGET"
echo "updated"
