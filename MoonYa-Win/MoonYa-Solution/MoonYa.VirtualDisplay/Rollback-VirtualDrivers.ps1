param([string]$RecordPath="$env:LOCALAPPDATA\MoonYa\virtual-display\installation.json")
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run rollback elevated; close MoonYa first.' }
$record=Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
if ($record.provider -ne 'virtualdrivers' -or $record.release -ne '25.7.23') { throw 'Unexpected installation record.' }
Start-Transcript -Path (Join-Path (Split-Path -Parent $RecordPath) 'rollback.log') -Append | Out-Null
try {
    if ($record.device_created -and $record.device_instance_id) {
        if ($record.device_instance_id -notmatch '^ROOT\\DISPLAY\\[0-9]+$' -or $record.before.devices.InstanceId -contains $record.device_instance_id) { throw 'Device ownership check failed.' }
        $existing=Get-PnpDevice -InstanceId $record.device_instance_id -ErrorAction SilentlyContinue
        if ($existing) { & pnputil.exe /remove-device $record.device_instance_id; if ($LASTEXITCODE -notin 0,3010) { throw 'Device removal failed.' } }
    }
    if ($record.published_inf) {
        if ($record.published_inf -notmatch '^oem[0-9]+\.inf$' -or $record.before.drivers.Driver -contains $record.published_inf) { throw 'Driver ownership check failed.' }
        if (Get-CimInstance Win32_PnPSignedDriver | Where-Object InfName -eq $record.published_inf) { throw 'Another device still uses this driver; keeping the package and certificate.' }
        $driver=Get-WindowsDriver -Online -Driver $record.published_inf -ErrorAction SilentlyContinue
        if ($driver) {
            if ([IO.Path]::GetFileName($driver.OriginalFileName) -ine 'MttVDD.inf') { throw 'Driver identity has changed.' }
            & pnputil.exe /delete-driver $record.published_inf
            if ($LASTEXITCODE -notin 0,3010) { throw 'Driver package removal failed.' }
        }
    }
    if ($record.certificate_added -and !($record.before.publishers.Thumbprint -contains $record.certificate_thumbprint)) {
        $store=[Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher','LocalMachine')
        try { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite); foreach($certificate in @($store.Certificates | Where-Object Thumbprint -eq $record.certificate_thumbprint)) { $store.Remove($certificate) } } finally { $store.Close() }
    }
    if ($record.config_created) {
        $directory=[IO.Path]::GetFullPath($record.config_directory)
        if ($directory -ne 'C:\VirtualDisplayDriver') { throw 'Unexpected configuration directory.' }
        $file=Join-Path $directory 'vdd_settings.xml'
        if (Test-Path -LiteralPath $file) {
            $sha=[Security.Cryptography.SHA256]::Create()
            try { $currentHash=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
            if ($currentHash -ne $record.config_sha256) { throw 'Configuration changed since installation; keeping it for inspection.' }
            Remove-Item -LiteralPath $file
        }
        if ((Test-Path -LiteralPath $directory) -and !(Get-ChildItem -LiteralPath $directory -Force)) { Remove-Item -LiteralPath $directory }
    }
    $record.status='rolled_back'; $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $RecordPath -Encoding UTF8
} finally { Stop-Transcript | Out-Null }
