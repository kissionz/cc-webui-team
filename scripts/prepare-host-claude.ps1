$ErrorActionPreference = "Stop"

$claudeCommand = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCommand) {
  Write-Error "claude command not found on host PATH. Install and log in to Claude Code first."
}

$claudePath = $claudeCommand.Source
$resolvedPath = $claudePath

if ($claudePath.EndsWith(".cmd")) {
  $cmdText = Get-Content $claudePath -Raw
  if ($cmdText -match 'node_modules[\\/]+@anthropic-ai[\\/]+claude-code[\\/]+cli\.js') {
    $npmRoot = npm root -g
    $resolvedPath = Join-Path $npmRoot "@anthropic-ai/claude-code/cli.js"
  }
}

if (-not (Test-Path $resolvedPath)) {
  Write-Error "Could not resolve Claude Code CLI package from $claudePath"
}

$claudeDir = Split-Path -Parent $resolvedPath
$targetRoot = Join-Path (Get-Location) ".host-claude"
$targetDir = Join-Path $targetRoot "claude-code"

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}
Copy-Item -Recurse -Path $claudeDir -Destination $targetDir

$claudeHome = Join-Path $env:USERPROFILE ".claude"
if (-not (Test-Path $claudeHome)) {
  Write-Warning "$claudeHome was not found. Run 'claude' on the host and finish login first."
}

Write-Host "Prepared host Claude Code CLI from:"
Write-Host "  $resolvedPath"
Write-Host ""
Write-Host "Next:"
Write-Host "  docker compose -f docker-compose.yml -f docker-compose.host-claude.yml up -d --build"
