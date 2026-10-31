param([Parameter(Mandatory = $true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
$separator = [IO.Path]::DirectorySeparatorChar
function IsWithin([string]$Path, [string]$Root) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Root + $separator, [StringComparison]::OrdinalIgnoreCase)
}
# Never move anything from a source tree, filesystem root or workspace root.
if ($destination -eq [IO.Path]::GetPathRoot($destination).TrimEnd('\', '/') -or
    (IsWithin $projectRoot $destination)) { throw "Unsafe build output root: $destination" }
if (IsWithin $destination $projectRoot) {
    # FolderProfile publishes to the workspace-level bin\win-64 directory.
    $allowed = @((Join-Path $projectRoot 'artifacts'), (Join-Path $projectRoot 'bin'), (Join-Path $projectRoot 'MoonYa-Win\MoonYa-Solution\MoonYa\bin'))
    if (!($allowed | Where-Object { IsWithin $destination $_ })) { throw "Build cleanup requires a generated output directory: $destination" }
}
$legacyPaths = @('wwwroot', 'win-x64\wwwroot', 'win-x86\wwwroot', 'win-arm64\wwwroot')
$backupBase = Join-Path $projectRoot 'artifacts\legacy-client-payload-backups'
if (IsWithin $backupBase $destination) { throw "Legacy backup must be outside the build output: $destination" }
$backup = $null
foreach ($relative in $legacyPaths) {
    $target = [IO.Path]::GetFullPath((Join-Path $destination $relative))
    if (!(IsWithin $target $destination) -or $target -eq $destination) { throw "Unsafe legacy payload path: $target" }
    if (!(Test-Path -LiteralPath $target)) { continue }
    # Refuse directory links anywhere along the source path before moving it.
    $current = $target
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked build path cannot be retired: $current" }
        $current = Split-Path -Parent $current
    }
    if (!$backup) {
        $backup = Join-Path $backupBase ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        @{ output_root = $destination; created_utc = [DateTime]::UtcNow.ToString('O') } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'backup-info.json') -Encoding UTF8
    }
    $backupTarget = Join-Path $backup $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $backupTarget) -Force | Out-Null
    Move-Item -LiteralPath $target -Destination $backupTarget
    Write-Output "Retired legacy server payload to backup: $backupTarget"
}
