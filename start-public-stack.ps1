param(
  [string]$HubPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'xihe-jianmu-ipc'),
  [string]$PublicHttpUrl = '',
  [string]$Domain = '',
  [int]$HubPort = 3179,
  [int]$BffPort = 8787,
  [string]$StateDir = (Join-Path $env:USERPROFILE '.remote-oc\public-stack')
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $StateDir 'state.json'
$secretPath = Join-Path $StateDir 'auth-token.txt'
$logDir = Join-Path $StateDir 'logs'

function Wait-Json([string]$Url, [hashtable]$Headers = @{}, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $lastError = $null
  do {
    try { return Invoke-RestMethod -Uri $Url -Headers $Headers -TimeoutSec 5 }
    catch {
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      if ($status) { $lastError = "HTTP $status" }
      else { $lastError = $_.Exception.Message }
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  if ($lastError) { throw "Timed out waiting for $Url ($lastError)" }
  throw "Timed out waiting for $Url"
}

function Assert-PortFree([int]$Port) {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { return }
  $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  throw "Port $Port is already in use by PID(s): $($pids -join ', '). Stop that Hub/process (or run .\stop-public-stack.ps1) and retry."
}

function Find-Ngrok {
  $command = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $root = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $candidate = Get-ChildItem -LiteralPath $root -Filter ngrok.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  throw 'ngrok is not installed'
}

if (-not (Test-Path (Join-Path $HubPath 'hub.mjs'))) { throw "Hub not found: $HubPath" }
if (-not (Test-Path (Join-Path $PSScriptRoot 'package.json'))) { throw "Remote Client project not found: $PSScriptRoot" }

New-Item -ItemType Directory -Force -Path $StateDir, $logDir | Out-Null
if (Test-Path $statePath) {
  $old = Get-Content $statePath -Raw | ConvertFrom-Json
  $live = @($old.hubPid, $old.ngrokPid, $old.appPid) | Where-Object { $_ -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) }
  if ($live.Count -gt 0) { throw "Public stack is already running. Run .\stop-public-stack.ps1 first." }
  Remove-Item -LiteralPath $statePath -Force
}

if (-not (Test-Path $secretPath)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $secretPath -NoNewline -Encoding ASCII
}
$token = (Get-Content $secretPath -Raw).Trim()
$ngrok = Find-Ngrok
$defaultDomain = 'carpenter-tyke-similarly.ngrok-free.dev'
if (-not $PublicHttpUrl) {
  $PublicHttpUrl = if ($Domain) { "https://$Domain" } else { "https://$defaultDomain" }
}
try { $publicUri = [Uri]$PublicHttpUrl } catch { throw "PublicHttpUrl must be a valid URL, for example https://hub.example.com" }
if ($publicUri.Scheme -ne 'https' -or -not $publicUri.Host -or $publicUri.AbsolutePath -ne '/') {
  throw 'PublicHttpUrl must use https and contain only scheme plus hostname'
}
$publicHttp = $publicUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
$publicWs = "wss://$($publicUri.Host)$(if($publicUri.IsDefaultPort){''}else{":$($publicUri.Port)"})"
$ngrokUrl = $publicUri.Host
$dbPath = Join-Path $StateDir 'hub.db'
Assert-PortFree $HubPort
Assert-PortFree $BffPort

$env:IPC_PORT = [string]$HubPort
$env:IPC_HUB_BIND = '127.0.0.1'
$env:IPC_AUTH_TOKEN = $token
$env:IPC_DB_PATH = $dbPath
$env:JIANMU_PUBLIC_HTTP_URL = $publicHttp
$env:JIANMU_PUBLIC_WS_URL = $publicWs

# Pass env explicitly so Start-Process cannot drop session variables on Windows PowerShell.
$hubArgs = @(
  "/c",
  "set `"IPC_PORT=$HubPort`"&& set `"IPC_HUB_BIND=127.0.0.1`"&& set `"IPC_AUTH_TOKEN=$token`"&& set `"IPC_DB_PATH=$dbPath`"&& set `"JIANMU_PUBLIC_HTTP_URL=$publicHttp`"&& set `"JIANMU_PUBLIC_WS_URL=$publicWs`"&& node hub.mjs"
)
$hub = Start-Process -FilePath $env:ComSpec -ArgumentList $hubArgs -WorkingDirectory $HubPath -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $logDir 'hub.out.log') -RedirectStandardError (Join-Path $logDir 'hub.err.log')
try {
  $auth = @{ Authorization = "Bearer $token" }
  Wait-Json "http://127.0.0.1:$HubPort/health" $auth | Out-Null

  $tunnel = Start-Process -FilePath $ngrok -ArgumentList @('http', "--url=$ngrokUrl", [string]$HubPort) -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'ngrok.out.log') -RedirectStandardError (Join-Path $logDir 'ngrok.err.log')
  $publicHeaders = @{ Authorization = "Bearer $token"; 'ngrok-skip-browser-warning' = '1' }
  Wait-Json "$publicHttp/health" $publicHeaders 45 | Out-Null

  $env:JIANMU_HTTP_URL = "http://127.0.0.1:$HubPort"
  $env:JIANMU_HUB_URL = "ws://127.0.0.1:$HubPort"
  $env:JIANMU_AUTH_TOKEN = $token
  $env:BFF_PORT = [string]$BffPort
  $app = Start-Process -FilePath (Get-Command npm.cmd).Source -ArgumentList @('run', 'dev') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'app.out.log') -RedirectStandardError (Join-Path $logDir 'app.err.log')
  Wait-Json "http://127.0.0.1:$BffPort/api/health" @{} 45 | Out-Null

  [pscustomobject]@{
    startedAt = (Get-Date).ToString('o')
    hubPid = $hub.Id
    ngrokPid = $tunnel.Id
    appPid = $app.Id
    hubPort = $HubPort
    bffPort = $BffPort
    publicHttpUrl = $publicHttp
    publicWsUrl = $publicWs
    logDir = $logDir
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

  Write-Host 'Public stack is ready.'
  Write-Host "Web/BFF: http://127.0.0.1:$BffPort"
  Write-Host "Public HTTP: $publicHttp"
  Write-Host "Public WSS:  $publicWs"
  Write-Host "Logs: $logDir"
} catch {
  foreach ($process in @($app, $tunnel, $hub)) {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  throw
}
