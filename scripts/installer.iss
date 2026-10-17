; MoeBot desktop console - Inno Setup 6 installer script
;
; Build:
;   node scripts/build-frontend.mjs          (not required: the console is already
;                                             embedded in the exe by tauri build)
;   npx tauri build --no-bundle              (produces src-tauri\target\release\moebot-desktop.exe)
;   ISCC.exe scripts\installer.iss
;
; or just:  npm run build:setup
;
; What gets installed: the self-contained exe (renamed to MoeBot.exe) plus
; WebView2Loader.dll next to it, which is exactly what the WiX MSI ships.
;
; The Microsoft Edge WebView2 runtime is a machine prerequisite. It is detected in
; the same three registry locations the MSI checks, and installed from the
; bootstrapper vendored next to this script (falling back to a download) when it is
; missing. Pass /DSkipWebView2Bundle=1 to leave the bootstrapper out of the package.

#define AppName "MoeBot"
#define AppExeName "MoeBot.exe"
#define AppPublisher "MoeBot"
; Fixed AppId: upgrades replace the previous install instead of stacking up.
#define AppId "{{1C8F4B62-2A7D-4E55-9B3C-6D5A9E0F7C41}"

#define SourceExe "..\src-tauri\target\release\moebot-desktop.exe"
#define SourceLoader "..\src-tauri\target\release\WebView2Loader.dll"
#define SourceWebView2 "MicrosoftEdgeWebview2Setup.exe"

; npm run build:setup passes /DAppVersion=<package.json version>.
#ifndef AppVersion
  #define AppVersion GetFileVersion(SourceExe)
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoDescription={#AppName} installer
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
AllowNoIcons=yes
; Per-user by default so the install never needs an administrator; the wizard still
; offers "install for all users" when started elevated.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\src-tauri\target\release\bundle\inno
OutputBaseFilename={#AppName}_{#AppVersion}_x64_setup
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
; Inno Setup itself ships no Simplified Chinese translation; ChineseTraditional is
; the only Chinese language file present in a default install.
Name: "chinesetraditional"; MessagesFile: "compiler:Languages\ChineseTraditional.isl"

[CustomMessages]
english.LaunchApp=Launch {#AppName}
chinesetraditional.LaunchApp=執行 {#AppName}
english.DesktopIcon=Create a &desktop shortcut
chinesetraditional.DesktopIcon=建立桌面捷徑(&D)
english.WebView2Prompt=Microsoft Edge WebView2 is required to display the console and is not installed yet.%n%nDownload and install it now? (an administrator prompt may appear)
chinesetraditional.WebView2Prompt=MoeBot 需要 Microsoft Edge WebView2 才能顯示主控台，但目前尚未安裝。%n%n要現在下載並安裝嗎？（可能會出現系統管理員提示）
english.WebView2Downloading=Downloading the Microsoft Edge WebView2 installer...
chinesetraditional.WebView2Downloading=正在下載 Microsoft Edge WebView2 安裝程式...
english.WebView2Failed=Microsoft Edge WebView2 could not be installed automatically.%n%nInstall it manually and run {#AppName} again after that:%nhttps://developer.microsoft.com/microsoft-edge/webview2/
chinesetraditional.WebView2Failed=無法自動安裝 Microsoft Edge WebView2。%n%n請手動安裝後再執行 {#AppName}：%nhttps://developer.microsoft.com/microsoft-edge/webview2/

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion
Source: "{#SourceLoader}"; DestDir: "{app}"; Flags: ignoreversion
#ifndef SkipWebView2Bundle
Source: "{#SourceWebView2}"; DestDir: "{tmp}"; DestName: "MicrosoftEdgeWebview2Setup.exe"; Flags: deleteafterinstall; Check: not WebView2Installed
#endif

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

; The WiX MSI keeps a pointer to its install directory here, so writing the same
; key lets either installer pick up the other's location on upgrade. The key itself
; is only removed when this installer was the last one to write to it.
[Registry]
Root: HKCU; Subkey: "Software\moebot\MoeBot"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\moebot\MoeBot"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"; Flags: uninsdeletevalue uninsdeletekeyifempty

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[Code]
const
  { Client id of the Evergreen WebView2 runtime; the MSI searches the same key in the
    32-bit view, the 64-bit view and the current user hive. }
  WebView2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';
  WebView2FileName = 'MicrosoftEdgeWebview2Setup.exe';

function WebView2Version(): String;
begin
  Result := '';
  if RegQueryStringValue(HKLM64, WebView2Key, 'pv', Result) then Exit;
  if RegQueryStringValue(HKLM32, WebView2Key, 'pv', Result) then Exit;
  if RegQueryStringValue(HKCU, WebView2Key, 'pv', Result) then Exit;
end;

function WebView2Installed(): Boolean;
begin
  Result := WebView2Version() <> '';
end;

function DownloadWebView2(const Target: String): Boolean;
var
  Command: String;
  ResultCode: Integer;
begin
  Command := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ' +
    'Invoke-WebRequest -Uri ''' + WebView2Url + ''' -OutFile ''' + Target + '''"';
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Command, '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) and FileExists(Target);
end;

procedure InstallWebView2();
var
  Bootstrapper: String;
  ResultCode: Integer;
begin
  if WebView2Installed() then Exit;
  if MsgBox(CustomMessage('WebView2Prompt'), mbConfirmation, MB_YESNO) = IDNO then Exit;

  Bootstrapper := ExpandConstant('{tmp}\') + WebView2FileName;
  if not FileExists(Bootstrapper) then
  begin
    if not DownloadWebView2(Bootstrapper) then
    begin
      MsgBox(CustomMessage('WebView2Failed'), mbCriticalError, MB_OK);
      Exit;
    end;
  end;

  { /silent /install is the bootstrapper's own flag set; it elevates itself when the
    machine-wide runtime is not present. Success is judged by the registry, because
    the bootstrapper reports non-zero for cases that still end up installed. }
  Exec(Bootstrapper, '/silent /install', '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
  if not WebView2Installed() then
    MsgBox(CustomMessage('WebView2Failed'), mbCriticalError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    InstallWebView2();
end;
