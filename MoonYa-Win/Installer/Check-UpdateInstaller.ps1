param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$PayloadZip
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$') { throw ('版本号必须是三段数字，例如 1.0.1：' + $Version) }
$installer = (Resolve-Path -LiteralPath $Path).Path
$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
$fileVersion = '{0}.{1}.{2}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
$productVersion = ([string]$info.ProductVersion -split '\+')[0]
Write-Output ('安装程序   : ' + $installer)
Write-Output ('产品标识   : ' + $info.ProductName)
Write-Output ('文件版本   : ' + $fileVersion + '   <- 后端 ProgramUpdateService::validateExe() 与客户端安装前自检读的是这个')
Write-Output ('产品版本   : ' + $productVersion + '   <- 资源管理器属性框显示的字段，不参与校验')
Write-Output ('期望版本   : ' + $Version)
$failed = $false
if ($info.ProductName -ne 'FarSideSetup.UpdateProtocol/1') {
    Write-Output '不通过：产品标识不是 FarSideSetup.UpdateProtocol/1，EXE 必须用安装程序 csproj 重新构建'
    $failed = $true
}
if ($fileVersion -ne $Version) {
    Write-Output ('不通过：文件版本 ' + $fileVersion + ' 与期望 ' + $Version + ' 不一致，上传后台必定被拒')
    $failed = $true
}
if ($productVersion -ne $Version) {
    Write-Output ('不通过：产品版本 ' + $productVersion + ' 与期望 ' + $Version + ' 不一致 —— csproj 里多半写了第二处 <Version>，属性框显示的是假版本')
    $failed = $true
}
if ($PayloadZip) {
    $zip = (Resolve-Path -LiteralPath $PayloadZip).Path
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entry = $archive.Entries | Where-Object { $_.FullName -match '(^|/)FarSide\.dll$' } | Select-Object -First 1
        if (!$entry) {
            Write-Output '不通过：载荷里找不到 FarSide.dll'
            $failed = $true
        } else {
            $temp = Join-Path ([IO.Path]::GetTempPath()) ('farside-payload-' + [Guid]::NewGuid().ToString('N') + '.dll')
            try {
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $temp, $true)
                $payload = [Diagnostics.FileVersionInfo]::GetVersionInfo($temp)
                $payloadVersion = '{0}.{1}.{2}' -f $payload.FileMajorPart, $payload.FileMinorPart, $payload.FileBuildPart
                Write-Output ('载荷客户端 : ' + $entry.FullName + ' -> ' + $payloadVersion)
                if ($payloadVersion -ne $Version) {
                    Write-Output ('不通过：载荷客户端是 ' + $payloadVersion + '，与发布版本 ' + $Version + ' 不一致；用户装上去后 CurrentVersion 仍是 ' + $payloadVersion + '，同版本更新永远不会被客户端接受（要求 latest > current）')
                    $failed = $true
                }
            } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        }
    } finally { $archive.Dispose() }
}
if ($failed) { Write-Output '检查未通过'; exit 1 }
Write-Output '检查通过：版本一致，可以上传发布'
