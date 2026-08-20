[CmdletBinding()]
param(
  [ValidateSet('x64', 'arm64')][string]$Architecture = 'arm64',
  [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = [string](Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts' }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-macos-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $tempRoot ("RemoteOpenClaw-$version-mac-$Architecture"); $app = Join-Path $stage 'app'
function Get-Sha256Hex([string]$Path) { $s=[IO.File]::OpenRead($Path); try { $h=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() } } finally { $s.Dispose() } }
try {
  & npm.cmd run build -w '@remote-oc/protocol'; if ($LASTEXITCODE) { throw 'Protocol build failed' }
  & npm.cmd run build -w '@remote-oc/client'; if ($LASTEXITCODE) { throw 'Client build failed' }
  New-Item -ItemType Directory -Force -Path (Join-Path $app 'client'),(Join-Path $app 'protocol'),(Join-Path $stage 'runtime') | Out-Null
  Copy-Item (Join-Path $repo 'packages\apps\client\dist') (Join-Path $app 'client\dist') -Recurse
  Copy-Item (Join-Path $repo 'packages\protocol\dist') (Join-Path $app 'protocol\dist') -Recurse
  @{name='@remote-oc/protocol';version=$version;type='module';main='dist/index.js';exports=@{'.'='./dist/index.js'}} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $app 'protocol\package.json') -Encoding UTF8
  @{private=$true;type='module';dependencies=@{'@remote-oc/protocol'='file:./protocol';dotenv='^17.2.0';'openclaw-node'='0.14.0';ws='^8.18.0'}} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $app 'package.json') -Encoding UTF8
  Push-Location $app; try { & npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE){throw 'Production dependency install failed'} } finally { Pop-Location }
  $protocol=Join-Path $app 'node_modules\@remote-oc\protocol'; Remove-Item $protocol -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path (Split-Path $protocol -Parent)|Out-Null; Copy-Item (Join-Path $app 'protocol') $protocol -Recurse
  $releases=Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $nodeRelease=$releases|Where-Object{$_.version-match'^v22\.'-and$_.lts}|Select-Object -First 1
  $archiveName="node-$($nodeRelease.version)-darwin-$Architecture.tar.gz"; $base="https://nodejs.org/dist/$($nodeRelease.version)"; $checksums=Join-Path $tempRoot 'SHASUMS256.txt'; $archive=Join-Path $tempRoot $archiveName
  Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $checksums; Invoke-WebRequest "$base/$archiveName" -OutFile $archive
  $expected=((Get-Content $checksums|Where-Object{$_-match"\s+$([regex]::Escape($archiveName))$"})-split'\s+')[0].ToLowerInvariant(); if($expected-ne(Get-Sha256Hex $archive)){throw 'Portable Node.js checksum mismatch'}
  & tar -xzf $archive -C $tempRoot; if($LASTEXITCODE){throw 'Node.js archive extraction failed'}
  Copy-Item (Join-Path $tempRoot "node-$($nodeRelease.version)-darwin-$Architecture\bin\node") (Join-Path $stage 'runtime\node')
  Copy-Item (Join-Path $repo 'installer\install-macos.sh') (Join-Path $stage 'install-macos.sh'); Copy-Item (Join-Path $repo 'installer\uninstall-macos.sh') (Join-Path $stage 'uninstall-macos.sh')
  $files=Get-ChildItem $stage -File -Recurse|ForEach-Object{@{path=$_.FullName.Substring($stage.Length+1).Replace('\','/');sha256=Get-Sha256Hex $_.FullName;size=$_.Length}}
  $manifestJson = @{packageVersion=$version;platform='macos';architecture=$Architecture;nodeVersion=$nodeRelease.version;nodeArchiveSha256=$expected;createdAt=[DateTime]::UtcNow.ToString('o');files=$files}|ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), $manifestJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  foreach($required in @('runtime\node','install-macos.sh','uninstall-macos.sh','app\client\dist\index.js','app\node_modules\@remote-oc\protocol\package.json')){if(-not(Test-Path (Join-Path $stage $required))){throw "Release payload is missing $required"}}
  Push-Location (Join-Path $stage 'app'); try { & node.exe --input-type=module --eval "import('@remote-oc/protocol')"; if($LASTEXITCODE){throw 'Protocol import failed'} } finally { Pop-Location }
  New-Item -ItemType Directory -Force -Path $OutputDirectory|Out-Null; $package=Join-Path $OutputDirectory ("RemoteOpenClaw-$version-mac-$Architecture.tar.gz"); Remove-Item $package -Force -ErrorAction SilentlyContinue
  & tar -czf $package -C $stage .; if($LASTEXITCODE){throw 'Release compression failed'}
  $sha=Get-Sha256Hex $package; Set-Content "$package.sha256" "$sha  $([IO.Path]::GetFileName($package))" -Encoding ASCII
  Write-Output (@{ok=$true;package=$package;sha256=$sha;platform="macos-$Architecture"}|ConvertTo-Json -Compress)
} finally { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
