$ErrorActionPreference = 'Stop'
if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { throw 'Close Photoshop before uninstalling.' }
$taskDest = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.shu.groupexport'
if (Test-Path -LiteralPath $taskDest) { Remove-Item -LiteralPath $taskDest -Recurse -Force }
Write-Host 'Group Export removed. Exported PNGs and other plugins were kept.'
