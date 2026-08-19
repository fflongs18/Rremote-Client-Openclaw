[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$HubUrl,
  [Parameter(Mandatory = $true)][string]$PairingCode,
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$PackageRoot = $PSScriptRoot,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RemoteOpenClaw'),
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.remote-oc\device.json'),
  [string]$OpenClawUrl = 'ws://127.0.0.1:18789',
  [string]$OpenClawToken = $env:OPENCLAW_GATEWAY_TOKEN,
  [string]$HermesUrl = 'http://127.0.0.1:8642',
  [string]$HermesApiKey = $env:HERMES_API_KEY,
  [string]$HermesModel = $env:HERMES_MODEL,
  [string]$HermesProvider = $env:HERMES_PROVIDER,
  [ValidateSet('openclaw', 'hermes')][string]$DefaultRuntime = 'openclaw',
  [switch]$RequireHermes,
  [switch]$StartHermes,
  [string]$HermesExecutable = 'hermes',
  [string]$HermesWorkingDirectory = '',
  [switch]$NoAutostart,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$taskName = 'Remote-OC-Client'

function Result([bool]$Ok, [string]$Stage, [hashtable]$Extra = @{}) {
  $value = [ordered]@{ ok = $Ok; stage = $Stage; installDir = $InstallDir; configPath = $ConfigPath }
  foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] }
  if ($Ok -and $value.Contains('message')) { $value.message = ([char]0x63a5 + [char]0x5165 + [char]0x6210 + [char]0x529f) }
  $text = $value | ConvertTo-Json -Depth 8 -Compress
  if ($Json -or $Ok) { Write-Output $text } else { Write-Error $text }
}

function Assert-Release {
  $manifestPath = Join-Path $PackageRoot 'manifest.json'
  if (-not (Test-Path $manifestPath)) { throw 'Release manifest.json is missing' }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  foreach ($file in @($manifest.files)) {
    $path = Join-Path $PackageRoot ($file.path -replace '/', '\')
    if (-not (Test-Path $path)) { throw "Release file is missing: $($file.path)" }
    $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne [string]$file.sha256) { throw "Release checksum mismatch: $($file.path)" }
  }
  return $manifest
}

function Invoke-Node([string]$NodePath, [string]$ScriptPath, [string[]]$Arguments) {
  & $NodePath $ScriptPath @Arguments
  if ($LASTEXITCODE) { throw "Client command failed: $([IO.Path]::GetFileName($ScriptPath))" }
}

function Test-HermesCapabilities {
  $headers = @{}; if ($HermesApiKey) { $headers.Authorization = "Bearer $HermesApiKey" }
  try {
    $features = (Invoke-RestMethod -Uri ($HermesUrl.TrimEnd('/') + '/v1/capabilities') -Headers $headers -TimeoutSec 5).features
    if (-not ($features.run_submission -eq $true -and $features.run_events_sse -eq $true -and $features.run_stop -eq $true)) { throw 'required Runs API capabilities are missing' }
    return @{ ready = $true; url = $HermesUrl; detail = 'Runs API ready' }
  } catch {
    $detail = $_.Exception.Message
    if ($detail -match '404|Headless backend|web UI disabled') { throw "Hermes is running in UI/headless mode. Start 'hermes gateway'; 'hermes serve' is not compatible ($detail)" }
    throw "Hermes API is not ready at $HermesUrl. Configure API_SERVER_ENABLED=true and start 'hermes gateway' ($detail)"
  }
}

function Ensure-Hermes {
  if (-not ($RequireHermes -or $StartHermes)) { return @{ ready = $false; required = $false; detail = 'not required' } }
  if (-not $HermesApiKey -or $HermesApiKey.Length -lt 16) { throw 'HermesApiKey must contain at least 16 characters when Hermes is required' }
  try { return Test-HermesCapabilities } catch { if (-not $StartHermes) { throw } }
  $command = Get-Command $HermesExecutable -ErrorAction SilentlyContinue
  if (-not $command) { throw "Hermes executable was not found: $HermesExecutable" }
  $old = @{}; foreach ($name in @('API_SERVER_ENABLED','API_SERVER_HOST','API_SERVER_PORT','API_SERVER_KEY')) { $old[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    $env:API_SERVER_ENABLED = 'true'; $env:API_SERVER_HOST = '127.0.0.1'; $env:API_SERVER_PORT = ([Uri]$HermesUrl).Port.ToString(); $env:API_SERVER_KEY = $HermesApiKey
    $working = if ($HermesWorkingDirectory) { $HermesWorkingDirectory } else { (Get-Location).Path }
    Start-Process -FilePath $command.Source -ArgumentList @('gateway') -WorkingDirectory $working -WindowStyle Hidden | Out-Null
  } finally { foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name], 'Process') } }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do { try { return Test-HermesCapabilities } catch { Start-Sleep -Seconds 1 } } while ([DateTime]::UtcNow -lt $deadline)
  throw "Hermes gateway did not expose a compatible Runs API at $HermesUrl within 20 seconds"
}

function Install-Launcher([string]$NodePath, [string]$ClientEntry) {
  $launcher = Join-Path $InstallDir 'run-client.cmd'
  @(
    '@echo off',
    "set `"AGENT_RUNTIME=$DefaultRuntime`"",
    "set `"REMOTE_CLIENT_CONFIG=$ConfigPath`"",
    "set `"PATH=$InstallDir\runtime;%PATH%`"",
    "`"$NodePath`" `"$ClientEntry`""
  ) | Set-Content -LiteralPath $launcher -Encoding ASCII
  if (-not $NoAutostart) {
    $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/c `"$launcher`"" -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'OpenClaw/Hermes Remote Client' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
  }
  return $launcher
}

function Wait-ForOnline([string]$NodePath, [string]$VerifyScript, [string]$NodeId, [string]$NodeToken, [string]$HttpUrl) {
  $env:REMOTE_CLIENT_CONFIG = $ConfigPath
  Invoke-Node $NodePath $VerifyScript @('--mode', 'online', '--timeout-ms', '30000')
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    try {
      $node = Invoke-RestMethod -Uri ($HttpUrl.TrimEnd('/') + '/nodes/' + [Uri]::EscapeDataString($NodeId)) -Headers @{ Authorization = "Bearer $NodeToken" } -TimeoutSec 5
      $ready = @($node.runtimes | Where-Object { $_.ready -eq $true })
      if ($node.online -eq $true -and $ready.Count -gt 0) { return $node }
    } catch {}
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Hub did not report the installed device online with a ready runtime'
}

try {
  $manifest = Assert-Release
  $hermesStatus = Ensure-Hermes
  $nodePath = Join-Path $PackageRoot 'runtime\node.exe'
  $appRoot = Join-Path $PackageRoot 'app'
  $pairScript = Join-Path $appRoot 'client\dist\pair.js'
  $verifyScript = Join-Path $appRoot 'client\dist\verify-install.js'
  foreach ($required in @($nodePath, $pairScript, $verifyScript)) { if (-not (Test-Path $required)) { throw "Release payload is incomplete: $required" } }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'app') -Destination $InstallDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'runtime') -Destination $InstallDir -Recurse -Force
  $installedApp = Join-Path $InstallDir 'app'
  $installedNode = Join-Path $InstallDir 'runtime\node.exe'
  $installedPair = Join-Path $installedApp 'client\dist\pair.js'
  $installedVerify = Join-Path $installedApp 'client\dist\verify-install.js'

  $env:REMOTE_CLIENT_CONFIG = $ConfigPath
  $env:REMOTE_OC_PAIRING_CODE = $PairingCode
  $env:OPENCLAW_GATEWAY_TOKEN = $OpenClawToken
  $env:HERMES_API_KEY = $HermesApiKey
  $env:HERMES_MODEL = $HermesModel
  $env:HERMES_PROVIDER = $HermesProvider
  Push-Location $installedApp
  try {
    Invoke-Node $installedNode $installedPair @('--hub-url', $HubUrl, '--name', $DeviceName, '--gateway-url', $OpenClawUrl, '--hermes-url', $HermesUrl)
  } finally { Pop-Location }

  $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $launcher = Install-Launcher $installedNode (Join-Path $installedApp 'client\dist\index.js')
  if (-not $NoAutostart) {
    $online = Wait-ForOnline $installedNode $installedVerify $config.nodeId $config.nodeToken $config.hubHttpUrl
  }
  Result $true 'complete' @{ message = '接入成功'; nodeId = $config.nodeId; nodeName = $config.nodeName; hub = 'connected'; online = (-not $NoAutostart); hermes = $hermesStatus; runtimes = if ($online) { $online.runtimes } else { @() }; launcher = $launcher; packageVersion = $manifest.packageVersion }
} catch {
  Result $false 'failed' @{ error = $_.Exception.Message }
  exit 1
}
