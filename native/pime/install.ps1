# 把 zhuyin-native 裝成 PIME 的一個後端（使用說明見 docs/PIME-INSTALL.md，技術細節見 docs/MEMORY.md §6）。
#   .\install.ps1 -Stage <目錄>   只組出要放進 PIME 的 zhuyin\ 資料夾，不動系統（可先檢查內容）
#   .\install.ps1                 安裝或更新（需系統管理員）。更新前把現有的 zhuyin\ 備份成 zhuyin.prev\
#   .\install.ps1 -Rollback       用 zhuyin.prev\ 換回上一版（需系統管理員）
#   .\install.ps1 -Uninstall      移除（需系統管理員；有用過 -OnlyZhuyin 要先 -RestoreAll）
#   .\install.ps1 -OnlyZhuyin     PIME 只留「注音 (zhuyin-native)」，隱藏新酷音、小麥注音等（第一次會把 backends.json 備份成 backends.json.full）
#   .\install.ps1 -RestoreAll     用 backends.json.full 還原 PIME 全部輸入法
# 參數：-Pime PIME 安裝目錄、-Data 本專案 data\ 目錄（要有 lm.bo.bin、lexicon.bin、syllables.json）
#
# 警告：絕對不要停掉 PIMELauncher.exe（/quit 或結束行程）。PIME 2.0.0-beta 的 PIMETextService.dll 連不上啟動器時，
# 會在每個載入它的程式裡丟出沒人接的 C++ 例外（handleRpcResponse 對 null 呼叫 json::value()），Explorer 會一秒當一次。
# 所以更新時不停 PIME：執行中的 zhuyin-native.exe 與映射中的 lm.bo.bin 不能覆寫但可以改名，
# 先把舊檔改名成 *.old-<時間>，再放新檔；模型在下次載入時換新，執行檔在重新登入後換新。
param(
  [string]$Pime = 'C:\Program Files (x86)\PIME',
  [string]$Data = (Join-Path $PSScriptRoot '..\..\data'),
  [string]$Stage = '',
  [switch]$Uninstall,
  [switch]$OnlyZhuyin,
  [switch]$RestoreAll,
  [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
$name = 'zhuyin'
$dest = Join-Path $Pime $name
$prev = Join-Path $Pime "$name.prev"
$backends = Join-Path $Pime 'backends.json'
$full = "$backends.full"
$dlls = @((Join-Path $Pime 'x64\PIMETextService.dll'), (Join-Path $Pime 'x86\PIMETextService.dll'))

# 要放進 zhuyin\ 的檔案：相對路徑 → 來源
function Source-Files {
  $exe = Join-Path $PSScriptRoot '..\target\release\zhuyin-native.exe'
  if (-not (Test-Path $exe)) { throw "找不到 $exe：先在 native\ 執行 cargo build --release" }
  $files = @{
    'zhuyin-native.exe'                 = $exe
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

# 放一個檔案。目的檔被執行中的後端鎖住（執行檔、映射中的模型）時，先改名成 *.old-<時間> 再放
function Put-File([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  try {
    Copy-Item $from $to -Force
  } catch {
    Move-Item $to "$to.old-$((Get-Date).ToString('yyyyMMddHHmmss'))"
    Copy-Item $from $to
  }
}

function Put-Files([string]$dir, $files) {
  # 上次更新留下、已經沒人用的舊檔
  Get-ChildItem $dir -Recurse -Filter '*.old-*' -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force } catch { }
  }
  foreach ($k in $files.Keys) { Put-File $files[$k] (Join-Path $dir $k) }
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

if ($Stage) {
  Put-Files (Join-Path $Stage $name) (Source-Files)
  Write-Host "已組出 $(Join-Path $Stage $name)"
  exit 0
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw '要用系統管理員權限的 PowerShell 執行' }
# 不能寫成 @(… | ConvertFrom-Json)：PS 5.1 會把整個陣列當成一個元素包起來
$list = Get-Content -Raw -Encoding UTF8 $backends | ConvertFrom-Json
$list = @($list)
$installed = [bool]($list | Where-Object { $_.name -eq $name })

if ($Rollback) {
  if (-not (Test-Path $prev)) { throw "找不到 $prev，沒有上一版可以換回" }
  $files = @{}
  Get-ChildItem $prev -Recurse -File | ForEach-Object { $files[$_.FullName.Substring($prev.Length + 1)] = $_.FullName }
  Put-Files $dest $files
  Write-Host "已換回上一版（$prev）。模型在下次載入時換回；執行檔要重新登入才換回"
  exit 0
}

if ($OnlyZhuyin) {
  if (-not $installed) { throw '還沒安裝 zhuyin 後端，先執行安裝' }
  # 先在全部後端都還在時取消註冊，再縮短清單、重新註冊：只剩注音 (zhuyin-native)
  if (-not (Test-Path $full)) { Copy-Item $backends $full }
  Register-Dlls '/u'
  Write-Backends ($list | Where-Object { $_.name -eq $name })
  Register-Dlls ''
  Write-Host "PIME 只剩注音 (zhuyin-native)。完整清單在 $full，用 -RestoreAll 還原。請馬上登出再登入"
  exit 0
}

if ($RestoreAll) {
  if (-not (Test-Path $full)) { throw "找不到 $full，沒有可還原的清單" }
  Register-Dlls '/u'
  Copy-Item $full $backends -Force
  Remove-Item $full
  Register-Dlls ''
  Write-Host '已還原 PIME 全部輸入法。請馬上登出再登入'
  exit 0
}

if ($Uninstall) {
  if (Test-Path $full) { throw "目前是 -OnlyZhuyin 狀態，先執行 -RestoreAll 再移除" }
  if ($installed) {
    # 先在後端還在時取消註冊（把 PIME 的輸入法全部移掉），再改清單、重新註冊其餘輸入法
    Register-Dlls '/u'
    Write-Backends ($list | Where-Object { $_.name -ne $name })
    Register-Dlls ''
  }
  # 後端還在跑時刪不掉執行檔：登出再登入後再跑一次 -Uninstall 就會刪掉
  foreach ($d in @($dest, $prev)) {
    if (Test-Path $d) {
      try { Remove-Item -Recurse -Force $d } catch { Write-Host "$d 還在使用中：登出再登入後再執行一次 -Uninstall 刪掉它" }
    }
  }
  Write-Host '已移除。請登出再登入'
  exit 0
}

$files = Source-Files
Copy-Item $backends "$backends.bak" -Force
if (Test-Path $dest) {
  # 備份目前這版給 -Rollback 用（舊的備份沒人在用，可以直接刪）
  if (Test-Path $prev) { Remove-Item -Recurse -Force $prev }
  Copy-Item -Recurse $dest $prev
  Get-ChildItem $prev -Recurse -Filter '*.old-*' | Remove-Item -Force
}
Put-Files $dest $files
if (-not $installed) {
  $list += [pscustomobject]@{ name = $name; command = "$name\zhuyin-native.exe"; workingDir = $name; params = 'pime' }
  Write-Backends $list
  Register-Dlls ''
  Write-Host "已安裝到 $dest（backends.json 備份在 backends.json.bak）"
  Write-Host '接著：登出再登入，再到「設定 > 時間與語言 > 語言 > 中文(台灣) > 鍵盤」加入「注音 (zhuyin-native)」'
} else {
  Write-Host "已更新 $dest（上一版在 $prev，可用 -Rollback 換回）"
  Write-Host '模型在下次載入時換新（閒置卸載後或切回這個輸入法時）；執行檔要登出再登入才換新'
}
