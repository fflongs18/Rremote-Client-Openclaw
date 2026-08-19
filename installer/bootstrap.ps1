[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$PackageUrl,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$HubUrl,
  [Parameter(Mandatory = $true)][string]$PairingCode,
  [string]$DeviceName = $env:COMPUTERNAME,
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
$root = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-bootstrap-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $archive = Join-Path $root 'release.zip'
  Invoke-WebRequest -Uri $PackageUrl -OutFile $archive
  $actual = (Get-FileHash $archive -Algorithm SHA256).Hash
  if ($actual -ine $ExpectedSha256) { throw 'Release package SHA256 mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $root
  $release = if (Test-Path (Join-Path $root 'manifest.json')) {
    Get-Item -LiteralPath $root
  } else {
    Get-ChildItem -LiteralPath $root -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } | Select-Object -First 1
  }
  if (-not $release) { throw 'Downloaded release does not contain manifest.json' }
  $installer = Join-Path $release.FullName 'install.ps1'
  if (-not (Test-Path $installer)) { throw 'Downloaded release installer is missing' }
  $manifest = Get-Content (Join-Path $release.FullName 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.signed -eq $true) {
    $bootstrapSignature = Get-AuthenticodeSignature -FilePath (Join-Path $release.FullName 'bootstrap.ps1')
    if ($bootstrapSignature.Status -ne 'Valid') { throw "Release bootstrap signature is not valid: $($bootstrapSignature.Status)" }
    $signature = Get-AuthenticodeSignature -FilePath $installer
    if ($signature.Status -ne 'Valid') { throw "Release installer signature is not valid: $($signature.Status)" }
  }

  $arguments = @{
    HubUrl = $HubUrl; PairingCode = $PairingCode; DeviceName = $DeviceName; PackageRoot = $release.FullName
    OpenClawUrl = $OpenClawUrl; OpenClawToken = $OpenClawToken; HermesUrl = $HermesUrl; HermesApiKey = $HermesApiKey
    HermesModel = $HermesModel; HermesProvider = $HermesProvider; DefaultRuntime = $DefaultRuntime
    HermesExecutable = $HermesExecutable; HermesWorkingDirectory = $HermesWorkingDirectory; Json = $Json
  }
  if ($NoAutostart) { $arguments.NoAutostart = $true }
  if ($RequireHermes) { $arguments.RequireHermes = $true }
  if ($StartHermes) { $arguments.StartHermes = $true }
  & $installer @arguments
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} catch {
  $result = @{ ok = $false; stage = 'bootstrap-failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress
  if ($Json) { Write-Output $result } else { Write-Error $result }
  exit 1
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
