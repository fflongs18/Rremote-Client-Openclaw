[CmdletBinding()]
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RemoteOpenClaw'), [string]$ConfigPath = (Join-Path $env:USERPROFILE '.remote-oc\device.json'), [switch]$KeepIdentity)
$ErrorActionPreference = 'Stop'
$startupDirectory = [Environment]::GetFolderPath('Startup')
if ([string]::IsNullOrWhiteSpace($startupDirectory)) {
  $startupDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
}
try {
  Stop-ScheduledTask -TaskName 'Remote-OC-Client' -ErrorAction SilentlyContinue
  Get-ScheduledTask -TaskName 'Remote-OC-Client' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
} catch {}
try {
  Stop-ScheduledTask -TaskName 'Remote-OC-Hermes-Gateway' -ErrorAction SilentlyContinue
  Get-ScheduledTask -TaskName 'Remote-OC-Hermes-Gateway' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
} catch {}
Remove-Item -LiteralPath (Join-Path $startupDirectory 'Remote-OC-Client.cmd') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $startupDirectory 'Remote-OC-Hermes-Gateway.cmd') -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $InstallDir) {
  $resolvedInstallDir = [IO.Path]::GetFullPath($InstallDir)
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolvedInstallDir, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}
if (-not $KeepIdentity) { Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Output (@{ ok = $true; removed = $InstallDir; identityKept = [bool]$KeepIdentity } | ConvertTo-Json -Compress)
