param(
    [ValidateRange(1024,65535)][int]$Port = 19091,
    [string]$Cloudflared = "$env:LOCALAPPDATA\MoonYaTools\cloudflared-2026.9.3.exe",
    [string]$StateFile = ''
)
$ErrorActionPreference = 'Stop'
if (-not $StateFile) { $StateFile = Join-Path $env:LOCALAPPDATA ("MoonYaTools\payment-sandbox-$Port.json") }
New-Item -ItemType Directory -Path (Split-Path -Parent $StateFile) -Force | Out-Null
if (Test-Path -LiteralPath $StateFile) {
    $paymentExisting = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $paymentExistingProcess = Get-Process -Id $paymentExisting.launcher.id -ErrorAction SilentlyContinue
    if ($paymentExistingProcess -and $paymentExistingProcess.StartTime.ToUniversalTime().Ticks.ToString() -eq $paymentExisting.launcher.started) { throw 'This sandbox tunnel is already running; stop it before starting another.' }
}
$paymentPhp = (Get-Command php -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $Cloudflared -PathType Leaf)) { throw 'cloudflared is missing. Install the official executable and pass -Cloudflared <path>.' }
$paymentRelay = Join-Path $PSScriptRoot 'payment_sandbox_relay.php'
$paymentTemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('moonya-sandbox-origin-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $paymentTemporaryRoot | Out-Null
$paymentPreviousOptIn = $env:MOONYA_PAYMENT_SANDBOX_RELAY
$paymentProcess = $null
$paymentTunnel = $null
try {
    $env:MOONYA_PAYMENT_SANDBOX_RELAY = '1'
    # No request log file: PHP's development server would otherwise log checkout tokens.
    $paymentStart = New-Object System.Diagnostics.ProcessStartInfo
    $paymentStart.FileName = $paymentPhp
    $paymentStart.Arguments = '-S 127.0.0.1:' + $Port + ' -t "' + $paymentTemporaryRoot + '" "' + $paymentRelay + '"'
    $paymentStart.WorkingDirectory = $PSScriptRoot
    $paymentStart.UseShellExecute = $false
    $paymentStart.CreateNoWindow = $true
    $paymentStart.RedirectStandardOutput = $true
    $paymentStart.RedirectStandardError = $true
    $paymentProcess = New-Object System.Diagnostics.Process
    $paymentProcess.StartInfo = $paymentStart
    if (-not $paymentProcess.Start()) { throw 'Could not start the local sandbox origin.' }
    $paymentOriginOutput = $paymentProcess.StandardOutput.ReadToEndAsync()
    $paymentOriginErrors = $paymentProcess.StandardError.ReadToEndAsync()
    Start-Sleep -Milliseconds 500
    if ($paymentProcess.HasExited) { throw 'Sandbox origin failed to start; check whether the port is occupied.' }
    Write-Host 'Copy the https://*.trycloudflare.com root URL into the local payment settings. Keep this terminal running.'
    Write-Host 'Only sandbox checkout/notify/return endpoints are exposed. Ctrl+C stops the tunnel and origin.'
    $paymentTunnelStart = New-Object System.Diagnostics.ProcessStartInfo
    $paymentTunnelStart.FileName = (Resolve-Path -LiteralPath $Cloudflared).Path
    $paymentTunnelStart.Arguments = 'tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:' + $Port + ' --loglevel info'
    $paymentTunnelStart.UseShellExecute = $false
    $paymentTunnelStart.CreateNoWindow = $true
    $paymentTunnelStart.RedirectStandardOutput = $true
    $paymentTunnelStart.RedirectStandardError = $true
    $paymentTunnel = New-Object System.Diagnostics.Process
    $paymentTunnel.StartInfo = $paymentTunnelStart
    if (-not $paymentTunnel.Start()) { throw 'Could not start the HTTPS tunnel.' }
    $paymentLauncher = Get-Process -Id $PID
    $paymentState = [ordered]@{
        port = $Port
        launcher = @{ id = $PID; started = $paymentLauncher.StartTime.ToUniversalTime().Ticks.ToString() }
        origin = @{ id = $paymentProcess.Id; started = $paymentProcess.StartTime.ToUniversalTime().Ticks.ToString() }
        tunnel = @{ id = $paymentTunnel.Id; started = $paymentTunnel.StartTime.ToUniversalTime().Ticks.ToString() }
    }
    $paymentState | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
    $paymentTunnelOutput = $paymentTunnel.StandardOutput.ReadLineAsync()
    $paymentTunnelErrors = $paymentTunnel.StandardError.ReadLineAsync()
    $paymentShown = $false
    while (-not $paymentTunnel.HasExited) {
        foreach ($paymentStream in @('output','errors')) {
            $paymentTask = if ($paymentStream -eq 'output') { $paymentTunnelOutput } else { $paymentTunnelErrors }
            if ($paymentTask -and $paymentTask.IsCompleted) {
                $paymentLine = $paymentTask.GetAwaiter().GetResult()
                # Display the public root URL only; do not forward provider logs with request tokens.
                if (-not $paymentShown -and $paymentLine -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
                    Write-Host ('Sandbox HTTPS address: ' + $Matches[0]); $paymentShown = $true
                    $paymentState['url'] = $Matches[0]
                    $paymentState | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
                }
                if ($paymentStream -eq 'output') { $paymentTunnelOutput = if ($null -ne $paymentLine) { $paymentTunnel.StandardOutput.ReadLineAsync() } else { $null } }
                else { $paymentTunnelErrors = if ($null -ne $paymentLine) { $paymentTunnel.StandardError.ReadLineAsync() } else { $null } }
            }
        }
        if ($paymentProcess.HasExited) { throw 'The local sandbox origin stopped unexpectedly.' }
        Start-Sleep -Milliseconds 100
    }
    if ($paymentTunnel.ExitCode -ne 0 -or -not $paymentShown) { throw 'HTTPS tunnel could not connect. Check network access to Cloudflare or use an existing HTTPS tunnel.' }
} finally {
    $env:MOONYA_PAYMENT_SANDBOX_RELAY = $paymentPreviousOptIn
    if ($paymentProcess -and -not $paymentProcess.HasExited) { $paymentProcess.Kill(); $paymentProcess.WaitForExit() }
    if ($paymentProcess) { $paymentProcess.Dispose() }
    if ($paymentTunnel -and -not $paymentTunnel.HasExited) { $paymentTunnel.Kill(); $paymentTunnel.WaitForExit() }
    if ($paymentTunnel) { $paymentTunnel.Dispose() }
    if (Test-Path -LiteralPath $StateFile) {
        $paymentLastState = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        if ($paymentLastState.launcher.id -eq $PID) { Remove-Item -LiteralPath $StateFile }
    }
    # The empty, explicitly created directory needs no recursive deletion.
    Remove-Item -LiteralPath $paymentTemporaryRoot
}
