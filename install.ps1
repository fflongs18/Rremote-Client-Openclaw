[CmdletBinding()]
param(
  [string]$ManifestUrl = $env:REMOTE_OC_RELEASE_MANIFEST_URL,
  [string]$ManifestPath = '',
  [string]$HubUrl = '',
  [string]$PairingCode = '',
  [string]$EnrollUrl = '',
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RemoteOpenClaw'),
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.remote-oc\device.json'),
  [string]$OpenClawUrl = 'ws://127.0.0.1:18789',
  [string]$OpenClawToken = $env:OPENCLAW_GATEWAY_TOKEN,
  [string]$HermesUrl = 'http://127.0.0.1:8642',
  [string]$HermesApiKey = $env:HERMES_API_KEY,
  [string]$HermesModel = $env:HERMES_MODEL,
  [string]$HermesProvider = $env:HERMES_PROVIDER,
  [string]$HermesExecutable = 'hermes',
  [string]$HermesWorkingDirectory = '',
  [ValidateSet('openclaw', 'hermes')][string]$DefaultRuntime = 'openclaw',
  [switch]$RequireHermes,
  [switch]$StartHermes,
  [switch]$NoAutostart,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
$downloadHeaders = @{ 'ngrok-skip-browser-warning' = '1' }

function Say([string]$EncodedMessage) {
  $message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedMessage))
  Write-Host "`n[Remote-OC] $message"
}

function Assert-DownloadedContent([string]$Path, [ValidateSet('script', 'json', 'archive')][string]$Kind) {
  if (-not (Test-Path -LiteralPath $Path) -or (Get-Item -LiteralPath $Path).Length -eq 0) { throw "Downloaded $Kind file is empty" }
  if ($Kind -eq 'archive') { return }
  $content = Get-Content -LiteralPath $Path -Raw
  if ($content -match '(?im)^\s*ERR_NGROK_\d+\s*$|^\s*You are about to visit') { throw 'ngrok returned an interstitial page instead of the requested release file' }
  if ($Kind -eq 'json') {
    try { $null = $content | ConvertFrom-Json } catch { throw 'Downloaded release manifest is not valid JSON' }
  }
}

function Invoke-ReleaseDownload([string]$Uri, [string]$OutFile, [ValidateSet('script', 'json', 'archive')][string]$Kind) {
  $downloadUri = $Uri
  if ($downloadUri -match 'ngrok') {
    $downloadUri += $(if ($downloadUri.Contains('?')) { '&' } else { '?' }) + 'ngrok-skip-browser-warning=1'
  }
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
      $request = [Net.HttpWebRequest]::Create($downloadUri)
      $request.AllowAutoRedirect = $true
      $request.Timeout = 30000
      $request.ReadWriteTimeout = 600000
      $request.UserAgent = 'Remote-OC-Installer/1.0'
      $request.Headers.Add('ngrok-skip-browser-warning', '1')
      $response = $null; $input = $null; $output = $null
      try {
        $response = $request.GetResponse()
        $total = [long]$response.ContentLength
        $input = $response.GetResponseStream()
        $output = [IO.File]::Create($OutFile)
        $buffer = New-Object byte[] 65536
        $received = [long]0
        while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $output.Write($buffer, 0, $count)
          $received += $count
          $status = if ($total -gt 0) { '{0:N1} / {1:N1} MB' -f ($received / 1MB), ($total / 1MB) } else { '{0:N1} MB' -f ($received / 1MB) }
          $activity = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('W1JlbW90ZS1PQ10g5q2j5Zyo5LiL6L29'))
          $progress = @{ Activity = $activity; Status = $status }
          if ($total -gt 0) { $progress.PercentComplete = [Math]::Min(100, [int](100 * $received / $total)) }
          Write-Progress @progress
        }
      } finally {
        if ($activity) { Write-Progress -Activity $activity -Completed }
        if ($output) { $output.Dispose() }
        if ($input) { $input.Dispose() }
        if ($response) { $response.Dispose() }
      }
      Assert-DownloadedContent -Path $OutFile -Kind $Kind
      return
    } catch {
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      if (($status -ge 400 -and $status -lt 500) -or $attempt -eq 4) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

if ($EnrollUrl) {
  Say '5q2j5Zyo6I635Y+W5a6J5YWo5a6J6KOF6YWN572u'
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try { $enrollment = Invoke-RestMethod -Method Post -Headers $downloadHeaders -Uri $EnrollUrl -ContentType 'application/json'; break }
    catch {
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      if (($status -ge 400 -and $status -lt 500) -or $attempt -eq 4) { throw }
      Start-Sleep -Seconds 2
    }
  }
  $HubUrl = [string]$enrollment.hubUrl
  $PairingCode = [string]$enrollment.pairingCode
  $DeviceName = [string]$enrollment.deviceName
  if ($enrollment.manifestUrl) { $ManifestUrl = [string]$enrollment.manifestUrl }
  if ($enrollment.openClawUrl) { $OpenClawUrl = [string]$enrollment.openClawUrl }
  if ($enrollment.hermesUrl) { $HermesUrl = [string]$enrollment.hermesUrl }
  if ($enrollment.hermesApiKey) { $HermesApiKey = [string]$enrollment.hermesApiKey }
  if ($enrollment.defaultRuntime) { $DefaultRuntime = [string]$enrollment.defaultRuntime }
  if ($enrollment.requireHermes) { $RequireHermes = $true }
  if ($enrollment.startHermes) { $StartHermes = $true }
}
if (-not $HubUrl -or -not $PairingCode) { throw 'HubUrl and PairingCode or EnrollUrl are required' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-unified-' + [guid]::NewGuid().ToString('N'))
if (-not $ManifestPath -and -not $ManifestUrl -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release.json'))) {
  $ManifestPath = Join-Path $PSScriptRoot 'release.json'
}
function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
  } finally { $stream.Dispose() }
}
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $downloadedManifest = Join-Path $root 'release.json'
  Say '5q2j5Zyo6I635Y+W54mI5pys5riF5Y2V'
  if ($ManifestPath) { Copy-Item -LiteralPath $ManifestPath -Destination $downloadedManifest }
  elseif ($ManifestUrl -match '^https://') { Invoke-ReleaseDownload -Uri $ManifestUrl -OutFile $downloadedManifest -Kind json }
  else { throw 'ManifestUrl must use HTTPS, or provide ManifestPath for an offline install' }
  $manifest = Get-Content $downloadedManifest -Raw | ConvertFrom-Json
  $nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $platform = if ($nativeArchitecture -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }
  $entry = $manifest.platforms.$platform
  if (-not $entry -or [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "release manifest has no usable $platform package" }
  $archive = Join-Path $root 'package.zip'
  $packageLocation = [string]$entry.url
  if ($packageLocation -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://' -and -not [IO.Path]::IsPathRooted($packageLocation)) {
    if ($ManifestPath) { $packageLocation = Join-Path (Split-Path -Parent (Resolve-Path $ManifestPath)) $packageLocation }
    else { $packageLocation = [Uri]::new([Uri]$ManifestUrl, $packageLocation).AbsoluteUri }
  }
  Say '5q2j5Zyo5LiL6L29IFdpbmRvd3Mg5a6J6KOF5YyF'
  if (Test-Path -LiteralPath $packageLocation) { Copy-Item -LiteralPath $packageLocation -Destination $archive }
  elseif ($packageLocation -match '^https://') { Invoke-ReleaseDownload -Uri $packageLocation -OutFile $archive -Kind archive }
  else { throw 'Windows package URL must use HTTPS' }
  Say '5q2j5Zyo5qCh6aqM5a6J6KOF5YyF'
  if ((Get-Sha256Hex $archive) -ine [string]$entry.sha256) { throw 'release SHA-256 mismatch' }
  $releaseRoot = Join-Path $root 'release'
  Say '5q2j5Zyo6Kej5Y6L5bm25a6J6KOFIFJlbW90ZS1PQw=='
  Expand-Archive -LiteralPath $archive -DestinationPath $releaseRoot
  $installerPath = Join-Path $releaseRoot 'install.ps1'
  if (-not (Test-Path -LiteralPath $installerPath)) { throw 'release package does not contain install.ps1' }
  $arguments = @{
    PackageRoot = $releaseRoot; HubUrl = $HubUrl; PairingCode = $PairingCode; DeviceName = $DeviceName; Json = $Json
    InstallDir = $InstallDir; ConfigPath = $ConfigPath
    OpenClawUrl = $OpenClawUrl; OpenClawToken = $OpenClawToken; HermesUrl = $HermesUrl; HermesApiKey = $HermesApiKey
    HermesModel = $HermesModel; HermesProvider = $HermesProvider; HermesExecutable = $HermesExecutable
    HermesWorkingDirectory = $HermesWorkingDirectory; DefaultRuntime = $DefaultRuntime
  }
  if ($NoAutostart) { $arguments.NoAutostart = $true }
  if ($RequireHermes) { $arguments.RequireHermes = $true }
  if ($StartHermes) { $arguments.StartHermes = $true }
  Say '5q2j5Zyo6L+e5o6l5Li75o6n5bm25ZCv5YqoIEFnZW50'
  & $installerPath @arguments
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} catch {
  $result = @{ ok = $false; stage = 'unified-bootstrap-failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress
  if ($Json) { Write-Output $result } else { Write-Error $result }
  exit 1
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
