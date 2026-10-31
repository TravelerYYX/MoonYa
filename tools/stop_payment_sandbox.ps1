param(
    [ValidateRange(1024,65535)][int]$Port = 19091,
    [string]$StateFile = ''
)
$ErrorActionPreference = 'Stop'
if (-not $StateFile) { $StateFile = Join-Path $env:LOCALAPPDATA ("MoonYaTools\payment-sandbox-$Port.json") }
if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { Write-Host 'No recorded sandbox tunnel is running.'; exit }
$paymentState = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
if ($paymentState.port -ne $Port) { throw 'Sandbox state port mismatch.' }
foreach ($paymentKind in @('tunnel','origin')) {
    $paymentRecorded = $paymentState.$paymentKind
    $paymentChild = Get-Process -Id $paymentRecorded.id -ErrorAction SilentlyContinue
    # Verify creation time as well as PID to avoid killing an unrelated reused PID.
    if ($paymentChild -and $paymentChild.StartTime.ToUniversalTime().Ticks.ToString() -eq $paymentRecorded.started) { Stop-Process -Id $paymentChild.Id }
}
$paymentLauncher = Get-Process -Id $paymentState.launcher.id -ErrorAction SilentlyContinue
if ($paymentLauncher -and $paymentLauncher.StartTime.ToUniversalTime().Ticks.ToString() -eq $paymentState.launcher.started) {
    Wait-Process -Id $paymentLauncher.Id -Timeout 5 -ErrorAction SilentlyContinue
    $paymentStillRunning = Get-Process -Id $paymentLauncher.Id -ErrorAction SilentlyContinue
    if ($paymentStillRunning -and $paymentStillRunning.StartTime.ToUniversalTime().Ticks.ToString() -eq $paymentState.launcher.started) { Stop-Process -Id $paymentLauncher.Id }
}
if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile }
Write-Host 'Sandbox tunnel and local origin stopped.'
