[CmdletBinding()]
param(
  [string]$PackagePath = '',
  [switch]$KeepTemporaryFiles
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $PackagePath) {
  $PackagePath = Join-Path $repo 'artifacts\RemoteOpenClaw-0.1.0-win-x64.zip'
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-release-test-' + [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $testRoot 'release'
$installDir = Join-Path $testRoot 'installed'
$configPath = Join-Path $testRoot 'config\device.json'
$mockOutput = Join-Path $testRoot 'mock-hub.out.log'
$mockError = Join-Path $testRoot 'mock-hub.err.log'
$mockProcess = $null
$testError = $null

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

try {
  New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
  Expand-Archive -LiteralPath $PackagePath -DestinationPath $releaseRoot
  foreach ($relativePath in @(
    'runtime\node.exe',
    'install.ps1',
    'app\client\dist\index.js',
    'app\node_modules\@remote-oc\protocol\package.json'
  )) {
    Assert (Test-Path -LiteralPath (Join-Path $releaseRoot $relativePath) -PathType Leaf) "Extracted release is missing $relativePath"
  }

  Push-Location (Join-Path $releaseRoot 'app')
  try {
    & (Join-Path $releaseRoot 'runtime\node.exe') --input-type=module --eval "import('@remote-oc/protocol')"
    Assert ($LASTEXITCODE -eq 0) 'Extracted release could not import @remote-oc/protocol'
  } finally { Pop-Location }

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $mockProcess = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @((Join-Path $PSScriptRoot 'release-mock-hub.mjs'), $port) -RedirectStandardOutput $mockOutput -RedirectStandardError $mockError -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ($mockProcess.HasExited) { throw "Mock hub exited: $(Get-Content $mockError -Raw -ErrorAction SilentlyContinue)" }
    if ((Test-Path $mockOutput) -and (Get-Content $mockOutput -Raw) -match 'ready') { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert ((Test-Path $mockOutput) -and (Get-Content $mockOutput -Raw) -match 'ready') 'Mock hub did not start'

  $installerOutput = & (Join-Path $releaseRoot 'install.ps1') -HubUrl "http://127.0.0.1:$port" -PairingCode 'RELEASE-TEST-CODE' -DeviceName 'Release Test PC' -InstallDir $installDir -ConfigPath $configPath -NoAutostart -Json
  Assert ($LASTEXITCODE -eq 0) "Extracted installer failed: $installerOutput"
  $result = $installerOutput | Select-Object -Last 1 | ConvertFrom-Json
  Assert ($result.ok -and $result.autostart -eq 'none') 'Extracted installer returned an unexpected result'
  Assert ((Test-Path $configPath) -and (Test-Path (Join-Path $installDir 'app\node_modules\@remote-oc\protocol\package.json'))) 'Installed payload or identity is incomplete'

  $uninstallOutput = & (Join-Path $releaseRoot 'uninstall.ps1') -InstallDir $installDir -ConfigPath $configPath
  Assert ($LASTEXITCODE -eq 0) "Uninstaller failed: $uninstallOutput"
  Assert (-not (Test-Path $installDir) -and -not (Test-Path $configPath)) 'Uninstaller left installed files or identity behind'

  Write-Output (@{ ok = $true; tests = 9; package = $PackagePath; temporaryRoot = $testRoot } | ConvertTo-Json -Compress)
} catch {
  $testError = $_
} finally {
  if ($mockProcess -and -not $mockProcess.HasExited) { Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue }
  if (-not $KeepTemporaryFiles) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($testError) {
  Write-Error $testError
  exit 1
}
