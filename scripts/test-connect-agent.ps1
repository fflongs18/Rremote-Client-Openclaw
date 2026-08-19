[CmdletBinding()]
param([switch]$KeepTemporaryFiles)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$bootstrap = Join-Path $repo 'connect-agent.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-bootstrap-test-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'app'
$configPath = Join-Path $testRoot 'config\device.json'

function Invoke-Bootstrap([string]$Mode, [string[]]$Additional = @()) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Mode', $Mode, '-TestMode', '-Json', '-InstallDir', $installDir, '-ConfigPath', $configPath) + $Additional
  $output = & powershell.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$Mode failed: $output" }
  return ($output | Select-Object -Last 1 | ConvertFrom-Json)
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

try {
  $check = Invoke-Bootstrap 'Check'
  Assert ($check.ok -and $check.runtimes.openclaw -eq 'ready' -and $check.runtimes.hermes -eq 'ready') 'Check did not discover both runtimes'

  $invalidArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Mode', 'Install', '-TestMode', '-Json', '-InstallDir', $installDir, '-ConfigPath', $configPath)
  $invalid = & powershell.exe @invalidArgs
  Assert ($LASTEXITCODE -ne 0 -and (($invalid | Select-Object -Last 1 | ConvertFrom-Json).error -match 'PairingCode')) 'Install without pairing details did not fail safely'

  $install = Invoke-Bootstrap 'Install' @('-HubUrl', 'https://hub.test.example', '-PairingCode', 'ONE-TIME-CODE', '-DeviceName', 'Bootstrap Test')
  Assert ($install.ok -and (Test-Path $configPath)) 'Install did not create device identity'
  Assert (Test-Path (Join-Path $installDir 'autostart.test.json')) 'Install did not create autostart descriptor'
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  Assert ($config.nodeId -eq 'remote-oc-test-node') 'Unexpected node identity'
  Assert ($config.openClaw.url -eq 'ws://127.0.0.1:18789') 'OpenClaw URL was not persisted'
  Assert ($config.hermes.url -eq 'http://127.0.0.1:8642') 'Hermes URL was not persisted'

  $verify = Invoke-Bootstrap 'Verify'
  Assert ($verify.ok -and $verify.steps -contains 'verified') 'Verify did not complete'

  $repair = Invoke-Bootstrap 'Repair'
  Assert ($repair.ok -and $repair.steps -contains 'identity-reused') 'Repair was not idempotent'

  $uninstallKeep = Invoke-Bootstrap 'Uninstall' @('-KeepIdentity')
  Assert ($uninstallKeep.ok -and (Test-Path $configPath)) 'KeepIdentity removed the identity'
  $uninstall = Invoke-Bootstrap 'Uninstall'
  Assert ($uninstall.ok -and -not (Test-Path $configPath)) 'Uninstall did not remove the identity'

  Write-Output (@{ ok = $true; tests = 7; platform = 'windows'; temporaryRoot = $testRoot } | ConvertTo-Json -Compress)
} finally {
  if (-not $KeepTemporaryFiles) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
