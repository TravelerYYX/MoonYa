#ifndef PublishPath
  #error PublishPath is required
#endif
#ifndef OutputPath
  #error OutputPath is required
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{B503FE8E-CA18-49AF-B6C3-2B5F8D7B80DD}
AppName=MoonYa
AppVersion={#AppVersion}
DefaultDirName={autopf}\MoonYa
DefaultGroupName=MoonYa
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#OutputPath}
OutputBaseFilename=MoonYa-Setup-x64-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\FarSide.exe

[InstallDelete]
; Old desktop PHP copies are generated application files; user history is in .MoonYa.
Type: filesandordirs; Name: "{app}\wwwroot"

[Files]
Source: "{#PublishPath}\*"; DestDir: "{app}"; Excludes: "wwwroot\*,*.php,.env*,virtual_display\*,setup\Install-Driver.ps1,setup\Uninstall-Driver.ps1"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\MoonYa"; Filename: "{app}\FarSide.exe"
Name: "{autodesktop}\MoonYa"; Filename: "{app}\FarSide.exe"

[Registry]
Root: HKLM; Subkey: "Software\Classes\moonya"; ValueType: string; ValueName: ""; ValueData: "URL:MoonYa Protocol"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Classes\moonya"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKLM; Subkey: "Software\Classes\moonya\DefaultIcon"; ValueType: string; ValueData: """{app}\FarSide.exe"",0"
Root: HKLM; Subkey: "Software\Classes\moonya\shell\open\command"; ValueType: string; ValueData: """{app}\FarSide.exe"" ""%1"""

[Run]
Filename: "{app}\FarSide.exe"; Description: "启动 MoonYa"; Flags: postinstall nowait skipifsilent runasoriginaluser

