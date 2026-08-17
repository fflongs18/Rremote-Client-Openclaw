param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Uninstall) { Get-ScheduledTask -TaskName 'Remote-OC-Client' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false; Write-Host 'Remote Client startup removed'; exit 0 }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22+ is required' }
$major = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($major -lt 22) { throw 'Node.js 22+ is required' }
Push-Location $root
try { npm install; npm run build; Write-Host 'Dependencies installed and client built' } finally { Pop-Location }
Write-Host 'Run: npm run pair -- --code ABC123 --name "Your device"'
