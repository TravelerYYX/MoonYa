# 程序版本发布与自动更新

管理后台的「更新程序」填写三段数字版本和更新内容，上传支持更新协议的 `FarSideSetup.exe`，校验通过后点击发布。服务端检查 EXE 版本资源、更新协议标识和填写的版本是否一致，再计算 SHA256；旧安装包或填错版本会在发布前拒绝。只支持 EXE；发布后的版本号和安装文件不可替换。客户端按版本数字选择最高已发布版本。

版本列表支持删除，可单条删除或勾选批量删除，草稿与已发布版本都能删（包括当前最新的已发布版本）；删除会一并移除服务端的安装包文件，且无法恢复。删除当前最新已发布版本后，客户端会回退到更低版本；若已无可用的已发布版本，更新将停止下发，操作前请确认。

## 后端部署

先运行 `php MoonYa-Backend/tools/migrate_program_updates.php`，再部署 PHP 后端。全新数据库初始化会自动创建 `program_updates` 表。更新文件保存在服务端 `uploads/program-updates`，部署代码时必须保留这个目录。客户端无需登录即可检查和下载；上传、列表、发布及删除需要管理员令牌。

环境配置：

```ini
MOONYA_UPDATE_CHUNK_BYTES=8388608
MOONYA_UPDATE_MAX_BYTES=2147483648
```

默认分块 8 MiB、包大小上限 2 GiB。PHP `post_max_size` 和网站入口的请求体限制应至少为分块大小，建议 16 MiB；完整 EXE 不需要一次发送。Apache 使用项目 `deployment/apache.conf` 中的更新目录拒绝规则。Nginx 必须额外配置：

```nginx
client_max_body_size 16m;
location ^~ /uploads/program-updates/ { deny all; }
```

公开下载只经过 `admin/api/updates.php?action=download&id=...`，支持 ETag、Range、If-Range、GET/HEAD 和 200/206/416。反向代理不得压缩更新文件或改写范围响应。

## 构建支持自动更新的安装程序

客户端构建版本、安装包版本及后台发布版本必须一致，例如 `1.0.1`。先发布完整 Windows 客户端，再运行：

```powershell
dotnet publish MoonYa-Win/MoonYa-Solution/MoonYa/MoonYa.csproj -c Release -r win-x64 --self-contained true -p:Version=1.0.1 -o artifacts/client-1.0.1
./MoonYa-Win/Installer/Build-UpdateInstaller.ps1 -PublishPath artifacts/client-1.0.1 -AppVersion 1.0.1
```

脚本默认使用 `D:\Project\Project\安装程序\MoonYa\FarSide-安装程序\FarSide-安装程序\FarSide-安装程序.csproj`，其他机器通过 `-InstallerProject` 指定该源码。脚本检查客户端发布包、统一版本并构建单文件 EXE，默认产出到 `artifacts/program-updates/<版本>/FarSideSetup.exe`，拒绝覆盖非空输出目录。安装程序产品标识为 `FarSideSetup.UpdateProtocol/1`；旧安装 EXE 必须重新构建，不支持自动更新的 EXE 会在客户端退出前被拒绝。

版本校验读的是 EXE 的**文件版本**（`FileVersion`，PE 资源 `VS_VERSION_INFO` 的 `dwFileVersionMS/LS`），不是属性框里显示的**产品版本**（`ProductVersion`，来自程序集 `InformationalVersion`）。两者可以不一致：只要安装程序 csproj 里出现第二处 `<Version>`，且它排在 `AssemblyVersion` / `FileVersion` 之后，MSBuild 自上而下求值的结果就是 `FileVersion` 停在旧值、`ProductVersion` 变成新值，属性框显示 `产品版本 1.0.1` 而实际上是 `文件版本 1.0.0.0`，上传时会被判为「安装程序版本与填写的发布版本不一致」。排查：`(Get-Item FarSideSetup.exe).VersionInfo` 看 `FileVersion`（后端校验的就是它）与 `ProductVersion` 是否分叉；修复：安装程序 csproj 只保留一处 `<Version>`（`Condition="'$(Version)' == ''"`），或改用 `Build-UpdateInstaller.ps1 -AppVersion 1.0.1`（脚本会 `-p:Version=` 且构建后自检 FileVersion，不一致直接报错）。

用 Visual Studio 直接「发布」不经过脚本，也不会自检，因此发布前必须确认属性框的**文件版本**与后台填写的版本一致。客户端 `MoonYa/Services/ProgramUpdateService.cs` 在安装前同样按 `FileVersionInfo.FileMajorPart/FileMinorPart/FileBuildPart` 复核，不一致会在客户端被拒。

版本一致性自检（不构建、不改动任何文件，任何出包方式都适用）：

```powershell
# 脚本产出的包（载荷已嵌进 EXE）
./MoonYa-Win/Installer/Check-UpdateInstaller.ps1 -Path artifacts/program-updates/1.0.1/FarSideSetup.exe -Version 1.0.1
# VS 发布的包：额外核对 csproj 里嵌的载荷客户端版本
./MoonYa-Win/Installer/Check-UpdateInstaller.ps1 -Path <FarSideSetup.exe> -Version 1.0.1 -PayloadZip <...>\FarSide-安装程序\Payload\FarSide.zip
```

它同时校验产品标识、文件版本、产品版本和载荷内 `FarSide.dll` 的版本，任一项不符即退出码 1。注意载荷版本必须等于发布版本：客户端安装后 `CurrentVersion` 取自自身程序集版本，更新只有在「服务端版本 > 本机版本」时才会被接受，所以拿 1.0.0 的载荷发 1.0.0 的版本等于永远不会触发更新。VS 发布时 `Payload\FarSide.zip` 需要手工替换成同版本客户端包，脚本 `Build-UpdateInstaller.ps1` 则会自己重打包载荷并统一版本。

普通双击安装继续要求同意协议和选择目录。客户端更新调用 `--update --request <文件>`，以真实进程目录为目标：安装程序验证进程身份、准备载荷和权限，再握手请求客户端退出。需要权限时显示 Windows UAC；取消不会关闭客户端。原用户协调进程负责重新启动，提升权限的工作进程只负责安装。

## 客户端行为与故障恢复

启动和每 30 分钟检查更新；托盘中继续下载，完全退出后下次续传。头像上方 24px 蓝色控件显示白色圆环和百分比，完整下载及 SHA256 校验后显示白色安装图标。悬停查看版本、说明和错误。下载错误会自动续传，也可点击重试。

下载缓存和请求保存在 `%USERPROFILE%\.MoonYa\updates`。安装使用原目录内独立暂存及备份目录，写入事务日志；失败则恢复旧文件。客户端在安装工作进程确认接收任务后才退出。已有 `.MoonYa` 数据、缓存和不属于安装清单的文件不删除。恢复失败时保留备份并记录路径，不启动不完整的应用。上次失败信息保存在 `install-result.json`，重启客户端后显示于更新提示中。

首次启用此功能必须先手动安装包含更新服务的客户端，此后才可自动更新。本次开发不发布生产版本，也不执行生产数据库迁移。

## 验证

```powershell
node --test MoonYa-Frontend/tests/program-updates-http.test.mjs
dotnet build MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/MoonYa.FrontendSmoke.csproj
dotnet MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll --updates-smoke
dotnet build MoonYa-Win/MoonYa-Solution/MoonYa.UpdateInstallerSmoke/MoonYa.UpdateInstallerSmoke.csproj
./MoonYa-Win/MoonYa-Solution/MoonYa.UpdateInstallerSmoke/bin/Debug/net48/MoonYa.UpdateInstallerSmoke.exe
./MoonYa-Win/Installer/Test-UpdateInstaller.ps1
node MoonYa-Frontend/build.mjs
node --test MoonYa-Frontend/tests/program-updates-ui.test.mjs
node --test MoonYa-Frontend/tests/program-updates-install.test.mjs
```

安装 smoke 直接引用同一份安装源码，覆盖中文/空格目录、文件替换、已管理文件清理、锁定文件失败恢复、用户数据保护和路径逃逸。`Test-UpdateInstaller.ps1` 构建实际 WPF 安装程序与隔离的测试载荷，验证握手、等待旧进程退出、原目录替换及自动重启；测试证据保留在 `artifacts/update-installer-e2e`。实际 Windows 权限确认与完整发行包的首次交互安装仍应在发布验收时复核。
