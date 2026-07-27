param(
  [string]$ExePath = "dist\\correlatador.exe"
)

# Require admin
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Error "This script must be run as Administrator. Right-click and 'Run with PowerShell (Admin)'."
  exit 1
}

if (-not (Test-Path $ExePath)) {
  Write-Error "Executable not found at $ExePath. Build it first with 'npm run package:win'."
  exit 1
}

$serviceName = 'correlatador'
$displayName = 'correlatador'

Write-Host "Installing Windows service '$serviceName' pointing to: $ExePath"

try {
  # Remove existing service if present
  $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Service already exists. Stopping and removing existing service..."
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 1
  }

  # Create new service
  sc.exe create $serviceName binPath= "`"$((Resolve-Path $ExePath).Path)`"" DisplayName= "$displayName" start= auto | Out-Null
  Write-Host "Service created. Starting service..."
  Start-Service -Name $serviceName
  Write-Host "Service '$serviceName' started. Use 'Get-Service -Name $serviceName' to check status."
} catch {
  Write-Error "Failed to install service: $_"
  exit 1
}
