#!/usr/bin/env bash
# Starts a throwaway editor instance (own profile, no other extensions) with
# this extension in development mode and runs dev/integration.cjs.
# Usage: dev/run-integration.sh <work-dir> [hold-ms]
# TG_APP picks the editor (default: Antigravity IDE). TG_PROPOSED=0 runs it
# without the proposed APIs, to check the extension without mirrors.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$1"
APP="${TG_APP:-/Applications/Antigravity IDE.app}"
PROPOSED="${TG_PROPOSED:-1}"
mkdir -p "$WORK/user-data" "$WORK/extensions" "$WORK/workspace"
echo "# notes" > "$WORK/workspace/notes.md"
export TG_OUT="$WORK/result.txt"
export TG_HOLD_MS="${2:-0}"
: > "$TG_OUT"
EXT_DIR="$ROOT"
EXT_ID=vdzeer.terminal-grid
FLAGS=()
if [ "$PROPOSED" = 1 ]; then
  FLAGS+=(--enable-proposed-api="$EXT_ID")
else
  # Editors read argv.json from the home folder (~/.vscode, ~/.antigravity-ide),
  # not from --user-data-dir, so an enable-proposed-api there would still apply.
  # A copy under another publisher id is out of its reach.
  EXT_DIR="$WORK/ext"
  EXT_ID=tgtest.terminal-grid
  rm -rf "$EXT_DIR" && mkdir -p "$EXT_DIR"
  cp -R "$ROOT/dist" "$ROOT/media" "$ROOT/package.nls.json" "$ROOT/package.nls.uk.json" "$EXT_DIR/"
  node -e 'const fs = require("fs"); const [from, to] = process.argv.slice(1); const m = JSON.parse(fs.readFileSync(from, "utf8")); m.publisher = "tgtest"; fs.writeFileSync(to, JSON.stringify(m, null, 2));' \
    "$ROOT/package.json" "$EXT_DIR/package.json"
fi
# VS Code keeps its IPC socket in the user data dir, and a socket path may not
# be longer than 103 characters on macOS: a short link keeps long work dirs usable.
LINK_DIR="$(mktemp -d)"
trap 'rm -rf "$LINK_DIR"' EXIT
ln -s "$WORK/user-data" "$LINK_DIR/u"
if [ -n "${TG_DEBUG_PORT:-}" ]; then FLAGS+=(--remote-debugging-port="$TG_DEBUG_PORT"); fi
# -g keeps the window in the background so it does not take focus.
open -g -n -W -a "$APP" --env TG_OUT="$TG_OUT" --env TG_HOLD_MS="$TG_HOLD_MS" --env TG_EXPECT_MIRRORS="$PROPOSED" --env TG_EXTENSION_ID="$EXT_ID" --args \
  --user-data-dir="$LINK_DIR/u" \
  --extensions-dir="$WORK/extensions" \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-welcome \
  --skip-release-notes \
  ${FLAGS[@]+"${FLAGS[@]}"} \
  --extensionDevelopmentPath="$EXT_DIR" \
  --extensionTestsPath="$ROOT/dev/integration.cjs" \
  "$WORK/workspace" || true
cat "$TG_OUT"
! grep -q '^FAIL' "$TG_OUT"
