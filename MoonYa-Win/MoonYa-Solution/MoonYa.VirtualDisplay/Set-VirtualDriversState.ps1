param(
    [Parameter(Mandatory=$true)][ValidateSet('Enabled','Disabled')][string]$State,
    [string]$RecordPath="$env:LOCALAPPDATA\MoonYa\virtual-display\installation.json"
)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run elevated.' }
$record=Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
if ($record.provider -ne 'virtualdrivers' -or $record.status -ne 'installed' -or $record.device_instance_id -notmatch '^ROOT\\DISPLAY\\[0-9]+$' -or $record.before.devices.InstanceId -contains $record.device_instance_id) { throw 'Installation ownership check failed.' }
$hardware=Get-PnpDeviceProperty -InstanceId $record.device_instance_id -KeyName 'DEVPKEY_Device_HardwareIds'
if ($hardware.Data -notcontains 'Root\MttVDD') { throw 'Recorded device no longer belongs to MttVDD.' }
$logPath=Join-Path (Split-Path -Parent $RecordPath) 'device-state.log'
Start-Transcript -Path $logPath -Append | Out-Null
try {
    $operation=if($State -eq 'Enabled') {'/enable-device'}else{'/disable-device'}
    & pnputil.exe $operation $record.device_instance_id
    if($LASTEXITCODE -notin 0,3010){throw "Device state change failed: $LASTEXITCODE"}
    Get-PnpDevice -InstanceId $record.device_instance_id | Select-Object InstanceId,Status,FriendlyName
} finally { Stop-Transcript | Out-Null }
