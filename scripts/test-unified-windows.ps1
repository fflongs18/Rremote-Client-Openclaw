[CmdletBinding()]
param([switch]$KeepTemporaryFiles)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-unified-test-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'installed'; $configPath = Join-Path $testRoot 'config\device.json'
$packagePath = Join-Path $repo 'artifacts\RemoteOpenClaw-0.1.0-win-x64.zip'; $mockProcess = $null; $testError = $null
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-Sha256Hex([string]$Path) { $s=[IO.File]::OpenRead($Path); try { $h=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() } } finally { $s.Dispose() } }
try {
  Assert (Test-Path $packagePath) 'Windows release package is missing'
  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  $manifestPath = Join-Path $testRoot 'release.json'
  @{ version='0.1.0'; platforms=@{ 'windows-x64'=@{ url=$packagePath; sha256=(Get-Sha256Hex $packagePath) } } } | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding UTF8
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start(); $port=([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
  $out=Join-Path $testRoot 'hub.out'; $err=Join-Path $testRoot 'hub.err'
  $mockProcess=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @((Join-Path $PSScriptRoot 'release-mock-hub.mjs'),$port) -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(10); do { if ((Test-Path $out) -and (Get-Content $out -Raw) -match 'ready') { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)
  $output=& (Join-Path $repo 'install.ps1') -ManifestPath $manifestPath -HubUrl "http://127.0.0.1:$port" -PairingCode RELEASE-TEST-CODE -DeviceName 'Unified Test' -InstallDir $installDir -ConfigPath $configPath -NoAutostart -Json
  Assert ($LASTEXITCODE -eq 0) "Unified installer failed: $output"
  $result=$output|Select-Object -Last 1|ConvertFrom-Json
  Assert ($result.ok -and $result.autostart -eq 'none') 'Unified installer returned an unexpected result'
  Assert (Test-Path (Join-Path $installDir 'uninstall.ps1')) 'Installed uninstaller is missing'
  & (Join-Path $installDir 'uninstall.ps1') -InstallDir $installDir -ConfigPath $configPath | Out-Null
  Assert (-not (Test-Path $installDir) -and -not (Test-Path $configPath)) 'Unified uninstall left files behind'
  Write-Output (@{ok=$true;tests=5;platform='windows-x64'}|ConvertTo-Json -Compress)
} catch { $testError=$_ } finally { if ($mockProcess -and -not $mockProcess.HasExited) { Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue }; if (-not $KeepTemporaryFiles) { Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue } }
if ($testError) { Write-Error $testError; exit 1 }
