[CmdletBinding()]
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RemoteOpenClaw'), [string]$ConfigPath = (Join-Path $env:USERPROFILE '.remote-oc\device.json'), [switch]$KeepIdentity)
$ErrorActionPreference = 'Stop'
Get-ScheduledTask -TaskName 'Remote-OC-Client' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
if (-not $KeepIdentity) { Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Output (@{ ok = $true; removed = $InstallDir; identityKept = [bool]$KeepIdentity } | ConvertTo-Json -Compress)
