[CmdletBinding()]
param([switch]$KeepTemporaryFiles)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo 'installer\install.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-oc-installer-test-' + [guid]::NewGuid().ToString('N'))
$testError = $null

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

try {
  $command = "& '$($installer.Replace("'", "''"))' -HubUrl 'https://hub.test.example' -PairingCode 'TEST-CODE' -PackageRoot '' -Json"
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $command
  Assert ($LASTEXITCODE -ne 0) 'Installer with an empty PackageRoot unexpectedly succeeded'
  $result = $output | Select-Object -Last 1 | ConvertFrom-Json
  Assert ($result.error -eq 'Release manifest.json is missing') "Empty PackageRoot did not fall back to PSScriptRoot: $($result.error)"

  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
  Assert ($parseErrors.Count -eq 0) 'Installer contains PowerShell parse errors'
  $launcherFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-Launcher'
  }, $true)
  Assert ($null -ne $launcherFunction) 'Install-Launcher function was not found'
  Invoke-Expression $launcherFunction.Extent.Text

  $InstallDir = Join-Path $testRoot 'installed'
  $StartupDirectory = Join-Path $testRoot 'Startup'
  $ConfigPath = Join-Path $testRoot 'config\device.json'
  $DefaultRuntime = 'openclaw'
  $NoAutostart = $false
  $startupFileName = 'Remote-OC-Client.cmd'
  $taskName = 'Remote-OC-Client'
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

  function New-ScheduledTaskAction { throw [UnauthorizedAccessException]::new('Access is denied') }
  function Get-ScheduledTask { return $null }
  function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
    return $null
  }

  $status = Install-Launcher (Join-Path $InstallDir 'runtime\node.exe') (Join-Path $InstallDir 'app\client\dist\index.js')
  $startupLauncher = Join-Path $StartupDirectory $startupFileName
  Assert ($status.autostart -eq 'startup-folder') 'Access-denied fallback did not select the Startup folder'
  Assert (Test-Path -LiteralPath $startupLauncher -PathType Leaf) 'Startup fallback launcher was not created'
  Assert ($status.scheduledTaskError -match 'Access is denied') 'Scheduled task failure was not preserved in the result'

  $NoAutostart = $true
  $disabled = Install-Launcher (Join-Path $InstallDir 'runtime\node.exe') (Join-Path $InstallDir 'app\client\dist\index.js')
  Assert ($disabled.autostart -eq 'none') 'NoAutostart did not disable startup registration'

  Write-Output (@{ ok = $true; tests = 6; platform = 'windows'; temporaryRoot = $testRoot } | ConvertTo-Json -Compress)
} catch {
  $testError = $_
} finally {
  if (-not $KeepTemporaryFiles) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($testError) {
  Write-Error $testError
  exit 1
}
