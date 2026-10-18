; 單一 Setup.exe：給沒有 repo、沒有 Rust 的人安裝（docs/PIME-INSTALL.md「做成 Setup.exe」）。
; 先跑 build-setup.cmd（它會組出 dist\zhuyin\，再用 Inno Setup 6 的 ISCC.exe 編這個檔）。
; Setup.exe 只是把檔案帶過去，再呼叫同一支 install.ps1 -From：安全規則完全相同
; （不停 PIMELauncher、被鎖的檔案改名不覆寫、保留 zhuyin.prev\、可 -Rollback）。
; 需要對方已經裝好 PIME 2.0（v2.0.0-beta3 以上較安全，見 docs/MS-CANDIDATES.md §5.4）。

#define AppName "注音 (zhuyin-native) for PIME"
#define AppVersion "0.1.0"

[Setup]
AppId={{64B60746-4570-4343-A34A-85C12F03A93B}
AppName={#AppName}
AppVersion={#AppVersion}
; 這裡只放安裝程式自己的檔案（install.ps1 與一份 zhuyin\ 副本，給解除安裝與 -Rollback 用）；
; 真正的輸入法由 install.ps1 放進 PIME 目錄
DefaultDirName={commonappdata}\zhuyin-native-setup
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=zhuyin-native-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
UninstallDisplayName={#AppName}

[Files]
Source: "dist\zhuyin\*"; DestDir: "{app}\zhuyin"; Flags: recursesubdirs ignoreversion
Source: "install.ps1"; DestDir: "{app}"; Flags: ignoreversion

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -Uninstall -Log ""{app}\uninstall.log"""; Flags: waituntilterminated runhidden; RunOnceId: "zhuyin-uninstall"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf32}\PIME\backends.json'));
  if not Result then
    MsgBox('找不到 PIME（C:\Program Files (x86)\PIME）。請先安裝 PIME 2.0，再執行這個安裝程式。', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Log: String;
begin
  if CurStep = ssPostInstall then
  begin
    Log := ExpandConstant('{app}\install.log');
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install.ps1') +
      '" -From "' + ExpandConstant('{app}\zhuyin') + '" -Log "' + Log + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Code);
    if Code <> 0 then
      MsgBox('安裝失敗。詳細記錄：' + #13#10 + Log, mbError, MB_OK)
    else
      MsgBox('完成。請登出再登入。' + #13#10 +
        '第一次安裝的話，再到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤」加入「注音 (zhuyin-native)」。',
        mbInformation, MB_OK);
  end;
end;
