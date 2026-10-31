# MoonYa single Windows installer

The application's automatic updates use the custom WPF `FarSideSetup.exe`, not
the historical Inno Setup script below. Build it using `Build-UpdateInstaller.ps1`
from a complete, versioned client publish directory. See
`../../docs/PROGRAM_UPDATES.zh.md` for backend migration, upload and update behavior.
`Test-UpdateInstaller.ps1` exercises the actual WPF updater against an isolated
fixture and verifies exit, replacement and relaunch without installing the real app.

`Check-UpdateInstaller.ps1 -Path <FarSideSetup.exe> -Version x.y.z [-PayloadZip <FarSide.zip>]`
verifies, without building anything, that the installer's product identifier, PE
`FileVersion`, `ProductVersion` and the payload client's `FarSide.dll` version all
match the release version. The backend and the desktop client both validate the PE
`FileVersion`, not the `ProductVersion` shown in the Explorer property sheet, so a
second `<Version>` element in the installer csproj produces an installer that the
backend rejects. Use this script for Visual Studio publishes, which bypass the
version self-check inside `Build-UpdateInstaller.ps1`.

MoonYa controls the current physical primary desktop. The installer creates shortcuts and registers the uninstaller; it does not install, enable or uninstall display drivers. Previously disabled MoonYa virtual display devices remain disabled. Their sources are retained for historical reference only.

Build `../MoonYa-Solution/MoonYa.DesktopCapture/Build-Capture.ps1`, then publish the self-contained Windows x64 client. Run `Build-Installer.ps1` with `PublishPath`, the Inno Setup 6 `CompilerPath` and `InstallerSigningThumbprint`. No `DriverPackagePath`, WDK, driver catalog or hardware-publisher signature is needed. Installer code signing and verification remain required.

`Test-ReleasePackage.ps1 -PublishPath ...` checks the required application, DXGI capture, bundled Python and bridge files, the physical provider configuration and absence of legacy virtual desktop components. It does not install anything. The installer also excludes stale virtual-display files from its payload.

The payload now includes `frontend/` with local HTML, styles, scripts, fonts, images,
office assets and workers. Every asset is checked against its SHA256 manifest.
PHP, `.env*` and `wwwroot` are forbidden in client releases; upgrades remove the
old `wwwroot` directory while preserving user data and CEF caches. See
`docs/FRONTEND_BACKEND_SEPARATION.zh.md` at the repository root for backend deployment.

An actual signed setup executable and install/upgrade/uninstall acceptance require the existing signing materials and a Windows packaging test environment.

The installer registers the `moonya://payment/return?order_no=...` URI so the verified payment-success page can open the client. A portable client registers it for the current user on startup. Payment returns are forwarded to an existing client in the same Windows user/session; the client refreshes the order through the authenticated membership API.
