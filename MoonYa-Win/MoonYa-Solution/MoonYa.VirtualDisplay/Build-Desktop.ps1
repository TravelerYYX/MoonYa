param([ValidateSet('Release','Debug')][string]$Configuration = 'Release', [switch]$SkipRestore)
$ErrorActionPreference = 'Stop'
$driverRoot = $PSScriptRoot
$solutionRoot = Split-Path $driverRoot -Parent
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio) { throw 'Visual Studio C++ build tools are required.' }
$msbuild = Join-Path $visualStudio 'MSBuild\Current\Bin\MSBuild.exe'
if (!$SkipRestore) {
    $cache = Join-Path $driverRoot '.cache\wdk'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $nuget = Join-Path $cache 'nuget.exe'
    if (!(Test-Path -LiteralPath $nuget)) { Invoke-WebRequest -Uri 'https://dist.nuget.org/win-x86-commandline/v6.14.0/nuget.exe' -OutFile $nuget }
    & $nuget restore (Join-Path $driverRoot 'packages.config') -PackagesDirectory (Join-Path $cache 'packages') -NonInteractive
    if ($LASTEXITCODE) { throw 'WDK package restore failed.' }
}
foreach ($project in @(
    (Join-Path $solutionRoot 'MoonYa.DesktopCapture\MoonYa.DesktopCapture.vcxproj'),
    (Join-Path $driverRoot 'MoonYa.DisplayHost.vcxproj'),
    (Join-Path $driverRoot 'MoonYa.VirtualDisplay.vcxproj')
)) {
    & $msbuild $project /p:Configuration=$Configuration /p:Platform=x64 /v:minimal /nologo
    if ($LASTEXITCODE) { throw "Build failed: $project" }
}
$wdk = Join-Path $driverRoot '.cache\wdk\packages\Microsoft.Windows.WDK.x64.10.0.26100.6584\c'
$package = Join-Path $driverRoot "bin\$Configuration"
& (Join-Path $wdk 'tools\10.0.26100.0\x64\infverif.exe') /u (Join-Path $package 'MoonYa.VirtualDisplay.inf')
if ($LASTEXITCODE) { throw 'Driver INF validation failed.' }
& (Join-Path $wdk 'bin\10.0.26100.0\x86\Inf2Cat.exe') "/driver:$package" /os:10_X64 /uselocaltime
if ($LASTEXITCODE) { throw 'Driver catalog generation failed.' }
Copy-Item -LiteralPath (Join-Path $driverRoot 'LICENSE.MS-PL') -Destination $package
Write-Output "Unsigned driver package: $package. No driver was installed or signed."
