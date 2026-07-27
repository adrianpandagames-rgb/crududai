param()

# Require admin
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Error "This script must be run as Administrator. Right-click and 'Run with PowerShell (Admin)'."
  exit 1
}

$serviceName = 'correlatador'

Write-Host "Stopping and removing service '$serviceName' if exists..."
try {
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
} catch {}

sc.exe delete $serviceName | Out-Null
Write-Host "Service '$serviceName' removed (if it existed)."
