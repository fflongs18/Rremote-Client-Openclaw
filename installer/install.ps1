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
  [string]$StartupDirectory = '',
  [switch]$NoAutostart,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$taskName = 'Remote-OC-Client'
$startupFileName = 'Remote-OC-Client.cmd'
$hermesTaskName = 'Remote-OC-Hermes-Gateway'
$hermesStartupFileName = 'Remote-OC-Hermes-Gateway.cmd'
if ([string]::IsNullOrWhiteSpace($PackageRoot)) { $PackageRoot = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($PackageRoot)) { throw 'PackageRoot could not be determined' }

function Result([bool]$Ok, [string]$Stage, [hashtable]$Extra = @{}) {
  $value = [ordered]@{ ok = $Ok; stage = $Stage; installDir = $InstallDir; configPath = $ConfigPath }
  foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] }
  if ($Ok -and $value.Contains('message')) { $value.message = ([char]0x63a5 + [char]0x5165 + [char]0x6210 + [char]0x529f) }
  $text = $value | ConvertTo-Json -Depth 8 -Compress
  if ($Json -or $Ok) { Write-Output $text } else { Write-Error $text }
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
  } finally { $stream.Dispose() }
}

function Assert-Release {
  $manifestPath = Join-Path $PackageRoot 'manifest.json'
  if (-not (Test-Path $manifestPath)) { throw 'Release manifest.json is missing' }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  foreach ($file in @($manifest.files)) {
    $path = Join-Path $PackageRoot ($file.path -replace '/', '\')
    if (-not (Test-Path $path)) { throw "Release file is missing: $($file.path)" }
    $actual = Get-Sha256Hex $path
    if ($actual -ne [string]$file.sha256) { throw "Release checksum mismatch: $($file.path)" }
  }
  return $manifest
}

function Invoke-Node([string]$NodePath, [string]$ScriptPath, [string[]]$Arguments) {
  & $NodePath $ScriptPath @Arguments
  if ($LASTEXITCODE) { throw "Client command failed: $([IO.Path]::GetFileName($ScriptPath))" }
}

function Find-OpenClawToken {
  if (-not [string]::IsNullOrWhiteSpace($OpenClawToken)) { return $OpenClawToken }
  $path = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  try {
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    foreach ($candidate in @($config.gateway.auth.token, $config.gateway.token, $config.auth.token, $config.token)) {
      if ($candidate -is [string] -and -not [string]::IsNullOrWhiteSpace($candidate)) { return $candidate }
    }
  } catch {}
  return ''
}

function Find-OrCreateHermesApiKey {
  if (-not [string]::IsNullOrWhiteSpace($HermesApiKey) -and $HermesApiKey.Length -ge 16) { return $HermesApiKey }
  foreach ($candidate in @($env:API_SERVER_KEY, [Environment]::GetEnvironmentVariable('API_SERVER_KEY', 'User'))) {
    if ($candidate -is [string] -and $candidate.Length -ge 16) { return $candidate }
  }
  foreach ($path in @(
    (Join-Path $env:USERPROFILE '.hermes\config.json'),
    (Join-Path $env:APPDATA 'hermes\config.json'),
    (Join-Path $env:USERPROFILE '.hermes.json')
  )) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try {
      $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      foreach ($candidate in @($config.API_SERVER_KEY, $config.apiServerKey, $config.api_key, $config.apiKey, $config.server.key)) {
        if ($candidate -is [string] -and $candidate.Length -ge 16) { return $candidate }
      }
    } catch {}
  }
  foreach ($path in @((Join-Path $env:USERPROFILE '.hermes\.env'), (Join-Path $env:APPDATA 'hermes\.env'))) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $line = Get-Content -LiteralPath $path | Where-Object { $_ -match '^\s*API_SERVER_KEY\s*=' } | Select-Object -First 1
    if ($line) {
      $candidate = (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
      if ($candidate.Length -ge 16) { return $candidate }
    }
  }
  if (Test-Path -LiteralPath $ConfigPath) {
    try {
      $existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
      $candidate = [string]$existing.hermes.apiKey
      if ($candidate.Length -ge 16) { return $candidate }
    } catch {}
  }
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Resolve-StartupDirectory {
  if (-not [string]::IsNullOrWhiteSpace($StartupDirectory)) { return $StartupDirectory }
  $directory = [Environment]::GetFolderPath('Startup')
  if ([string]::IsNullOrWhiteSpace($directory)) { $directory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
  return $directory
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

function Install-HermesLauncher([System.Management.Automation.CommandInfo]$Command) {
  $port = ([Uri]$HermesUrl).Port
  $working = if ($HermesWorkingDirectory) { $HermesWorkingDirectory } else { $env:USERPROFILE }
  $launcher = Join-Path $InstallDir 'run-hermes-gateway.cmd'
  @(
    '@echo off',
    'set "API_SERVER_ENABLED=true"',
    'set "API_SERVER_HOST=127.0.0.1"',
    "set `"API_SERVER_PORT=$port`"",
    "set `"API_SERVER_KEY=$HermesApiKey`"",
    "cd /d `"$working`"",
    "call `"$($Command.Source)`" gateway"
  ) | Set-Content -LiteralPath $launcher -Encoding ASCII

  if ($NoAutostart) {
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', "`"$launcher`"") -WorkingDirectory $working -WindowStyle Hidden | Out-Null
    return @{ launcher = $launcher; autostart = 'none' }
  }
  $startupDirectory = Resolve-StartupDirectory
  $startupLauncher = Join-Path $startupDirectory $hermesStartupFileName
  Remove-Item -LiteralPath $startupLauncher -Force -ErrorAction SilentlyContinue
  try {
    $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/c `"$launcher`"" -WorkingDirectory $working
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $hermesTaskName -Action $action -Trigger $trigger -Description 'Remote-OC Hermes Gateway' -Force | Out-Null
    Start-ScheduledTask -TaskName $hermesTaskName
    return @{ launcher = $launcher; autostart = 'scheduled-task' }
  } catch {
    $scheduledTaskError = $_.Exception.Message
    try { Get-ScheduledTask -TaskName $hermesTaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    New-Item -ItemType Directory -Force -Path $startupDirectory | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $startupLauncher -Force
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', "`"$launcher`"") -WorkingDirectory $working -WindowStyle Hidden | Out-Null
    return @{ launcher = $launcher; autostart = 'startup-folder'; scheduledTaskError = $scheduledTaskError }
  }
}

function Ensure-Hermes {
  $command = Get-Command $HermesExecutable -ErrorAction SilentlyContinue
  if (-not $command) {
    if ($RequireHermes -or $StartHermes) { throw "Hermes executable was not found: $HermesExecutable" }
    return @{ ready = $false; required = $false; detail = 'Hermes is not installed' }
  }
  $script:HermesApiKey = Find-OrCreateHermesApiKey
  try {
    $ready = Test-HermesCapabilities
    $ready.required = [bool]$RequireHermes
    $ready.autostart = 'existing'
    return $ready
  } catch {}
  $launcherStatus = Install-HermesLauncher $command
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    try {
      $ready = Test-HermesCapabilities
      $ready.required = [bool]$RequireHermes
      $ready.autostart = $launcherStatus.autostart
      return $ready
    } catch { Start-Sleep -Seconds 1 }
  } while ([DateTime]::UtcNow -lt $deadline)
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

  if ($NoAutostart) { return @{ launcher = $launcher; autostart = 'none' } }

  $resolvedStartupDirectory = Resolve-StartupDirectory
  $startupLauncher = Join-Path $resolvedStartupDirectory $startupFileName
  Remove-Item -LiteralPath $startupLauncher -Force -ErrorAction SilentlyContinue

  try {
    $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/c `"$launcher`"" -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'OpenClaw/Hermes Remote Client' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    return @{ launcher = $launcher; autostart = 'scheduled-task' }
  } catch {
    $scheduledTaskError = $_.Exception.Message
    try {
      Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    } catch {}

    New-Item -ItemType Directory -Force -Path $resolvedStartupDirectory | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $startupLauncher -Force
    try {
      Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', "`"$launcher`"") -WorkingDirectory $InstallDir -WindowStyle Hidden | Out-Null
    } catch {
      Remove-Item -LiteralPath $startupLauncher -Force -ErrorAction SilentlyContinue
      throw "Scheduled task failed ($scheduledTaskError) and Startup fallback could not be started ($($_.Exception.Message))"
    }
    return @{ launcher = $launcher; autostart = 'startup-folder'; scheduledTaskError = $scheduledTaskError }
  }
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

function Stop-InstalledClient {
  try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
  if (-not (Test-Path -LiteralPath $InstallDir)) { return }
  $resolvedInstallDir = [IO.Path]::GetFullPath($InstallDir)
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolvedInstallDir, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  Start-Sleep -Milliseconds 300
}

function Test-ReusableIdentity {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }
  try {
    $existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $configuredHub = ([string]$existing.hubHttpUrl).TrimEnd('/')
    return ($existing.nodeId -and $existing.nodeToken -and [string]$existing.nodeName -eq $DeviceName -and $configuredHub -eq $HubUrl.TrimEnd('/'))
  } catch { return $false }
}

function Update-RuntimeConfiguration {
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $builder = [UriBuilder]$HubUrl
  $builder.Scheme = if ($builder.Scheme -eq 'https') { 'wss' } else { 'ws' }
  $builder.Path = '/ws'; $builder.Query = ''; $builder.Fragment = ''
  $config.hubWsUrl = $builder.Uri.AbsoluteUri.TrimEnd('/')
  $config.openClaw = [pscustomobject]@{ url = $OpenClawUrl; token = if ($OpenClawToken) { $OpenClawToken } else { $null } }
  $config.hermes = [pscustomobject]@{
    url = $HermesUrl
    apiKey = if ($HermesApiKey) { $HermesApiKey } else { $null }
    model = if ($HermesModel) { $HermesModel } else { $null }
    provider = if ($HermesProvider) { $HermesProvider } else { $null }
  }
  $json = $config | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($ConfigPath, $json + "`n", (New-Object Text.UTF8Encoding($false)))
}

try {
  $manifest = Assert-Release
  $nodePath = Join-Path $PackageRoot 'runtime\node.exe'
  $appRoot = Join-Path $PackageRoot 'app'
  $pairScript = Join-Path $appRoot 'client\dist\pair.js'
  $verifyScript = Join-Path $appRoot 'client\dist\verify-install.js'
  foreach ($required in @($nodePath, $pairScript, $verifyScript)) { if (-not (Test-Path $required)) { throw "Release payload is incomplete: $required" } }

  $reuseIdentity = Test-ReusableIdentity
  Stop-InstalledClient
  Remove-Item -LiteralPath (Join-Path $InstallDir 'app') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $InstallDir 'runtime') -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'app') -Destination $InstallDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'runtime') -Destination $InstallDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'uninstall.ps1') -Destination (Join-Path $InstallDir 'uninstall.ps1') -Force
  $installedApp = Join-Path $InstallDir 'app'
  $installedNode = Join-Path $InstallDir 'runtime\node.exe'
  $installedPair = Join-Path $installedApp 'client\dist\pair.js'
  $installedVerify = Join-Path $installedApp 'client\dist\verify-install.js'

  $OpenClawToken = Find-OpenClawToken
  $hermesStatus = Ensure-Hermes
  $env:REMOTE_CLIENT_CONFIG = $ConfigPath
  $env:REMOTE_OC_PAIRING_CODE = $PairingCode
  $env:OPENCLAW_GATEWAY_TOKEN = $OpenClawToken
  $env:HERMES_API_KEY = $HermesApiKey
  $env:HERMES_MODEL = $HermesModel
  $env:HERMES_PROVIDER = $HermesProvider
  if (-not $reuseIdentity) {
    Push-Location $installedApp
    try {
      Invoke-Node $installedNode $installedPair @('--hub-url', $HubUrl, '--name', $DeviceName, '--gateway-url', $OpenClawUrl, '--hermes-url', $HermesUrl)
    } finally { Pop-Location }
  }
  Update-RuntimeConfiguration

  $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $launcherStatus = Install-Launcher $installedNode (Join-Path $installedApp 'client\dist\index.js')
  if (-not $NoAutostart) {
    $online = Wait-ForOnline $installedNode $installedVerify $config.nodeId $config.nodeToken $config.hubHttpUrl
  }
  Result $true 'complete' @{ message = '接入成功'; nodeId = $config.nodeId; nodeName = $config.nodeName; identity = if ($reuseIdentity) { 'reused' } else { 'paired' }; hub = 'connected'; online = (-not $NoAutostart); hermes = $hermesStatus; runtimes = if ($online) { $online.runtimes } else { @() }; launcher = $launcherStatus.launcher; autostart = $launcherStatus.autostart; packageVersion = $manifest.packageVersion }
} catch {
  Result $false 'failed' @{ error = $_.Exception.Message }
  exit 1
}
