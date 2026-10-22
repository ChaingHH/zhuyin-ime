# 把 zhuyin-native 裝成 PIME 的一個後端（使用說明見 docs/PIME-INSTALL.md，技術細節見 docs/MEMORY.md §6）。
#   .\install.ps1 -Stage <目錄>   只組出要放進 PIME 的 zhuyin\ 資料夾，不動系統（可先檢查內容）
#   .\install.ps1                 安裝或更新（需系統管理員）。更新前把現有的 zhuyin\ 備份成 zhuyin.prev\
#   .\install.ps1 -Rollback       用 zhuyin.prev\ 換回上一版（需系統管理員）。換之前把目前這版備份成 zhuyin.next\
#   .\install.ps1 -Uninstall      移除（需系統管理員）。zhuyin 還在任何鍵盤清單裡、或後端還在跑時什麼都不改、結束碼 2，
#                                 要先登出再登入再跑一次（見下面的警告）
#   .\install.ps1 -Keyboard only|remove   只改目前使用者的鍵盤清單（一般權限；run.ps1 用）。
#                                 only：PIME 的輸入法只留本專案，啟動器還不認得 zhuyin 時不改；
#                                 remove：拿掉本專案，拿掉了或還有人在用時結束碼 2（要登出）
#   .\install.ps1 -RestoreAll     用 backends.json.full 還原舊版 -OnlyZhuyin 拿掉的輸入法（跑完馬上登出）
# 不再提供 -OnlyZhuyin（從 backends.json 拿掉其他後端）：PIME 執行中拿掉後端，鍵盤清單裡還留著那些輸入法，
# Explorer 的 DLL 一呼叫就找不到後端，一秒當一次直到登出（2026-10-20 12:05）。只留本專案改由 -Keyboard only 調整使用者的鍵盤清單。
# 同樣的理由，-Uninstall 只在沒人用 zhuyin 時才改 backends.json、regsvr32、刪檔
#   .\install.ps1 -From <目錄>    用已經組好的 zhuyin\ 資料夾安裝（Setup.exe 用；不需要 repo 與 Rust）
#   -WaitReady <秒>              -Keyboard only 先等 PIME 啟動器讀到 zhuyin 最多這麼久（Setup.exe 寫的 RunOnce 登入時用）
#   -Log <檔案>                   把輸出寫進記錄檔（install.cmd 提權執行時用，原視窗再顯示出來）
# 一般使用者請直接雙擊同目錄的 install.cmd／uninstall.cmd／rollback.cmd（docs/PIME-INSTALL.md）
# 參數：-Pime PIME 安裝目錄、-Data 本專案 data\ 目錄（要有 lm.bo.bin、lexicon.bin、syllables.json）
# 結束碼：0 成功、1 失敗、2 要先登出再登入再跑一次（這次沒改 PIME）
#
# 警告：絕對不要停掉 PIMELauncher.exe（/quit 或結束行程）。PIME 2.0.0-beta 的 PIMETextService.dll 連不上啟動器時，
# 會在每個載入它的程式裡丟出沒人接的 C++ 例外（handleRpcResponse 對 null 呼叫 json::value()），Explorer 會一秒當一次。
# 所以更新時不停 PIME：執行中的 zhuyin-native.exe 與映射中的 lm.bo.bin 不能覆寫但可以改名，
# 先把舊檔改名成 *.old-<時間>，再放新檔；模型在下次載入時換新。執行檔：PIME v2.0.0-beta2 以上時結束舊的
# zhuyin-native（Restart-Backend，PIMELauncher 會開新版），更舊的 PIME 要重新登入才換新。
param(
  [string]$Pime = 'C:\Program Files (x86)\PIME',
  [string]$Data = (Join-Path $PSScriptRoot '..\..\data'),
  [string]$Stage = '',
  [switch]$Uninstall,
  [switch]$RestoreAll,
  [switch]$Rollback,
  [ValidateSet('only', 'remove')][string]$Keyboard = '',
  [string]$From = '',
  [int]$WaitReady = 0,
  [string]$Log = ''
)
$ErrorActionPreference = 'Stop'
if ($Log) { Start-Transcript -Path $Log -Force | Out-Null }
function Finish([int]$code = 0) {
  if ($Log) { Stop-Transcript | Out-Null }
  exit $code
}
# 任何錯誤：印出原因、結束碼 1（install.cmd 依此顯示失敗）
trap {
  Write-Host "失敗：$($_.Exception.Message)" -ForegroundColor Red
  Finish 1
}
$name = 'zhuyin'
$dest = Join-Path $Pime $name
$prev = Join-Path $Pime "$name.prev"
$next = Join-Path $Pime "$name.next"
$backends = Join-Path $Pime 'backends.json'
$full = "$backends.full"
$dlls = @((Join-Path $Pime 'x64\PIMETextService.dll'), (Join-Path $Pime 'x86\PIMETextService.dll'))
# ime.json 的 guid：TSF 的語言設定檔（鍵盤清單裡的「0404:{PIME 的 TIP}{這個}」）
$profileGuid = '{64B60746-4570-4343-A34A-85C12F03A93A}'

function Stamp { (Get-Date).ToString('yyyyMMddHHmmss') }

# 資料夾裡的檔案：相對路徑 → 完整路徑（略過更新留下的 *.old-*）
function Files-In([string]$dir) {
  $root = (Resolve-Path $dir).Path.TrimEnd([char]92)
  $files = @{}
  Get-ChildItem $root -Recurse -File | Where-Object Name -notlike '*.old-*' |
    ForEach-Object { $files[$_.FullName.Substring($root.Length + 1)] = $_.FullName }
  $files
}

# 要放進 zhuyin\ 的檔案：相對路徑 → 來源
function Source-Files {
  if ($From) {
    # 已經組好的資料夾（install.ps1 -Stage 的輸出）：裡面有什麼就裝什麼
    if (-not (Test-Path (Join-Path $From 'zhuyin-native.exe'))) { throw "$From 裡沒有 zhuyin-native.exe" }
    return Files-In $From
  }
  $exe = Join-Path $PSScriptRoot '..\target\release\zhuyin-native.exe'
  if (-not (Test-Path $exe)) { throw "找不到 $exe：先在 native\ 執行 cargo build --release" }
  $files = @{
    'zhuyin-native.exe'                 = $exe
    'THIRD-PARTY-NOTICES.txt'           = Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt'
    'LICENSE-LGPL-2.1.txt'              = Join-Path $PSScriptRoot 'LICENSE-LGPL-2.1.txt'
    'data\models\lm.bo.bin'             = Join-Path $Data 'models\lm.bo.bin'
    'data\processed\lexicon.bin'        = Join-Path $Data 'processed\lexicon.bin'
    'data\processed\syllables.json'     = Join-Path $Data 'processed\syllables.json'
    "input_methods\$name\ime.json"      = Join-Path $PSScriptRoot 'ime.json'
    "input_methods\$name\icon.ico"      = Join-Path $PSScriptRoot 'icon.ico'
    "input_methods\$name\zh.ico"        = Join-Path $PSScriptRoot 'zh.ico'
    "input_methods\$name\en.ico"        = Join-Path $PSScriptRoot 'en.ico'
  }
  foreach ($k in $files.Keys) { if (-not (Test-Path $files[$k])) { throw "找不到 $($files[$k])" } }
  $files
}

# 放一個檔案，中間不會有「沒有這個檔」的空窗：先複製成 .new，舊檔改名成 *.old-<時間>（執行中的執行檔、
# 映射中的模型不能覆寫但可以改名），再把 .new 改名過去；最後一步失敗就把舊檔改回來。內容相同就不動
function Put-File([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  if ((Test-Path $to) -and (Get-FileHash $from).Hash -eq (Get-FileHash $to).Hash) { return }
  Copy-Item $from "$to.new" -Force
  $old = $null
  if (Test-Path $to) {
    $old = "$to.old-$(Stamp)"
    Move-Item $to $old
  }
  try { Move-Item "$to.new" $to } catch { if ($old) { Move-Item $old $to }; throw }
  # 沒被鎖的舊檔馬上刪；被鎖的（執行中的舊後端）留到下次更新。
  # 用 SilentlyContinue 而不是 try/catch：記錄檔（Start-Transcript）連被接住的錯誤都會寫成 TerminatingError，看起來像安裝失敗
  if ($old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
}

function Put-Files([string]$dir, $files) {
  # 上次更新留下、已經沒人用的舊檔
  Get-ChildItem $dir -Recurse -Filter '*.old-*' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($k in $files.Keys) { Put-File $files[$k] (Join-Path $dir $k) }
}

# 整份複製（給 -Rollback 用的備份；備份沒人在用，舊的可以直接刪）
function Backup([string]$from, [string]$to) {
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  Copy-Item -Recurse $from $to
  Get-ChildItem $to -Recurse -Filter '*.old-*' | Remove-Item -Force
}

# 整個資料夾一起刪：有任何檔案被用著就整個保留，都沒有才改名再刪。
# 不直接 Remove-Item -Recurse：它會先刪掉沒鎖的模型、詞典，最後才在執行檔失敗，後端重新載入就找不到檔
function Remove-Dir([string]$d) {
  if (-not (Test-Path $d)) { return }
  $gone = "$d.del-$(Stamp)"
  try {
    # 每個檔案都要能獨占開啟：執行中的執行檔不行（資料夾改名擋不住它，實測可以改名）
    foreach ($f in Get-ChildItem $d -Recurse -File) { [IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None').Close() }
    # 改名：裡面有任何開著的檔案就失敗
    Rename-Item $d (Split-Path -Leaf $gone)
  } catch {
    Write-Host "$d 還在使用中，整個保留沒刪：登出再登入後再解除安裝一次" -ForegroundColor Yellow
    return
  }
  try { Remove-Item -Recurse -Force $gone } catch { Write-Host "$gone 沒刪乾淨，可以手動刪" -ForegroundColor Yellow }
}

# 不能寫成 @(… | ConvertFrom-Json)：PS 5.1 會把整個陣列當成一個元素包起來。
# 呼叫端要再包 @()：只有一筆時，函式的回傳值會被攤平成那一筆
function Read-Backends([string]$path) {
  $list = Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
  @($list)
}

# backends.json 用不含 BOM 的 UTF-8 寫回（PIMELauncher 用 Rust 解析）
function Write-Backends($list) {
  $json = ConvertTo-Json -InputObject @($list) -Depth 3
  [IO.File]::WriteAllText($backends, $json, (New-Object Text.UTF8Encoding $false))
}

function Register-Dlls([string]$flag) {
  foreach ($d in $dlls) {
    $p = Start-Process regsvr32.exe -ArgumentList (@('/s') + @($flag | Where-Object { $_ }) + @("`"$d`"")) -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "regsvr32 $flag $d 失敗（$($p.ExitCode)）" }
  }
}

# PIME 的 TIP（CLSID，大寫）；zhuyin 的語言設定檔沒註冊時是 $null
function Pime-Tip {
  $t = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\CTF\TIP' |
    Where-Object { Test-Path "$($_.PSPath)\LanguageProfile\0x00000404\$profileGuid" } |
    Select-Object -First 1
  if ($t) { $t.PSChildName.ToUpper() }
}

# 啟動器只在啟動時讀 backends.json：每個 PIMELauncher 都在 backends.json 最後一次修改之後才啟動，才認得 zhuyin。
# 第一次安裝後還沒登出就把 zhuyin 加進鍵盤清單，程式一切過來，啟動器找不到後端
function Launcher-Ready {
  $l = @(Get-Process PIMELauncher -ErrorAction SilentlyContinue)
  if (-not $l -or -not (Test-Path $backends)) { return $false }
  $t = (Get-Item $backends).LastWriteTime
  foreach ($p in $l) {
    try { if (-not $p.StartTime -or $p.StartTime -le $t) { return $false } } catch { return $false }
  }
  $true
}

# 照 native/src/pime.rs 的 pime_version_ok：2.0.0-beta2 以上（含正式版）的 DLL 才承受得了後端結束
function Pime-VersionOk([string]$v) {
  $base, $pre = $v -split '-', 2
  $major = 0
  [void][int]::TryParse(($base -split '\.')[0], [ref]$major)
  if ($major -lt 2 -or $base -ne '2.0.0') { return $major -ge 2 }
  if ($pre -match '^beta(\d+)$') { return [double]$Matches[1] -ge 2 }
  -not $pre
}

# 改目前使用者的鍵盤清單（等同在「設定」裡加入／移除鍵盤；不動 backends.json）。回傳有沒有改
#   only    PIME 的輸入法只留本專案（微軟注音等非 PIME 的保留，PIME 壞掉時還能打字）
#   remove  拿掉本專案
function Set-Keyboard([string]$mode) {
  $langs = Get-WinUserLanguageList
  $zh = $langs | Where-Object LanguageTag -eq 'zh-Hant-TW'
  if ($mode -eq 'remove') {
    if (-not $zh) { return $false }
    $keep = @($zh.InputMethodTips | Where-Object { $_ -notmatch [regex]::Escape($profileGuid) })
  } else {
    $tip = Pime-Tip
    if (-not $tip) {
      Write-Host '鍵盤清單沒改：Windows 裡沒有註冊「注音 (zhuyin-native)」。再執行一次 install.cmd' -ForegroundColor Yellow
      return $false
    }
    if (-not (Launcher-Ready)) {
      Write-Host '鍵盤清單沒改：PIME 還沒讀到新的設定。登出再登入後，再執行一次 install.cmd，就會自動加入「注音 (zhuyin-native)」' -ForegroundColor Yellow
      return $false
    }
    if (-not $zh) { $langs.Add('zh-Hant-TW'); $zh = $langs | Where-Object LanguageTag -eq 'zh-Hant-TW' }
    $pimeTip = "0404:$tip"
    $keep = @($zh.InputMethodTips | Where-Object { -not $_.ToUpper().StartsWith($pimeTip) }) + "$pimeTip$profileGuid"
  }
  if (($zh.InputMethodTips -join ',') -eq ($keep -join ',')) { return $false }
  $zh.InputMethodTips.Clear()
  foreach ($t in $keep) { $zh.InputMethodTips.Add($t) }
  Set-WinUserLanguageList $langs -Force
  $true
}

# 還有誰在用 zhuyin：已登入使用者的鍵盤清單（一般權限只讀得到自己的）、PIME 目錄裡的後端行程
function In-Use {
  $why = @()
  foreach ($u in Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue) {
    $up = Join-Path $u.PSPath 'Control Panel\International\User Profile'
    foreach ($lang in Get-ChildItem $up -ErrorAction SilentlyContinue) {
      if ($lang.Property -match [regex]::Escape($profileGuid)) { $why += "使用者 $($u.PSChildName) 的鍵盤清單（$($lang.PSChildName)）" }
    }
  }
  foreach ($p in Get-Process zhuyin-native -ErrorAction SilentlyContinue) {
    # 讀不到路徑（別的使用者的行程）也算
    if (-not $p.Path -or $p.Path.StartsWith($Pime, [StringComparison]::OrdinalIgnoreCase)) { $why += "後端行程（PID $($p.Id)）" }
  }
  $why
}

# 解除安裝的第一段：從目前使用者的鍵盤清單拿掉 zhuyin，再確定沒人在用。
# 剛拿掉時，執行中的程式還可能切到它，所以也要登出。回傳可不可以進第二段（改 backends.json、regsvr32、刪檔）
function Ready-ToRemove {
  $why = @()
  if (Set-Keyboard 'remove') { $why += '剛從鍵盤清單拿掉，執行中的程式還認得它' }
  $why += @(In-Use)
  if (-not $why) { return $true }
  Write-Host '「注音 (zhuyin-native)」還在使用中：' -ForegroundColor Yellow
  foreach ($w in $why) { Write-Host "  - $w" }
  Write-Host '這次沒有改 backends.json、沒有重新註冊、沒有刪檔。請登出再登入，再解除安裝一次' -ForegroundColor Yellow
  $false
}

if ($Stage) {
  Put-Files (Join-Path $Stage $name) (Source-Files)
  Write-Host "已組出 $(Join-Path $Stage $name)"
  Finish
}

if ($Keyboard -eq 'only') {
  # 登入時 RunOnce 和 PIMELauncher（HKLM Run）一起啟動，先後不定
  for ($i = 0; $i -lt $WaitReady -and -not ((Pime-Tip) -and (Launcher-Ready)); $i++) { Start-Sleep 1 }
  if (Set-Keyboard 'only') { Write-Host '鍵盤清單：PIME 的輸入法只留「注音 (zhuyin-native)」（要其他的可到「設定」加回）' }
  Finish
}
if ($Keyboard -eq 'remove') {
  if (Ready-ToRemove) { Finish } else { Finish 2 }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw '要用系統管理員權限的 PowerShell 執行' }

if ($Rollback) {
  if (-not (Test-Path $prev)) { throw "找不到 $prev，沒有上一版可以換回" }
  # 目前這版留一份：換回之後發現上一版更糟，可以手動從 zhuyin.next\ 拿回來
  if (Test-Path $dest) { Backup $dest $next }
  $files = Files-In $prev
  Put-Files $dest $files
  # 目前這版多出來、上一版沒有的檔案拿掉（被鎖的改名成 *.old-*，下次更新刪）
  foreach ($f in Get-ChildItem $dest -Recurse -File) {
    $rel = $f.FullName.Substring($dest.Length + 1)
    if ($f.Name -like '*.old-*' -or $files.ContainsKey($rel)) { continue }
    try { Remove-Item $f.FullName -Force } catch { Move-Item $f.FullName "$($f.FullName).old-$(Stamp)" }
  }
  Write-Host "已換回上一版（$prev；換之前的版本在 $next）。模型在下次載入時換回；執行檔要重新登入才換回"
  Finish
}

# 舊版 -OnlyZhuyin 留下的完整清單，只留資料夾還在的後端（已經移除的輸入法加回去，啟動器會找不到）
function Full-List {
  @(Read-Backends $full | Where-Object { -not $_.workingDir -or (Test-Path (Join-Path $Pime $_.workingDir)) })
}

if ($RestoreAll) {
  if (-not (Test-Path $full)) { throw "找不到 $full，沒有可還原的清單" }
  Register-Dlls '/u'
  Write-Backends (Full-List)
  Remove-Item $full
  Register-Dlls ''
  Write-Host '已還原 PIME 全部輸入法。請馬上登出再登入'
  Finish
}

if ($Uninstall) {
  if (-not (Ready-ToRemove)) { Finish 2 }
  if (Test-Path $backends) {
    $list = @(Read-Backends $backends)
    $installed = [bool]($list | Where-Object { $_.name -eq $name })
    # 舊版 -OnlyZhuyin 留下的狀態：用完整清單，下面重新註冊時其他輸入法就回來了
    $hidden = Test-Path $full
    if ($hidden) { $list = Full-List }
    if ($installed -or $hidden) {
      # 先在後端還在時取消註冊（把 PIME 的輸入法全部移掉），再改清單、重新註冊其餘輸入法
      Register-Dlls '/u'
      Write-Backends @($list | Where-Object { $_.name -ne $name })
      Register-Dlls ''
    }
    if ($hidden) { Remove-Item $full }
  }
  foreach ($d in @($dest, $prev, $next)) { Remove-Dir $d }
  Write-Host '已移除'
  Finish
}

# 換成新執行檔：結束執行中的舊後端，PIMELauncher 約 1 秒後用新執行檔重開。只結束 zhuyin\ 底下的 zhuyin-native，
# 絕不碰 PIMELauncher（見檔頭警告）。只在 PIME v2.0.0-beta2 以上做：舊版 DLL 遇到後端結束會讓程式當掉。
# ponytail: 停手不到 30 秒（save_delay）就安裝時，最後幾句的學習還沒寫進 adapter.json，會少記
function Restart-Backend {
  $ps = @(Get-Process zhuyin-native -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith("$dest\", [StringComparison]::OrdinalIgnoreCase) })
  if (-not $ps) { return $false }
  $ps | Stop-Process -Force -ErrorAction SilentlyContinue
  $true
}

$files = Source-Files
$oldExe = Join-Path $dest 'zhuyin-native.exe'
$exeChanged = -not ((Test-Path $oldExe) -and (Get-FileHash $oldExe).Hash -eq (Get-FileHash $files['zhuyin-native.exe']).Hash)
$list = @(Read-Backends $backends)
$installed = [bool]($list | Where-Object { $_.name -eq $name })
Copy-Item $backends "$backends.bak" -Force
if (Test-Path $dest) {
  # 備份目前這版給 -Rollback 用。重裝同一個執行檔（例如連裝兩次）不覆蓋，不然上一版會被換成這一版
  if (-not $exeChanged -and (Test-Path $prev)) { Write-Host "執行檔和目前裝的相同，保留原本的 $prev" } else { Backup $dest $prev }
}
Put-Files $dest $files
if (-not $installed) {
  $list += [pscustomobject]@{ name = $name; command = "$name\zhuyin-native.exe"; workingDir = $name; params = 'pime' }
  Write-Backends $list
}
# 上次註冊失敗（或被別的程式取消註冊）時補註冊
$registered = [bool](Pime-Tip)
if (-not $registered) { Register-Dlls '' }
if (-not $installed) {
  Write-Host "已安裝到 $dest（backends.json 備份在 backends.json.bak）"
  Write-Host '接著：登出再登入，再執行一次 install.cmd（會把「注音 (zhuyin-native)」加進鍵盤清單）'
} else {
  if (-not $registered) { Write-Host '輸入法沒有註冊在 Windows 裡，已重新註冊：請登出再登入' }
  Write-Host "已更新 $dest（上一版在 $prev，可用 -Rollback 換回）"
  Write-Host '模型在下次載入時換新（閒置卸載後或切回這個輸入法時）'
  $ver = Get-Content -Raw -ErrorAction SilentlyContinue (Join-Path $Pime 'version.txt')
  if ($ver -and (Pime-VersionOk $ver.Trim())) {
    if (-not $exeChanged) {
      Write-Host '執行檔和目前裝的相同，後端照常執行'
    } elseif (Restart-Backend) {
      Write-Host '執行檔：已結束舊的後端，PIMELauncher 約 1 秒後開新版（組字中的字會清掉；停手不到 30 秒的話最後幾句的學習會少記）'
    } else {
      Write-Host '執行檔：後端沒在執行，下次打字就是新版'
    }
  } else {
    Write-Host '執行檔要登出再登入才換新（PIME 升到 2.0.0-beta2 以上就不用）'
  }
}
Finish
