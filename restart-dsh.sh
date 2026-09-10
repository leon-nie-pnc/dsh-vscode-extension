#!/usr/bin/env bash
# One-touch dev restart for the dsh-chat VSCode extension.
#
# The extension spawns and supervises its OWN `dsh web` server on port 3080,
# so this script does NOT start a server. It only removes the two things that
# leave the extension "not responding":
#   1. a stray standalone `dsh web` holding port 3080 (blocks the extension
#      from binding its own server),
#   2. stale harness build output in `lib/` (makes the webview load blank).
# Then it tells you to reload the VSCode window so the extension respawns
# cleanly and captures a fresh `?token=` URL.
#
# Usage:
#   ./restart-dsh.sh            # incremental build; auto-cleans if build fails
#   ./restart-dsh.sh --clean    # force `pnpm run clean` first (after switching
#                               # branches, or on MissingClientBundleError /
#                               # MISSING_EXPORT errors from a stale build)
#   ./restart-dsh.sh --reset-sessions
#                               # ALSO delete this workspace's saved chat history
#                               # (fixes a "corrupt session log" that reload/rebuild
#                               # alone cannot; combinable with --clean)
#
# Point at a different harness checkout:
#   DSH_HARNESS_REPO=/path/to/deepseek-harness ./restart-dsh.sh
set -euo pipefail

PORT=3080
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${DSH_HARNESS_REPO:-$SCRIPT_DIR/../deepseek-harness}"

CLEAN=0
RESET_SESSIONS=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --reset-sessions) RESET_SESSIONS=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg (use --clean, --reset-sessions, or --help)" >&2; exit 2 ;;
  esac
done

if [ ! -f "$HARNESS/package.json" ]; then
  echo "error: harness repo not found at: $HARNESS" >&2
  echo "       set DSH_HARNESS_REPO to your deepseek-harness checkout." >&2
  exit 1
fi
echo "==> harness: $HARNESS"

# --- 1. Free port 3080 (by listener PID, never by command-line pattern, so
#        the script can never match and kill itself). ---
port_pids() {
  ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}
pids="$(port_pids)"
if [ -z "$pids" ]; then
  echo "==> port $PORT already free"
else
  echo "==> freeing port $PORT (kill: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs -r kill 2>/dev/null || true
  sleep 2
  pids="$(port_pids)"
  [ -n "$pids" ] && { echo "==> forcing (SIGKILL): $(echo "$pids" | tr '\n' ' ')"; echo "$pids" | xargs -r kill -9 2>/dev/null || true; }
fi

# --- 1b. Optionally wipe this workspace's saved chat history. `dsh web` keys
#         sessions by the cwd it runs in (the harness repo), flattening that
#         absolute path into ~/.dsh/sessions/--<path-with-slashes-as-dashes>--.
#         Reload and rebuild never touch this data, so a corrupt session log
#         survives them; --reset-sessions is the opt-in escape hatch. ---
if [ "$RESET_SESSIONS" = "1" ]; then
  harness_real="$(cd "$HARNESS" && pwd -P)"
  slug="--$(printf '%s' "${harness_real#/}" | tr '/' '-')--"
  sessions_dir="${DSH_HOME:-$HOME/.dsh}/sessions/$slug"
  if [ -d "$sessions_dir" ]; then
    echo "==> resetting sessions: rm -rf $sessions_dir"
    rm -rf "$sessions_dir"
  else
    echo "==> no saved sessions to reset ($sessions_dir absent)"
  fi
fi

# --- 2. Rebuild harness client/host bundles. ---
cd "$HARNESS"
if [ ! -f .env ] && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "warn: no .env in $HARNESS and DEEPSEEK_API_KEY unset; the model calls will fail until a key is provided." >&2
fi
if [ "$CLEAN" = "1" ]; then
  echo "==> pnpm run clean"
  pnpm run clean
fi
echo "==> pnpm run build"
if ! pnpm run build; then
  echo "==> build failed; retrying after clean (stale lib/ is the usual cause)" >&2
  pnpm run clean
  pnpm run build
fi

echo
echo "==> done. Reload VSCode so the extension respawns its server:"
echo "      Ctrl+Shift+P  ->  Developer: Reload Window"
echo "    (the extension binds port $PORT and loads its own ?token= URL)"
