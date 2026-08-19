[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [string]$SigningCertificate = '',
  [string]$CertificateThumbprint = '',
  [string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts' }
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-package-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageRoot ("RemoteOpenClaw-$version-win-x64")
$app = Join-Path $stage 'app'
$signingCertificateObject = $null

if ($SigningCertificate -and $CertificateThumbprint) {
  throw 'Use either SigningCertificate or CertificateThumbprint, not both'
}
if ($SigningCertificate) {
  $signingCertificateObject = Get-PfxCertificate -FilePath $SigningCertificate
} elseif ($CertificateThumbprint) {
  $normalizedThumbprint = $CertificateThumbprint.Replace(' ', '').ToUpperInvariant()
  $certificatePath = "Cert:\CurrentUser\My\$normalizedThumbprint"
  if (-not (Test-Path $certificatePath)) { throw "Signing certificate was not found: $normalizedThumbprint" }
  $signingCertificateObject = Get-Item $certificatePath
}
if ($signingCertificateObject) {
  if (-not $signingCertificateObject.HasPrivateKey) { throw 'Signing certificate does not have an accessible private key' }
  $enhancedKeyUsageOids = @($signingCertificateObject.EnhancedKeyUsageList | ForEach-Object {
    if ($_.ObjectId -is [string]) { $_.ObjectId }
    elseif ($_.ObjectId -and $_.ObjectId.Value) { $_.ObjectId.Value }
  })
  if ($enhancedKeyUsageOids -notcontains '1.3.6.1.5.5.7.3.3') {
    throw "Signing certificate is not valid for code signing (EKUs: $($enhancedKeyUsageOids -join ', '))"
  }
}

function Sign-PowerShellFile([string]$Path) {
  if (-not $signingCertificateObject) { return }
  $params = @{ FilePath = $Path; Certificate = $signingCertificateObject; HashAlgorithm = 'SHA256' }
  if ($TimestampServer) { $params.TimestampServer = $TimestampServer }
  $signature = Set-AuthenticodeSignature @params
  if ($signature.Status -ne 'Valid') { throw "Signing failed: $Path ($($signature.Status))" }
}

try {
  & npm.cmd run build -w @remote-oc/protocol
  if ($LASTEXITCODE) { throw 'Protocol build failed' }
  & npm.cmd run build -w @remote-oc/client
  if ($LASTEXITCODE) { throw 'Client build failed' }

  New-Item -ItemType Directory -Force -Path (Join-Path $app 'client'), (Join-Path $app 'protocol'), (Join-Path $stage 'runtime') | Out-Null
  Copy-Item (Join-Path $repo 'packages\apps\client\dist') (Join-Path $app 'client\dist') -Recurse
  Copy-Item (Join-Path $repo 'packages\protocol\dist') (Join-Path $app 'protocol\dist') -Recurse
  $protocolPackage = @{ name = '@remote-oc/protocol'; version = $version; type = 'module'; main = 'dist/index.js'; exports = @{ '.' = './dist/index.js' } }
  $protocolPackage | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $app 'protocol\package.json') -Encoding UTF8
  $appPackage = @{ private = $true; type = 'module'; dependencies = @{ '@remote-oc/protocol' = 'file:./protocol'; dotenv = '^17.2.0'; 'openclaw-node' = '0.14.0'; ws = '^8.18.0' } }
  $appPackage | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $app 'package.json') -Encoding UTF8
  Push-Location $app
  try {
    & npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'Production dependency install failed' }
  } finally { Pop-Location }

  $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $nodeRelease = $releases | Where-Object { $_.version -match '^v22\.' -and $_.lts } | Select-Object -First 1
  if (-not $nodeRelease) { throw 'No Node.js 22 LTS release found' }
  $nodeArchiveName = "node-$($nodeRelease.version)-win-x64.zip"
  $nodeBaseUrl = "https://nodejs.org/dist/$($nodeRelease.version)"
  $checksumsPath = Join-Path $stageRoot 'SHASUMS256.txt'
  $nodeArchive = Join-Path $stageRoot $nodeArchiveName
  Invoke-WebRequest "$nodeBaseUrl/SHASUMS256.txt" -OutFile $checksumsPath
  Invoke-WebRequest "$nodeBaseUrl/$nodeArchiveName" -OutFile $nodeArchive
  $expectedNodeHash = ((Get-Content $checksumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))$" }) -split '\s+')[0].ToLowerInvariant()
  $actualNodeHash = (Get-FileHash $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $expectedNodeHash -or $expectedNodeHash -ne $actualNodeHash) { throw 'Portable Node.js checksum mismatch' }
  Expand-Archive $nodeArchive (Join-Path $stageRoot 'node')
  Copy-Item (Join-Path $stageRoot "node\node-$($nodeRelease.version)-win-x64\node.exe") (Join-Path $stage 'runtime\node.exe')

  Copy-Item (Join-Path $repo 'installer\install.ps1') (Join-Path $stage 'install.ps1')
  Copy-Item (Join-Path $repo 'installer\uninstall.ps1') (Join-Path $stage 'uninstall.ps1')
  Copy-Item (Join-Path $repo 'installer\bootstrap.ps1') (Join-Path $stage 'bootstrap.ps1')
  Copy-Item (Join-Path $repo 'installer\run-client.cmd') (Join-Path $stage 'run-client.cmd')
  Sign-PowerShellFile (Join-Path $stage 'install.ps1')
  Sign-PowerShellFile (Join-Path $stage 'uninstall.ps1')
  Sign-PowerShellFile (Join-Path $stage 'bootstrap.ps1')

  $files = Get-ChildItem $stage -File -Recurse | ForEach-Object {
    @{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); size = $_.Length }
  }
  $manifest = @{ packageVersion = $version; architecture = 'win-x64'; nodeVersion = $nodeRelease.version; nodeArchiveSha256 = $expectedNodeHash; signed = [bool]$signingCertificateObject; signerThumbprint = if ($signingCertificateObject) { $signingCertificateObject.Thumbprint } else { $null }; createdAt = [DateTime]::UtcNow.ToString('o'); files = $files }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $zip = Join-Path $OutputDirectory ("RemoteOpenClaw-$version-win-x64.zip")
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  $zipHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content "$zip.sha256" "$zipHash  $([IO.Path]::GetFileName($zip))" -Encoding ASCII
  Write-Output (@{ ok = $true; package = $zip; sha256 = $zipHash; signed = [bool]$signingCertificateObject; signerThumbprint = if ($signingCertificateObject) { $signingCertificateObject.Thumbprint } else { $null } } | ConvertTo-Json -Compress)
} finally {
  Remove-Item $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
