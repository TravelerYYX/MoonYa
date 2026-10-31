param([string]$InstallerProject = 'D:\Project\Project\安装程序\MoonYa\FarSide-安装程序\FarSide-安装程序\FarSide-安装程序.csproj')
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$smokeProject = Join-Path $repositoryRoot 'MoonYa-Win\MoonYa-Solution\MoonYa.UpdateInstallerSmoke\MoonYa.UpdateInstallerSmoke.csproj'
& dotnet build $smokeProject -v:quiet
if ($LASTEXITCODE -ne 0) { throw 'Installer smoke build failed.' }
$smokeRoot = Join-Path $repositoryRoot 'MoonYa-Win\MoonYa-Solution\MoonYa.UpdateInstallerSmoke\bin\Debug\net48'
$testRoot = Join-Path $repositoryRoot ('artifacts\update-installer-e2e\' + [Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $testRoot 'payload'
$targetRoot = Join-Path $testRoot '原安装目录 with spaces'
$stateRoot = Join-Path $testRoot 'state'
$setupRoot = Join-Path $testRoot 'setup'
foreach ($directory in @($payloadRoot, $targetRoot, $stateRoot, $setupRoot)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
foreach ($directory in @($payloadRoot,$targetRoot)) {
    Copy-Item -LiteralPath (Join-Path $smokeRoot 'MoonYa.UpdateInstallerSmoke.exe') -Destination (Join-Path $directory 'FarSide.exe')
    Copy-Item -LiteralPath (Join-Path $smokeRoot 'MoonYa.UpdateInstallerSmoke.exe') -Destination (Join-Path $directory 'FarSide.dll')
    Copy-Item -LiteralPath (Join-Path $smokeRoot 'MoonYa.UpdateInstallerSmoke.exe.config') -Destination (Join-Path $directory 'FarSide.exe.config')
}
Set-Content -LiteralPath (Join-Path $payloadRoot 'program-file.txt') -Value 'new program' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $targetRoot 'program-file.txt') -Value 'old program' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $targetRoot 'personal.txt') -Value 'preserve user data' -Encoding UTF8
$payload = Join-Path $testRoot 'FarSide.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot,$payload)
& dotnet publish $InstallerProject -c Release '-p:Version=1.0.0' "-p:PayloadPath=$payload" "-p:PublishDir=$setupRoot/" -v:quiet
if ($LASTEXITCODE -ne 0) { throw 'Actual WPF update installer build failed.' }
$setup = Join-Path $setupRoot 'FarSideSetup.exe'
$launchMarker = Join-Path $stateRoot 'restarted.txt'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = Join-Path $targetRoot 'FarSide.exe'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = $targetRoot
$start.Arguments = '--e2e-parent "' + $setup + '" "' + $stateRoot + '"'
$start.EnvironmentVariables['MOONYA_UPDATE_E2E_RESTART'] = $launchMarker
$parent = [Diagnostics.Process]::Start($start)
try {
    if (!$parent.WaitForExit(120000) -or $parent.ExitCode -ne 0) { throw 'Original client handshake/exit failed.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (!(Test-Path -LiteralPath $launchMarker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (!(Test-Path -LiteralPath $launchMarker)) { throw 'Updated client did not relaunch.' }
    $result = Get-Content -LiteralPath (Join-Path $stateRoot 'install-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$result.Success) { throw ('Installer reported failure: ' + $result.Message) }
    if ((Get-Content -LiteralPath (Join-Path $targetRoot 'program-file.txt') -Raw -Encoding UTF8).Trim() -ne 'new program') { throw 'Program payload was not installed.' }
    if ((Get-Content -LiteralPath (Join-Path $targetRoot 'personal.txt') -Raw -Encoding UTF8).Trim() -ne 'preserve user data') { throw 'User data changed.' }
    if ((Get-Content -LiteralPath $launchMarker -Raw -Encoding UTF8).Trim() -ne (Join-Path $targetRoot 'FarSide.exe')) { throw 'Client restarted from the wrong installation directory.' }
    Write-Output "Actual WPF installer handshake, old-process exit, original-directory update and relaunch passed. Evidence: $testRoot"
} finally { $parent.Dispose() }
