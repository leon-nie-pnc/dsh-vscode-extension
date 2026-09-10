#!/usr/bin/env bash
# One-touch dev setup for the dsh-chat VSCode extension from source.
#
# Builds everything the extension needs and installs it, so that a single run
# leaves you one "Reload Window" away from a working panel:
#   1. build the harness client/host bundles (only if missing, or --rebuild-harness)
#   2. free port 3080 (kill any stale/orphaned `dsh web` a prior reload left behind)
#   3. compile + package this extension into dsh-chat.vsix
#   4. install the .vsix into VSCode (`code --install-extension --force`)
#
# The extension spawns its OWN `dsh web` on 3080 when the panel opens; step 2
# only clears leftovers so that first spawn does not hit EADDRINUSE. The
# reclaim-on-spawn fix in src/dsh-process.ts makes this self-healing too, but
# clearing here means even an un-upgraded install starts clean.
#
# Usage:
#   ./dev-setup.sh                  # build extension; build harness only if missing
#   ./dev-setup.sh --rebuild-harness  # force `pnpm run clean && build` in the harness
#   ./dev-setup.sh --skip-harness   # assume the harness is already built
#
# Override the harness checkout:  DSH_HARNESS_REPO=/path/to/deepseek-harness ./dev-setup.sh
set -euo pipefail

PORT=3080
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${DSH_HARNESS_REPO:-$SCRIPT_DIR/../deepseek-harness}"

REBUILD_HARNESS=0
SKIP_HARNESS=0
for arg in "$@"; do
  case "$arg" in
    --rebuild-harness) REBUILD_HARNESS=1 ;;
    --skip-harness) SKIP_HARNESS=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg (use --rebuild-harness, --skip-harness, or --help)" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js not found (need >= 22.19)."
command -v code >/dev/null 2>&1 || fail "'code' CLI not found. In VSCode: 'Shell Command: Install code command in PATH'."
[ -f "$HARNESS/package.json" ] || fail "harness repo not found at $HARNESS; set DSH_HARNESS_REPO."
[ -x "$SCRIPT_DIR/bin/dsh-source" ] || warn "bin/dsh-source missing or not executable; the dsh.binPath setting must point at an existing launcher."

# 1. Harness bundles (the webview loads blank when client/lib is stale/missing).
CLIENT_BUNDLE="$HARNESS/packages/client/ui-approval/lib/client.js"
if [ "$SKIP_HARNESS" = "1" ]; then
  info "skipping harness build (--skip-harness)"
elif [ "$REBUILD_HARNESS" = "1" ]; then
  info "harness: pnpm run clean && build"
  ( cd "$HARNESS" && pnpm run clean && pnpm run build )
elif [ ! -f "$CLIENT_BUNDLE" ]; then
  info "harness bundles missing; building"
  ( cd "$HARNESS" && { pnpm run build || { echo "build failed; retrying after clean" >&2; pnpm run clean && pnpm run build; }; } )
else
  info "harness bundles present (use --rebuild-harness to force)"
fi

# 2. Free port 3080 by listener PID (never a command-line pattern -> no self-kill).
port_pids() { ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true; }
pids="$(port_pids)"
if [ -n "$pids" ]; then
  info "freeing port $PORT (kill: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs -r kill 2>/dev/null || true
  sleep 2
  pids="$(port_pids)"
  [ -n "$pids" ] && { echo "$pids" | xargs -r kill -9 2>/dev/null || true; }
else
  info "port $PORT already free"
fi

# 3. Build + package the extension.
cd "$SCRIPT_DIR"
[ -d node_modules ] || { info "npm install"; npm install; }
info "compiling extension (esbuild)"; npm run compile
info "packaging dsh-chat.vsix"; npm run package
[ -f "$SCRIPT_DIR/dsh-chat.vsix" ] || fail "packaging did not produce dsh-chat.vsix."

# 4. Install into VSCode.
info "installing extension into VSCode"; code --install-extension "$SCRIPT_DIR/dsh-chat.vsix" --force

if [ ! -f "$HARNESS/.env" ] && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  warn "no .env in $HARNESS and DEEPSEEK_API_KEY unset; model calls will fail until a key is set."
fi

echo
info "done. Final step in VSCode:"
echo "      Ctrl+Shift+P -> Developer: Reload Window"
echo "    then open the DeepSeek Harness panel (or run 'DSH: Restart server')."
