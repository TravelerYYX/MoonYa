param(
    [Parameter(Mandatory=$true)][string]$PublishPath,
    [Parameter(Mandatory=$true)][string]$CompilerPath,
    [Parameter(Mandatory=$true)][string]$InstallerSigningThumbprint,
    [string]$AppVersion = '1.0.0',
    [string]$OutputPath = (Join-Path $PSScriptRoot 'out'),
    [string]$SignToolPath,
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
if ($AppVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid application version.' }
if ($InstallerSigningThumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'A code-signing certificate thumbprint is required.' }
& (Join-Path $PSScriptRoot 'Test-ReleasePackage.ps1') -PublishPath $PublishPath
if (!$SignToolPath) {
    $SignToolPath = Get-ChildItem 'C:/Program Files (x86)/Windows Kits/10/bin/*/x64/signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$publish = (Resolve-Path -LiteralPath $PublishPath).Path
$compiler = (Resolve-Path -LiteralPath $CompilerPath).Path
$output = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path $output -Force | Out-Null
& $compiler "/DPublishPath=$publish" "/DOutputPath=$output" "/DAppVersion=$AppVersion" (Join-Path $PSScriptRoot 'MoonYa.iss')
if ($LASTEXITCODE) { throw 'MoonYa installer compilation failed.' }
$installer = Join-Path $output "MoonYa-Setup-x64-$AppVersion.exe"
& $SignToolPath sign /sha1 $InstallerSigningThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $installer
if ($LASTEXITCODE) { throw 'Installer signing failed. Output is not publishable.' }
& $SignToolPath verify /pa $installer
if ($LASTEXITCODE) { throw 'Installer verification failed. Output is not publishable.' }
Write-Output "Signed MoonYa installer: $installer"
