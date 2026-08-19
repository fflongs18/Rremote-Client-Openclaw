param(
  [string]$StateDir = (Join-Path $env:USERPROFILE '.remote-oc\public-stack'),
  [int]$HubPort = 3179,
  [int]$BffPort = 8787
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $StateDir 'state.json'
$stopped = $false

function Stop-Tree([object]$PidValue) {
  if (-not $PidValue) { return }
  $process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if ($process) {
    & taskkill.exe /PID $PidValue /T /F | Out-Null
    $script:stopped = $true
  }
}

function Stop-PortListeners([int]$Port) {
  $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($pidValue in $pids) {
    if (-not $pidValue) { continue }
    Write-Host "Stopping leftover process on port $Port (PID $pidValue)"
    Stop-Tree $pidValue
  }
}

if (Test-Path $statePath) {
  $state = Get-Content $statePath -Raw | ConvertFrom-Json
  foreach ($pidValue in @($state.appPid, $state.ngrokPid, $state.hubPid)) {
    Stop-Tree $pidValue
  }
  Remove-Item -LiteralPath $statePath -Force
  $stopped = $true
}

Stop-PortListeners $HubPort
Stop-PortListeners $BffPort

if ($stopped) { Write-Host 'Public stack stopped.' }
else { Write-Host 'Public stack is not running.' }
