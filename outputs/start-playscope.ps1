$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $scriptDir "playscope-server.js"

Write-Host "Starting PlayScope..."
Write-Host "Open: http://127.0.0.1:5177"
node $server
