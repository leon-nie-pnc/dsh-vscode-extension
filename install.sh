#!/usr/bin/env bash
# One-click installer for the DeepSeek Harness Chat VSCode extension (macOS/Linux).
#
# Steps:
#   1. Verify Node.js >= 22.19 and the `code` CLI are available.
#   2. Install the `dsh` backend globally from npm (@deepseek-ai/dsh).
#   3. Build the extension into a .vsix (from source in this repo).
#   4. Install the .vsix into VSCode.
#   5. Print the DEEPSEEK_API_KEY setup instructions.
#
# Usage:  ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Node.js >= 22.19
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node 22.19+ from https://nodejs.org and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".").map(Number)[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".").map(Number)[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  fail "Node $(node -v) is too old. Install Node 22.19+ (or 24+) and re-run."
fi
info "Node $(node -v) OK"

# 2. `code` CLI
command -v code >/dev/null 2>&1 || fail "The 'code' command was not found. In VSCode run: Command Palette -> 'Shell Command: Install \"code\" command in PATH', then re-run."

# 3. Install the dsh backend from npm
info "Installing the dsh backend (npm i -g @deepseek-ai/dsh)…"
npm i -g @deepseek-ai/dsh || fail "Failed to install @deepseek-ai/dsh. Check your npm/network and try again."
command -v dsh >/dev/null 2>&1 && info "dsh installed: $(command -v dsh)" || warn "dsh not on PATH yet; open a new shell or set dsh.binPath in VSCode settings."

# 4. Build the extension .vsix (unless one is already committed alongside this script)
VSIX="$SCRIPT_DIR/dsh-chat.vsix"
if [ ! -f "$VSIX" ]; then
  info "Installing build dependencies (npm install)…"
  npm install
  info "Bundling the extension…"
  npm run compile
  info "Packaging the .vsix…"
  npm run package
fi
[ -f "$VSIX" ] || fail "Expected $VSIX to exist after packaging."

# 5. Install into VSCode
info "Installing the extension into VSCode…"
code --install-extension "$VSIX" --force

cat <<'EOF'

Done. Next step — set your DeepSeek API key so the harness can call the model:

  mkdir -p ~/.dsh
  printf 'DEEPSEEK_API_KEY=sk-your-key\n' >> ~/.dsh/.env

Then in VSCode: open the bottom panel and select the "DeepSeek Harness" tab
(or run "DSH: Open chat panel" from the Command Palette).
EOF
