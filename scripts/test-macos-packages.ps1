[CmdletBinding()]
param([switch]$KeepTemporaryFiles)
$ErrorActionPreference='Stop'; $repo=Split-Path -Parent $PSScriptRoot; $version=[string](Get-Content (Join-Path $repo 'package.json') -Raw|ConvertFrom-Json).version
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-mac-package-test-'+[guid]::NewGuid().ToString('N')); $testError=$null
function Assert([bool]$c,[string]$m){if(-not$c){throw$m}}
function Hash([string]$p){$s=[IO.File]::OpenRead($p);try{$h=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}finally{$s.Dispose()}}
try {
  New-Item -ItemType Directory -Force -Path $testRoot|Out-Null
  foreach($arch in @('x64','arm64')){
    $archive=Join-Path $repo "artifacts\RemoteOpenClaw-$version-mac-$arch.tar.gz"; Assert (Test-Path $archive) "Missing macOS $arch package"
    $dest=Join-Path $testRoot $arch; New-Item -ItemType Directory -Force -Path $dest|Out-Null; & tar -xzf $archive -C $dest; Assert ($LASTEXITCODE-eq 0) "Could not extract macOS $arch package"
    foreach($required in @('runtime\node','install-macos.sh','uninstall-macos.sh','app\client\dist\index.js','app\node_modules\@remote-oc\protocol\package.json','manifest.json')){Assert(Test-Path(Join-Path $dest $required)) "macOS $arch package is missing $required"}
    $manifest=Get-Content (Join-Path $dest 'manifest.json') -Raw|ConvertFrom-Json; Assert($manifest.architecture-eq$arch) "macOS package architecture mismatch"
    foreach($file in @($manifest.files)){Assert((Hash(Join-Path $dest ($file.path-replace'/','\')))-eq$file.sha256) "macOS $arch checksum mismatch: $($file.path)"}
    $bytes=[IO.File]::ReadAllBytes((Join-Path $dest 'runtime\node')); Assert($bytes.Length-gt 8-and$bytes[0]-eq0xcf-and$bytes[1]-eq0xfa-and$bytes[2]-eq0xed-and$bytes[3]-eq0xfe) "macOS $arch runtime is not a 64-bit Mach-O"
    $cpu=$bytes[4]; Assert(($arch-eq'x64'-and$cpu-eq7)-or($arch-eq'arm64'-and$cpu-eq12)) "macOS $arch runtime CPU type mismatch"
    Push-Location (Join-Path $dest 'app'); try { & node.exe --input-type=module --eval "import('@remote-oc/protocol')"; Assert($LASTEXITCODE-eq0) "macOS $arch protocol import failed" } finally { Pop-Location }
  }
  Write-Output (@{ok=$true;tests=14;platforms=@('macos-x64','macos-arm64')}|ConvertTo-Json -Compress)
} catch {$testError=$_} finally {if(-not$KeepTemporaryFiles){Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue}}
if($testError){Write-Error $testError;exit 1}
