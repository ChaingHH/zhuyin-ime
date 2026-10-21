; 單一 Setup.exe：給沒有 repo、沒有 Rust 的人安裝（docs/PIME-INSTALL.md「做成 Setup.exe」）。
; 先跑 build-setup.cmd（它會組出 dist\zhuyin\，再用 Inno Setup 6 的 ISCC.exe 編這個檔）。
; 第三方授權聲明（THIRD-PARTY-NOTICES.txt、LICENSE-LGPL-2.1.txt）由 install.ps1 -Stage 組進 dist\zhuyin\，跟著裝進 PIME\zhuyin\。
; Setup.exe 只是把檔案帶過去，再呼叫同一支 install.ps1 -From：安全規則完全相同
; （不停 PIMELauncher、被鎖的檔案改名不覆寫、保留 zhuyin.prev\、可 -Rollback）。
; 需要對方已經裝好 PIME 2.0（v2.0.0-beta3 以上較安全，見 docs/MS-CANDIDATES.md §5.4）。

#define AppName "注音 (zhuyin-native) for PIME"
#define AppVersion "0.99.0"

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

[Code]
function InitializeSetup(): Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf32}\PIME\backends.json'));
  if not Result then
    MsgBox('找不到 PIME（C:\Program Files (x86)\PIME）。請先安裝 PIME 2.0，再執行這個安裝程式。', mbError, MB_OK);
end;

{ 解除安裝：先跑 install.ps1 -Uninstall，沒成功就中止，{app} 裡的 install.ps1 與檔案副本留著給下次再解除安裝。
  結束碼 2＝zhuyin 還在鍵盤清單裡或後端還在跑（install.ps1 已從目前使用者的清單拿掉），要登出再登入再解除安裝一次。
  記錄檔放 commonappdata，不放 app（解除安裝會刪掉 app 資料夾）。 }
function InitializeUninstall(): Boolean;
var
  Code: Integer;
  Log: String;
begin
  Log := ExpandConstant('{commonappdata}\zhuyin-native-uninstall.log');
  Result := False;
  if not Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install.ps1') + '" -Uninstall -Log "' + Log + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) then
    MsgBox('無法執行 PowerShell，沒有解除安裝。', mbError, MB_OK)
  else if Code = 2 then
    MsgBox('「注音 (zhuyin-native)」還在使用中，這次只把它從鍵盤清單拿掉。' + #13#10 +
      '請登出再登入，再解除安裝一次。詳細記錄：' + #13#10 + Log, mbInformation, MB_OK)
  else if Code <> 0 then
    MsgBox('解除安裝失敗。詳細記錄：' + #13#10 + Log, mbError, MB_OK)
  else
    Result := True;
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
        '第一次安裝的話，登入後到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤」加入「注音 (zhuyin-native)」。',
        mbInformation, MB_OK);
  end;
end;
