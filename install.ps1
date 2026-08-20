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
if ($EnrollUrl) {
  $enrollment = Invoke-RestMethod -Method Post -Uri $EnrollUrl -ContentType 'application/json'
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
  if ($ManifestPath) { Copy-Item -LiteralPath $ManifestPath -Destination $downloadedManifest }
  elseif ($ManifestUrl -match '^https://') { Invoke-WebRequest -Uri $ManifestUrl -OutFile $downloadedManifest }
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
  if (Test-Path -LiteralPath $packageLocation) { Copy-Item -LiteralPath $packageLocation -Destination $archive }
  elseif ($packageLocation -match '^https://') { Invoke-WebRequest -Uri $packageLocation -OutFile $archive }
  else { throw 'Windows package URL must use HTTPS' }
  if ((Get-Sha256Hex $archive) -ine [string]$entry.sha256) { throw 'release SHA-256 mismatch' }
  $releaseRoot = Join-Path $root 'release'
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
  & $installerPath @arguments
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} catch {
  $result = @{ ok = $false; stage = 'unified-bootstrap-failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress
  if ($Json) { Write-Output $result } else { Write-Error $result }
  exit 1
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
