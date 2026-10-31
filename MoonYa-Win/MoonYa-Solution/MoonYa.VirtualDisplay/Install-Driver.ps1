# Run only on the intended target. This script never changes boot or signing policy.
param([Parameter(Mandatory=$true)][string]$PackagePath, [switch]$TestEnvironment)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$inf = Join-Path $package 'MoonYa.VirtualDisplay.inf'
$catalog = Join-Path $package 'MoonYaVirtualDisplay.cat'
if (!(Test-Path -LiteralPath $inf) -or !(Test-Path -LiteralPath $catalog) -or !(Test-Path -LiteralPath (Join-Path $package 'MoonYaVirtualDisplay.dll'))) { throw 'Incomplete MoonYa driver package.' }
if ((Get-Content -LiteralPath $inf -Raw) -notmatch 'DeviceName="MoonYa Virtual Display"') { throw 'Unexpected driver identity.' }
$signature = Get-AuthenticodeSignature -LiteralPath $catalog
if ($signature.Status -ne 'Valid') { throw 'The catalog must have a valid, trusted signature before installation.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer in an elevated PowerShell session.' }
Write-Output $(if ($TestEnvironment) { 'Installing into the explicitly designated test environment.' } else { 'Installing the signed MoonYa driver package. Windows will enforce driver signing policy.' })
& pnputil.exe /add-driver $inf /install
if ($LASTEXITCODE -eq 3010) { exit 3010 }
if ($LASTEXITCODE) { throw 'Windows refused driver installation; no signing-policy fallback was attempted.' }
