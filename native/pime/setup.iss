; 單一 Setup.exe：給沒有 repo、沒有 Rust 的人安裝（docs/PIME-INSTALL.md「做成 Setup.exe」）。
; 先跑 build-setup.cmd（它會組出 dist\zhuyin\，再用 Inno Setup 6 的 ISCC.exe 編這個檔）。
; 第三方授權聲明（THIRD-PARTY-NOTICES.txt、LICENSE-LGPL-2.1.txt）由 install.ps1 -Stage 組進 dist\zhuyin\，跟著裝進 PIME\zhuyin\。
; Setup.exe 只是把檔案帶過去，再呼叫同一支 install.ps1 -From：安全規則完全相同
; （不停 PIMELauncher、被鎖的檔案改名不覆寫、保留 zhuyin.prev\、可 -Rollback）。
; 內附 build-setup.ps1 當時最新的 PIME 官方安裝檔（vendor\，驗 SHA-256），交給 install.ps1 -PimeSetup：
; 沒有 PIME、DLL 不見、或已裝的比內附的舊時靜默安裝（規則見 install.ps1 的 Update-Pime）。
; 第一次安裝寫一個 RunOnce：登出再登入時把「注音 (zhuyin-native)」加進鍵盤清單（install.ps1 -Keyboard add）。

#define AppName "注音 (zhuyin-native) for PIME"
#define AppVersion "1.0.4"
; build-setup.ps1 用 /DPimeSetup=<檔名> 傳進來（vendor\ 裡最新的 PIME 安裝檔）
#ifndef PimeSetup
  #error 請用 build-setup.cmd 編（它會下載最新的 PIME 安裝檔並傳 /DPimeSetup）
#endif

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
; RunOnce 寫在 HKCU：提權的帳號就是登入的帳號時才對（一般情況）
UsedUserAreasWarning=no

[Files]
Source: "dist\zhuyin\*"; DestDir: "{app}\zhuyin"; Flags: recursesubdirs ignoreversion
Source: "install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "vendor\{#PimeSetup}"; Flags: dontcopy

[Registry]
; ponytail: 用別的管理員帳號提權時寫到那個帳號，使用者要自己到「設定」加入鍵盤
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\RunOnce"; ValueType: string; ValueName: "zhuyin-native-keyboard"; ValueData: "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\install.ps1"" -Keyboard add -WaitReady 120"; Check: FirstInstall

[Code]
var
  First: Boolean;

function Backends(): String;
begin
  Result := ExpandConstant('{commonpf32}\PIME\backends.json');
end;

{ backends.json 裡還沒有 zhuyin＝第一次安裝（install.ps1 在 ssPostInstall 才加） }
function FirstInstall(): Boolean;
begin
  Result := First;
end;

{ PIME 由 install.ps1 -PimeSetup 安裝或升級（ssPostInstall）。這裡只記下是不是第一次安裝 }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  S: AnsiString;
begin
  Result := '';
  First := not (LoadStringFromFile(Backends(), S) and (Pos('zhuyin-native.exe', String(S)) > 0));
end;

{ 解除安裝：先跑 install.ps1 -Uninstall，沒成功就中止，app 資料夾裡的 install.ps1 與檔案副本留著給下次再解除安裝。
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

{ PIME 的解除安裝程式會停掉 PIMELauncher。2.0.0-beta2 以前的 DLL 連不上啟動器時，載入它的程式（Explorer）會一直當掉，
  所以只在 beta2 以上直接執行（同 install.ps1 的 Pime-VersionOk；ponytail: 只擋已知會當的 1.x 與 2.0.0-beta） }
function PimeVersionOk(): Boolean;
var
  V: AnsiString;
begin
  Result := LoadStringFromFile(ExpandConstant('{commonpf32}\PIME\version.txt'), V);
  V := Trim(V);
  Result := Result and (V <> '2.0.0-beta') and (Copy(V, 1, 2) <> '1.');
end;

{ 移除本輸入法之後，問要不要也移除 PIME（預設「否」：PIME 上可能還有別的輸入法） }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Pime: String;
begin
  Pime := ExpandConstant('{commonpf32}\PIME\Uninstall.exe');
  if (CurUninstallStep <> usPostUninstall) or not FileExists(Pime) then exit;
  if SuppressibleMsgBox('「注音 (zhuyin-native)」已移除。' + #13#10 + #13#10 +
    '也要解除安裝 PIME（輸入法框架）嗎？' + #13#10 +
    '用 PIME 的其他輸入法（新酷音、小麥注音等）也會一起移除。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) <> IDYES then exit;
  if not PimeVersionOk() then
    MsgBox('這一版 PIME 太舊，執行中移除可能讓程式當掉。' + #13#10 +
      '請登出再登入後，到「設定 > 應用程式 > 已安裝的應用程式」解除安裝 PIME。', mbInformation, MB_OK)
  else if not Exec(Pime, '', '', SW_SHOW, ewNoWait, Code) then
    MsgBox('無法執行 PIME 的解除安裝程式。請到「設定 > 應用程式 > 已安裝的應用程式」解除安裝 PIME。', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Log: String;
begin
  if CurStep = ssPostInstall then
  begin
    Log := ExpandConstant('{app}\install.log');
    ExtractTemporaryFile('{#PimeSetup}');
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install.ps1') +
      '" -From "' + ExpandConstant('{app}\zhuyin') + '" -PimeSetup "' + ExpandConstant('{tmp}\{#PimeSetup}') + '" -Log "' + Log + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Code);
    if Code <> 0 then
      MsgBox('安裝失敗。詳細記錄：' + #13#10 + Log, mbError, MB_OK)
    else if First then
      MsgBox('完成。請登出再登入。' + #13#10 +
        '登入後約一分鐘內，「注音 (zhuyin-native)」會自動加進鍵盤清單，按 Win＋空白鍵切換。',
        mbInformation, MB_OK)
    else
      MsgBox('已更新。下次打字就是新版；少數情況要登出再登入，見記錄檔：' + #13#10 + Log, mbInformation, MB_OK);
  end;
end;
