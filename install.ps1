$ErrorActionPreference = 'Stop'
$taskSource = Join-Path $PSScriptRoot 'com.shu.groupexport'
$taskRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$taskDest = Join-Path $taskRoot 'com.shu.groupexport'
if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'CSXS\manifest.xml'))) {
    throw 'Extract the entire ZIP first, then run install.bat.'
}
if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { throw 'Close Photoshop before installing.' }
if ($taskDest.Contains('#')) { throw 'CEP cannot load from a path containing #.' }
# Remove the previous version first so files deleted in this release do not linger.
if (Test-Path -LiteralPath $taskDest) { Remove-Item -LiteralPath $taskDest -Recurse -Force }
New-Item -ItemType Directory -Path $taskDest -Force | Out-Null
Copy-Item -Path (Join-Path $taskSource '*') -Destination $taskDest -Recurse -Force
foreach ($taskVersion in @(9,10,11,12)) {
    $taskKey = "HKCU:\Software\Adobe\CSXS.$taskVersion"
    New-Item -Path $taskKey -Force | Out-Null
    New-ItemProperty -Path $taskKey -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
}
Write-Host 'Group Export installed for the current Windows user.'
Write-Host 'Unsigned CEP extension loading is enabled for CSXS 9-12.'
Write-Host 'Restart Photoshop and open Window > Extensions (Legacy) > Group Export (Chinese name).'
Write-Host "Location: $taskDest"
