param()
$ErrorActionPreference = 'Stop'
# Stop MoonYa screen sessions before removing its package. Do not touch other vendors' display drivers.
if (Get-Process -Name 'MoonYa.DisplayHost' -ErrorAction SilentlyContinue) { throw 'End all MoonYa virtual-screen sessions first.' }
$packages = Get-WindowsDriver -Online | Where-Object {
    $_.ProviderName -eq 'MoonYa' -and [IO.Path]::GetFileName($_.OriginalFileName) -eq 'MoonYa.VirtualDisplay.inf'
}
foreach ($package in $packages) {
    if ($package.Driver -notmatch '^oem\d+\.inf$') { throw 'Unexpected published driver name.' }
    & pnputil.exe /delete-driver $package.Driver /uninstall
    if ($LASTEXITCODE -eq 3010) { exit 3010 }
    if ($LASTEXITCODE) { throw "Driver removal failed: $($package.Driver)" }
}
