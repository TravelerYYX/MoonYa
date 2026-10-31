param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path -Parent $PSScriptRoot
$foundationRoot = Join-Path $runtimeRoot 'foundation'
$entry = Join-Path $runtimeRoot 'src\server.mjs'
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput

if (!(Test-Path -LiteralPath $entry)) { throw "Missing runtime entry: $entry" }
if (!(Test-Path -LiteralPath (Join-Path $foundationRoot 'node_modules\.bin\pkg.cmd'))) {
    & pnpm --dir $foundationRoot install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
}

& npm --prefix $runtimeRoot ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "Runtime dependency install failed" }
& node (Join-Path $runtimeRoot 'scripts\build-subagent-runtime.mjs')
if ($LASTEXITCODE -ne 0) { throw "Subagent runtime build failed with exit code $LASTEXITCODE" }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$packageOptions = @()
# Cross-building ARM64 on x64 cannot execute the target Node to fabricate V8 bytecode.
if ($Architecture -eq 'arm64') { $packageOptions = @('--no-bytecode', '--public', '--public-packages', '*') }
& pnpm --dir $foundationRoot exec pkg $entry --config (Join-Path $runtimeRoot 'package.json') -t "node24-win-$Architecture" --compress GZip --output $resolvedOutput @packageOptions
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $resolvedOutput)) {
    throw "MoonYa Agent Runtime packaging failed with exit code $LASTEXITCODE"
}

Write-Output "Packaged MoonYa Agent Runtime: $resolvedOutput"
