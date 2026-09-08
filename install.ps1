# One-click installer for the DeepSeek Harness Chat VSCode extension (Windows).
#
# Steps:
#   1. Verify Node.js >= 22.19 and the `code` CLI are available.
#   2. Install the `dsh` backend globally from npm (@deepseek-ai/dsh).
#   3. Build the extension into a .vsix (from source in this repo).
#   4. Install the .vsix into VSCode.
#   5. Print the DEEPSEEK_API_KEY setup instructions.
#
# Usage (PowerShell):  ./install.ps1
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Info($m) { Write-Host "==> $m" -ForegroundColor Blue }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

# 1. Node.js >= 22.19
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js not found. Install Node 22.19+ from https://nodejs.org and re-run."
}
$major = [int](node -p 'process.versions.node.split(".").map(Number)[0]')
$minor = [int](node -p 'process.versions.node.split(".").map(Number)[1]')
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
  Fail "Node $(node -v) is too old. Install Node 22.19+ (or 24+) and re-run."
}
Info "Node $(node -v) OK"

# 2. `code` CLI
if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
  Fail "The 'code' command was not found. In VSCode run: Command Palette -> 'Shell Command: Install code command in PATH', then re-run."
}

# 3. Install the dsh backend from npm
Info "Installing the dsh backend (npm i -g @deepseek-ai/dsh)…"
npm i -g '@deepseek-ai/dsh'
if ($LASTEXITCODE -ne 0) { Fail "Failed to install @deepseek-ai/dsh. Check your npm/network and try again." }
if (Get-Command dsh -ErrorAction SilentlyContinue) { Info "dsh installed: $((Get-Command dsh).Source)" }
else { Warn "dsh not on PATH yet; open a new shell or set dsh.binPath in VSCode settings." }

# 4. Build the extension .vsix (unless one is already committed alongside this script)
$Vsix = Join-Path $ScriptDir 'dsh-chat.vsix'
if (-not (Test-Path $Vsix)) {
  Info "Installing build dependencies (npm install)…"
  npm install
  Info "Bundling the extension…"
  npm run compile
  Info "Packaging the .vsix…"
  npm run package
}
if (-not (Test-Path $Vsix)) { Fail "Expected $Vsix to exist after packaging." }

# 5. Install into VSCode
Info "Installing the extension into VSCode…"
code --install-extension $Vsix --force

Write-Host ""
Write-Host "Done. Next step - set your DeepSeek API key so the harness can call the model:" -ForegroundColor Green
Write-Host '  New-Item -ItemType Directory -Force "$HOME/.dsh" | Out-Null'
Write-Host '  Add-Content "$HOME/.dsh/.env" "DEEPSEEK_API_KEY=sk-your-key"'
Write-Host ""
Write-Host 'Then in VSCode: open the bottom panel and select the "DeepSeek Harness" tab'
Write-Host '(or run "DSH: Open chat panel" from the Command Palette).'
