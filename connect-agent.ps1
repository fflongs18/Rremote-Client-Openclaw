[CmdletBinding()]
param(
  [ValidateSet('Check', 'Install', 'Verify', 'Repair', 'Uninstall')]
  [string]$Mode = 'Check',
  [string]$HubUrl = $env:REMOTE_OC_HUB_URL,
  [string]$PairingCode = $env:REMOTE_OC_PAIRING_CODE,
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$SourceUrl = $env:REMOTE_OC_SOURCE_URL,
  [string]$SourceRoot = '',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RemoteOpenClaw'),
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.remote-oc\device.json'),
  [string]$OpenClawUrl = 'ws://127.0.0.1:18789',
  [string]$OpenClawToken = $env:OPENCLAW_GATEWAY_TOKEN,
  [string]$HermesUrl = 'http://127.0.0.1:8642',
  [string]$HermesApiKey = $env:HERMES_API_KEY,
  [string]$HermesModel = $env:HERMES_MODEL,
  [string]$HermesProvider = $env:HERMES_PROVIDER,
  [switch]$NoAutostart,
  [switch]$KeepIdentity,
  [switch]$SkipRuntimeProbe,
  [switch]$TestMode,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskName = 'Remote-OC-Client'
$script:steps = [System.Collections.Generic.List[string]]::new()

function Add-Step([string]$Name) { $script:steps.Add($Name) }
function Write-Result([bool]$Ok, [string]$Stage, [hashtable]$Extra = @{}) {
  $result = [ordered]@{ ok = $Ok; mode = $Mode.ToLowerInvariant(); stage = $Stage; steps = @($script:steps); installDir = $InstallDir; configPath = $ConfigPath }
  foreach ($key in $Extra.Keys) { $result[$key] = $Extra[$key] }
  $encoded = $result | ConvertTo-Json -Depth 8 -Compress
  if ($Json -or $Ok) { Write-Output $encoded } else { Write-Error $encoded }
}
function Get-Node22 {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $major = [int](& $node.Source -p "process.versions.node.split('.')[0]")
    if ($LASTEXITCODE -eq 0 -and $major -ge 22) {
      $script:NpmPath = (Get-Command npm.cmd).Source
      Add-Step 'node-ready'
      return $node.Source
    }
  }
  $runtimeRoot = Join-Path $InstallDir 'runtime'
  $nodeRoot = Join-Path $runtimeRoot 'node'
  $portable = Get-ChildItem -LiteralPath $nodeRoot -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $portable) {
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $release = $index | Where-Object { $_.version -match '^v22\.' -and $_.lts } | Select-Object -First 1
    if (-not $release) { throw 'Unable to resolve a Node.js 22 LTS release' }
    $archiveName = "node-$($release.version)-win-x64.zip"
    $base = "https://nodejs.org/dist/$($release.version)"
    $archive = Join-Path $runtimeRoot $archiveName
    $checksums = Join-Path $runtimeRoot 'SHASUMS256.txt'
    Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $checksums
    Invoke-WebRequest "$base/$archiveName" -OutFile $archive
    $expected = ((Get-Content $checksums | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" }) -split '\s+')[0]
    if (-not $expected -or (Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Portable Node.js checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $nodeRoot
    Remove-Item -LiteralPath $archive, $checksums -Force
    $portable = Get-ChildItem -LiteralPath $nodeRoot -Filter node.exe -Recurse | Select-Object -First 1
    Add-Step 'node-installed'
  } else { Add-Step 'node-ready' }
  $script:NpmPath = Join-Path $portable.Directory.FullName 'npm.cmd'
  return $portable.FullName
}
function Test-TcpEndpoint([string]$Url) {
  try {
    $uri = [Uri]$Url
    $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq 'wss') { 443 } else { 80 }
    $client = [Net.Sockets.TcpClient]::new()
    try { $client.ConnectAsync($uri.Host, $port).Wait(1500) -and $client.Connected } finally { $client.Dispose() }
  } catch { $false }
}
function Get-RuntimeState {
  if ($TestMode) { return [ordered]@{ openclaw = 'ready'; hermes = 'ready' } }
  $openClaw = if (Test-TcpEndpoint $OpenClawUrl) { 'ready' } else { 'unavailable' }
  $hermes = 'unavailable'
  try {
    $headers = @{}
    if ($HermesApiKey) { $headers.Authorization = "Bearer $HermesApiKey" }
    Invoke-RestMethod -Uri ($HermesUrl.TrimEnd('/') + '/v1/capabilities') -Headers $headers -TimeoutSec 3 | Out-Null
    $hermes = 'ready'
  } catch {}
  [ordered]@{ openclaw = $openClaw; hermes = $hermes }
}
function Resolve-Source {
  if ($SourceRoot) { return (Resolve-Path $SourceRoot).Path }
  $local = $PSScriptRoot
  if (Test-Path (Join-Path $local 'package.json')) { return $local }
  if (-not $SourceUrl) { throw 'SourceUrl is required when the bootstrap script is not inside the Remote Client repository' }
  $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-source-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
  $archive = Join-Path $downloadRoot 'source.zip'
  Invoke-WebRequest -Uri $SourceUrl -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $downloadRoot
  $package = Get-ChildItem -LiteralPath $downloadRoot -Filter package.json -Recurse | Where-Object { $_.FullName -notmatch 'node_modules' } | Select-Object -First 1
  if (-not $package) { throw 'Downloaded source does not contain package.json' }
  Add-Step 'source-downloaded'
  return $package.Directory.FullName
}
function Copy-Source([string]$From) {
  $resolvedFrom = (Resolve-Path $From).Path.TrimEnd('\')
  $resolvedTarget = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  if ($resolvedFrom -ieq $resolvedTarget) { return }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Get-ChildItem -LiteralPath $resolvedFrom -Force | Where-Object { $_.Name -notin @('.git', 'node_modules', '.tmp', 'artifacts') } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $InstallDir -Recurse -Force
  }
  Add-Step 'source-installed'
}
function Invoke-NpmBuild {
  Push-Location $InstallDir
  try {
    & $script:NpmPath install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm install failed' }
    & $script:NpmPath run build -w '@remote-oc/protocol'
    if ($LASTEXITCODE) { throw 'protocol build failed' }
    & $script:NpmPath run build -w '@remote-oc/client'
    if ($LASTEXITCODE) { throw 'client build failed' }
  } finally { Pop-Location }
  Add-Step 'client-built'
}
function Write-TestConfig {
  $directory = Split-Path -Parent $ConfigPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  [ordered]@{
    version = 1; nodeId = 'remote-oc-test-node'; nodeToken = 'test-node-token'; nodeName = $DeviceName
    hubWsUrl = ($HubUrl -replace '^http', 'ws'); hubHttpUrl = $HubUrl
    openClaw = @{ url = $OpenClawUrl; token = if ($OpenClawToken) { 'configured' } else { $null } }
    hermes = @{ url = $HermesUrl; apiKey = if ($HermesApiKey) { 'configured' } else { $null }; model = $HermesModel; provider = $HermesProvider }
    createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  Add-Step 'paired'
}
function Invoke-Pair([string]$NodePath) {
  if ((Test-Path $ConfigPath) -and -not $PairingCode) { Add-Step 'identity-reused'; return }
  if (-not $HubUrl -or -not $PairingCode) { throw 'HubUrl and one-time PairingCode are required for first installation' }
  if ($TestMode) { Write-TestConfig; return }
  $env:REMOTE_CLIENT_CONFIG = $ConfigPath
  $env:REMOTE_OC_PAIRING_CODE = $PairingCode
  $env:OPENCLAW_GATEWAY_TOKEN = $OpenClawToken
  $env:HERMES_API_KEY = $HermesApiKey
  $env:HERMES_MODEL = $HermesModel
  $env:HERMES_PROVIDER = $HermesProvider
  $pairScript = Join-Path $InstallDir 'packages\apps\client\dist\pair.js'
  & $NodePath $pairScript --hub-url $HubUrl --name $DeviceName --gateway-url $OpenClawUrl --hermes-url $HermesUrl
  if ($LASTEXITCODE) { throw 'Pairing failed' }
  Add-Step 'paired'
}
function Install-Autostart([string]$NodePath) {
  $launcher = Join-Path $InstallDir 'run-client.cmd'
  @("@echo off", "set `"REMOTE_CLIENT_CONFIG=$ConfigPath`"", "`"$NodePath`" `"$(Join-Path $InstallDir 'packages\apps\client\dist\index.js')`"") | Set-Content -LiteralPath $launcher -Encoding ASCII
  if ($TestMode) {
    @{ taskName = $taskName; launcher = $launcher } | ConvertTo-Json | Set-Content (Join-Path $InstallDir 'autostart.test.json') -Encoding UTF8
  } else {
    $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/c `"$launcher`"" -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'OpenClaw/Hermes Remote Client' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
  }
  Add-Step 'autostart-installed'
}
function Invoke-Verify([string]$NodePath) {
  if (-not (Test-Path $ConfigPath)) { throw 'Device config is missing; install and pair first' }
  $runtimes = Get-RuntimeState
  if (-not $SkipRuntimeProbe -and $runtimes.openclaw -eq 'unavailable' -and $runtimes.hermes -eq 'unavailable') { throw 'Neither OpenClaw nor Hermes is reachable' }
  if (-not $TestMode) {
    $env:REMOTE_CLIENT_CONFIG = $ConfigPath
    & $NodePath (Join-Path $InstallDir 'packages\apps\client\dist\verify-install.js') --mode wss
    if ($LASTEXITCODE) { throw 'Hub WebSocket verification failed' }
  }
  Add-Step 'verified'
  return $runtimes
}

try {
  if ($Mode -eq 'Uninstall') {
    if ($TestMode) { Remove-Item (Join-Path $InstallDir 'autostart.test.json') -Force -ErrorAction SilentlyContinue }
    else { Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false }
    Add-Step 'autostart-removed'
    if (-not $KeepIdentity) { Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue; Add-Step 'identity-removed' }
    Write-Result $true 'complete'
    exit 0
  }

  $nodePath = if ($TestMode) { 'node' } else { Get-Node22 }
  $runtimeState = Get-RuntimeState
  if ($Mode -eq 'Check') { Write-Result $true 'complete' @{ runtimes = $runtimeState; node = if ($TestMode) { 'test' } else { $nodePath } }; exit 0 }

  if ($Mode -in @('Install', 'Repair')) {
    if ($TestMode) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null; Add-Step 'client-built' }
    else { $source = Resolve-Source; Copy-Source $source; Invoke-NpmBuild }
    Invoke-Pair $nodePath
    if (-not $NoAutostart) { Install-Autostart $nodePath }
  }
  $runtimeState = Invoke-Verify $nodePath
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  Write-Result $true 'complete' @{ nodeId = $config.nodeId; nodeName = $config.nodeName; hub = 'connected'; runtimes = $runtimeState; autostart = if ($NoAutostart) { 'disabled' } else { 'installed' } }
} catch {
  Write-Result $false 'failed' @{ error = $_.Exception.Message }
  exit 1
}
