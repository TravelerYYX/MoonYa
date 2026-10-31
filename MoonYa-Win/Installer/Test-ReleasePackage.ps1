param([Parameter(Mandatory=$true)][string]$PublishPath)
$ErrorActionPreference = 'Stop'
$publish = (Resolve-Path -LiteralPath $PublishPath).Path
foreach ($file in @('FarSide.exe', 'MoonYa.DesktopCapture.dll', 'launcher_config.json', 'python/python.exe', 'agent_runtime/src/computer_python/runner.py',
    'frontend/index.html', 'frontend/client.js', 'frontend/vendor/pdf.worker.min.js', 'frontend/asset-manifest.json',
    'frontend/workers/conversation-runtime-worker.js', 'frontend/font/qaddin_medium.otf', 'frontend/image/bg.png',
    'frontend/assets/office/seated-back/moonya.png', 'frontend/vendor/highlight.min.js', 'frontend/vendor/mammoth.browser.min.js',
    'agent_runtime/src/desktop-gateway.mjs')) {
    if (!(Test-Path -LiteralPath (Join-Path $publish $file))) { throw "Incomplete Windows release: $file" }
}
$config = Get-Content -LiteralPath (Join-Path $publish 'launcher_config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.desktop_automation.provider -ne 'physical') { throw 'Release must use the physical desktop provider.' }
foreach ($file in @('virtual_display/MoonYa.DisplayHost.exe', 'virtual_display/Install-VirtualDrivers.ps1', 'virtual_display/Set-VirtualDriversState.ps1', 'MoonYa.DesktopHost.exe', 'MoonYaVirtualDisplay.dll')) {
    if (Test-Path -LiteralPath (Join-Path $publish $file)) { throw "Legacy virtual desktop component in release: $file" }
}
Write-Output 'Physical desktop release payload verified. No virtual display driver is required.'
foreach ($file in Get-ChildItem -LiteralPath $publish -Recurse -File) {
    if ($file.Extension -eq '.php' -or $file.Name -like '.env*' -or $file.FullName -match '[\\/]wwwroot[\\/]') {
        throw "Server-only file found in desktop release: $($file.FullName)"
    }
}
$frontendRoot = Join-Path $publish 'frontend'
$manifest = Get-Content -LiteralPath (Join-Path $frontendRoot 'asset-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $manifest.PSObject.Properties) {
    $target = Join-Path $frontendRoot $entry.Name
    if (!(Test-Path -LiteralPath $target)) { throw "Frontend asset is missing: $target" }
    $assetStream = [IO.File]::OpenRead($target)
    $assetHash = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($assetHash.ComputeHash($assetStream)).Replace('-', '').ToLowerInvariant() }
    finally { $assetHash.Dispose(); $assetStream.Dispose() }
    if ($actualHash -ne $entry.Value) {
        throw "Missing or stale frontend resource: $target"
    }
}
