param(
    [string]$PackageZip,
    [string]$RecordPath = "$env:LOCALAPPDATA\MoonYa\virtual-display\installation.json"
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer elevated.' }
if (![Environment]::Is64BitProcess) { throw 'Use x64 PowerShell.' }
if (Test-Path -LiteralPath $RecordPath) { throw "Installation record already exists: $RecordPath. Inspect or roll back before installing again." }
$recordDirectory = Split-Path -Parent $RecordPath
New-Item -ItemType Directory -Path $recordDirectory -Force | Out-Null
Start-Transcript -Path (Join-Path $recordDirectory 'install.log') -Append | Out-Null
$record = [ordered]@{ provider='virtualdrivers'; release='25.7.23'; status='preparing'; started_at=(Get-Date).ToString('o'); config_directory='C:\VirtualDisplayDriver'; config_created=$false; certificate_added=$false; device_created=$false; device_instance_id=$null; published_inf=$null; error=$null }
function Save-Record { $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $RecordPath -Encoding UTF8 }
function Sha256([string]$file) {
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
}
try {
    Add-Type -AssemblyName System.Windows.Forms
    $beforeDevices = @(Get-PnpDevice | Select-Object InstanceId,FriendlyName,Status,Class)
    $beforeDrivers = @(Get-WindowsDriver -Online | Select-Object Driver,OriginalFileName,ProviderName,Version)
    $beforeScreens = @([Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ device=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } })
    $record.before = @{ devices=$beforeDevices; drivers=$beforeDrivers; screens=$beforeScreens; publishers=@(Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Select-Object Thumbprint,Subject) }
    Save-Record
    if ($beforeDevices | Where-Object { $_.FriendlyName -eq 'Virtual Display Driver' -or $_.InstanceId -match 'MTTVDD' }) { throw 'An existing MttVDD device was found; no changes made.' }
    if ($beforeDrivers | Where-Object { [IO.Path]::GetFileName($_.OriginalFileName) -ieq 'MttVDD.inf' }) { throw 'An existing MttVDD driver package was found; no changes made.' }
    if (Test-Path -LiteralPath $record.config_directory) { throw 'C:\VirtualDisplayDriver already exists; no changes made.' }
    if (!$PackageZip) {
        $PackageZip = Join-Path $recordDirectory 'VirtualDisplayDriver-x86.Driver.Only.zip'
        Invoke-WebRequest -UseBasicParsing 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip' -OutFile $PackageZip
    }
    $PackageZip=(Resolve-Path -LiteralPath $PackageZip).Path
    $record.archive_sha256=Sha256 $PackageZip
    if ($record.archive_sha256 -ne 'e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a') { throw 'Pinned release archive SHA256 mismatch.' }
    $extract = Join-Path $recordDirectory ('package-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $extract) { throw 'Package extraction directory already exists.' }
    Expand-Archive -LiteralPath $PackageZip -DestinationPath $extract
    $package=Join-Path $extract 'VirtualDisplayDriver'
    $catalog=Join-Path $package 'mttvdd.cat'; $dll=Join-Path $package 'MttVDD.dll'; $inf=Join-Path $package 'MttVDD.inf'
    $signatures=@($catalog,$dll | ForEach-Object { Get-AuthenticodeSignature -LiteralPath $_ })
    foreach ($signature in $signatures) {
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=SignPath Foundation,') { throw 'Unexpected or untrusted release signature.' }
    }
    if ($signatures[0].SignerCertificate.Thumbprint -ne $signatures[1].SignerCertificate.Thumbprint) { throw 'Driver and catalog signer mismatch.' }
    if ((Get-Content -LiteralPath $inf -Raw) -notmatch 'Root\\MttVDD' -or (Get-Content -LiteralPath $inf -Raw) -notmatch 'Standard,NTamd64') { throw 'Unexpected driver identity or architecture.' }
    $record.signatures=@($signatures | ForEach-Object { @{status=$_.Status.ToString();subject=$_.SignerCertificate.Subject;thumbprint=$_.SignerCertificate.Thumbprint} })
    $certificate=$signatures[0].SignerCertificate
    $record.certificate_thumbprint=$certificate.Thumbprint
    Save-Record
    $store=[Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher','LocalMachine')
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        if (!($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint)) {
            $record.certificate_added=$true; Save-Record
            $store.Add($certificate)
        }
    } finally { $store.Close() }
    $record.config_created=$true; Save-Record
    New-Item -ItemType Directory -Path $record.config_directory | Out-Null
    $configPath=Join-Path $record.config_directory 'vdd_settings.xml'
    [xml]$settings=Get-Content -LiteralPath (Join-Path $package 'vdd_settings.xml') -Raw
    $settings.vdd_settings.monitors.count='1'
    $settings.Save($configPath)
    $record.config_sha256=Sha256 $configPath; Save-Record
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MoonYaVddInstall {
    [StructLayout(LayoutKind.Sequential)] public struct Info { public int Size; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
    static IntPtr set; static Info info;
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static string Prepare() {
        Guid guid=new Guid("4D36E968-E325-11CE-BFC1-08002BE10318");
        set=SetupDiCreateDeviceInfoList(ref guid,IntPtr.Zero);
        if (set==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        info=new Info { Size=Marshal.SizeOf(typeof(Info)) };
        Check(SetupDiCreateDeviceInfo(set,"Display",ref guid,"Virtual Display Driver",IntPtr.Zero,1,ref info));
        byte[] hardware=Encoding.Unicode.GetBytes("Root\\MttVDD\0\0");
        Check(SetupDiSetDeviceRegistryProperty(set,ref info,1,hardware,(uint)hardware.Length));
        var id=new StringBuilder(1024); uint required;
        Check(SetupDiGetDeviceInstanceId(set,ref info,id,id.Capacity,out required));
        return id.ToString();
    }
    public static void Register() { Check(SetupDiCallClassInstaller(0x19,set,ref info)); }
    public static void Close() { if(set!=IntPtr.Zero && set!=new IntPtr(-1)) SetupDiDestroyDeviceInfoList(set); set=IntPtr.Zero; }
    [DllImport("setupapi.dll",SetLastError=true)] static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid guid,IntPtr hwnd);
    [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiCreateDeviceInfo(IntPtr set,string name,ref Guid guid,string desc,IntPtr hwnd,uint flags,ref Info info);
    [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set,ref Info info,uint property,byte[] data,uint size);
    [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiGetDeviceInstanceId(IntPtr set,ref Info info,StringBuilder id,int size,out uint required);
    [DllImport("setupapi.dll",SetLastError=true)] static extern bool SetupDiCallClassInstaller(uint function,IntPtr set,ref Info info);
    [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
}
'@
    try {
        $record.device_instance_id=[MoonYaVddInstall]::Prepare()
        $record.device_created=$true; Save-Record
        [MoonYaVddInstall]::Register()
    } finally { [MoonYaVddInstall]::Close() }
    $record.status='device_registered'; Save-Record
    & pnputil.exe /add-driver $inf /install
    $installExit=$LASTEXITCODE
    $installedDriver=Get-WindowsDriver -Online | Where-Object { [IO.Path]::GetFileName($_.OriginalFileName) -ieq 'MttVDD.inf' }
    if (@($installedDriver).Count -eq 1) { $record.published_inf=$installedDriver.Driver; Save-Record }
    if ($installExit -notin 0,3010) { throw "pnputil installation failed: $installExit" }
    if (!$record.published_inf) { throw 'Cannot identify installed driver package.' }
    $device=Get-PnpDevice -InstanceId $record.device_instance_id
    if ($device.Status -ne 'OK') { throw "Driver device status is $($device.Status); reboot or driver diagnostics required." }
    $record.status='installed'; $record.reboot_required=($installExit -eq 3010); $record.finished_at=(Get-Date).ToString('o'); Save-Record
    Write-Output "Installed $($record.device_instance_id). Record: $RecordPath"
} catch {
    $record.status='failed'; $record.error=$_.Exception.ToString(); Save-Record
    Write-Error $_
    exit 1
} finally { Stop-Transcript | Out-Null }
