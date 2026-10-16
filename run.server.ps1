$ErrorActionPreference = 'Stop'

$projectPath = $PSScriptRoot
$logDirectory = Join-Path $env:LOCALAPPDATA 'CRUDUDAI\logs'
$stdoutPath = Join-Path $logDirectory 'server.stdout.log'
$stderrPath = Join-Path $logDirectory 'server.stderr.log'

try {
  if (-not (Test-Path (Join-Path $projectPath 'package.json'))) {
    throw "No se encontró package.json en $projectPath"
  }

  $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

  $command = '""{0}" run dev"' -f $npmCommand
  Start-Process `
    -FilePath $env:ComSpec `
    -ArgumentList @('/d', '/c', $command) `
    -WorkingDirectory $projectPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath
} catch {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $stderrPath -Value "[$timestamp] $($_.Exception.Message)"
  throw
}
