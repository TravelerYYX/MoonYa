param(
    [Parameter(Mandatory=$true)][string]$PublishPath,
    [string]$AppVersion,
    [string]$InstallerProject = 'D:\Project\Project\安装程序\MoonYa\FarSide-安装程序\FarSide-安装程序\FarSide-安装程序.csproj',
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$publishedRoot = (Resolve-Path -LiteralPath $PublishPath).Path
$projectFile = (Resolve-Path -LiteralPath $InstallerProject).Path
& (Join-Path $PSScriptRoot 'Test-ReleasePackage.ps1') -PublishPath $publishedRoot
$versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $publishedRoot 'FarSide.dll'))
$payloadVersion = '{0}.{1}.{2}' -f $versionInfo.FileMajorPart,$versionInfo.FileMinorPart,$versionInfo.FileBuildPart
if (!$AppVersion) { $AppVersion = $payloadVersion }
if ($AppVersion -notmatch '^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$' -or $AppVersion -ne $payloadVersion) { throw 'AppVersion must match the three-part version in the published FarSide.dll.' }
if (($AppVersion.Split('.') | ForEach-Object { [int]$_ } | Measure-Object -Maximum).Maximum -gt 65534) { throw 'Version components must not exceed 65534.' }
if (!$OutputPath) { $OutputPath = Join-Path $PSScriptRoot "..\..\artifacts\program-updates\$AppVersion" }
$outputRoot = [IO.Path]::GetFullPath($OutputPath)
if ($outputRoot -eq $publishedRoot -or $outputRoot.StartsWith($publishedRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputPath must be outside the client payload.' }
if ((Test-Path -LiteralPath $outputRoot) -and (Get-ChildItem -LiteralPath $outputRoot -Force | Select-Object -First 1)) { throw 'Choose an empty output directory; existing release files will not be overwritten.' }
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\..\artifacts\update-build\' + [Guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$payloadZip = Join-Path $buildRoot 'FarSide.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($publishedRoot, $payloadZip, [IO.Compression.CompressionLevel]::Optimal, $false)
& dotnet publish $projectFile -c Release "-p:Version=$AppVersion" "-p:PayloadPath=$payloadZip" "-p:PublishDir=$outputRoot/" -v:quiet
if ($LASTEXITCODE -ne 0) { throw 'Update installer build failed.' }
$setup = Join-Path $outputRoot 'FarSideSetup.exe'
$setupInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($setup)
if ($setupInfo.ProductName -ne 'FarSideSetup.UpdateProtocol/1' -or ('{0}.{1}.{2}' -f $setupInfo.FileMajorPart,$setupInfo.FileMinorPart,$setupInfo.FileBuildPart) -ne $AppVersion) { throw 'Installer update protocol/version check failed.' }
Remove-Item -LiteralPath $payloadZip -Force
$hash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Update installer: $setup"
Write-Output "Version: $AppVersion"
Write-Output "SHA256: $hash"
