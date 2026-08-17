param([string]$StateDir = (Join-Path $env:USERPROFILE '.remote-oc\public-stack'))

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $StateDir 'state.json'
if (-not (Test-Path $statePath)) { Write-Host 'Public stack is not running.'; exit 0 }
$state = Get-Content $statePath -Raw | ConvertFrom-Json

foreach ($pidValue in @($state.appPid, $state.ngrokPid, $state.hubPid)) {
  if (-not $pidValue) { continue }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) { & taskkill.exe /PID $pidValue /T /F | Out-Null }
}
Remove-Item -LiteralPath $statePath -Force
Write-Host 'Public stack stopped.'
