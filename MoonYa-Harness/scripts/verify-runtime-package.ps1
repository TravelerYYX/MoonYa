param([Parameter(Mandatory = $true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$runtimeSource = Split-Path -Parent $PSScriptRoot
$projectSource = Split-Path -Parent $runtimeSource
$destination = [IO.Path]::GetFullPath($OutputRoot)
$sourceRoot = Join-Path $runtimeSource 'src'
function Get-ContentHash([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)) }
    finally { $hash.Dispose(); $stream.Dispose() }
}
foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object { $_.Extension -in '.mjs', '.py', '.cjs', '.json', '.txt' }) {
    $relative = $file.FullName.Substring($sourceRoot.TrimEnd('\').Length + 1)
    $target = Join-Path $destination (Join-Path 'agent_runtime\src' $relative)
    if (!(Test-Path -LiteralPath $target) -or
        (Get-ContentHash $file.FullName) -ne (Get-ContentHash $target)) {
        throw "Agent Runtime output is missing or stale: $target"
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $runtimeSource 'node_modules') -Recurse -File | Where-Object { $_.FullName -match '[\\/](koffi|@koromix|smol-toml|diff|ignore)[\\/]' }) {
    $relative = $file.FullName.Substring($runtimeSource.TrimEnd('\').Length + 1)
    $target = Join-Path $destination (Join-Path 'agent_runtime' $relative)
    if (!(Test-Path -LiteralPath $target) -or (Get-ContentHash $file.FullName) -ne (Get-ContentHash $target)) { throw "Subagent native dependency is missing or stale: $target" }
}
# Match the desktop build/publish skill payload; catalog locks stay on the server.
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectSource 'MoonYa-Backend\skills') -Recurse -File | Where-Object { $_.Extension -in '.md', '.sha256' }) {
    $relative = $file.FullName.Substring((Join-Path $projectSource 'MoonYa-Backend\skills').TrimEnd('\').Length + 1)
    $source = $file.FullName
    $target = Join-Path $destination (Join-Path 'agent_runtime\skills' $relative)
    if (!(Test-Path -LiteralPath $target) -or
        (Get-ContentHash $source) -ne (Get-ContentHash $target)) {
        throw "Desktop skill output is missing or stale: $target"
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectSource 'MoonYa-Frontend\dist') -Recurse -File) {
    $relative = $file.FullName.Substring((Join-Path $projectSource 'MoonYa-Frontend\dist').TrimEnd('\').Length + 1)
    $source = $file.FullName
    $target = Join-Path $destination (Join-Path 'frontend' $relative)
    if (!(Test-Path -LiteralPath $target) -or (Get-ContentHash $source) -ne (Get-ContentHash $target)) {
        throw "Static frontend output is missing or stale: $target"
    }
}
foreach ($file in Get-ChildItem -LiteralPath $destination -Recurse -File) {
    if ($file.Extension -eq '.php' -or $file.Name -like '.env*' -or $file.FullName -match '[\\/]wwwroot[\\/]') {
        throw "Server-only file in desktop package: $($file.FullName). Use a clean output directory."
    }
}
Write-Output "Verified static frontend, Agent Runtime, Python bridge and desktop skills: $destination"
