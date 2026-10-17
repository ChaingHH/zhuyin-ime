# 把 zhuyin-native 裝成 PIME 的一個後端（步驟說明見 docs/MEMORY.md §6「安裝本專案的後端」）。
#   .\install.ps1 -Stage <目錄>   只組出要放進 PIME 的 zhuyin\ 資料夾，不動系統（可先檢查內容）
#   .\install.ps1                 安裝：複製到 PIME 目錄、在 backends.json 加後端、重新註冊 TSF DLL（需系統管理員）
#   .\install.ps1 -Uninstall      移除（需系統管理員；有用過 -OnlyZhuyin 要先 -RestoreAll）
#   .\install.ps1 -OnlyZhuyin     PIME 只留「注音 (zhuyin-native)」，隱藏新酷音、小麥注音等（第一次會把 backends.json 備份成 backends.json.full）
#   .\install.ps1 -RestoreAll     用 backends.json.full 還原 PIME 全部輸入法
# 安裝、更新、移除都會先用 PIMELauncher.exe /quit 停掉 PIME（執行中的後端鎖著執行檔與映射的模型），之後要重新登入或重開 PIMELauncher.exe
# 參數：-Pime PIME 安裝目錄、-Data 本專案 data\ 目錄（要有 lm.bo.bin、lexicon.bin、syllables.json）
param(
  [string]$Pime = 'C:\Program Files (x86)\PIME',
  [string]$Data = (Join-Path $PSScriptRoot '..\..\data'),
  [string]$Stage = '',
  [switch]$Uninstall,
  [switch]$OnlyZhuyin,
  [switch]$RestoreAll
)
$ErrorActionPreference = 'Stop'
$name = 'zhuyin'
$dest = Join-Path $Pime $name
$backends = Join-Path $Pime 'backends.json'
$full = "$backends.full"
$dlls = @((Join-Path $Pime 'x64\PIMETextService.dll'), (Join-Path $Pime 'x86\PIMETextService.dll'))

function Build-Folder([string]$dir) {
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
  foreach ($k in $files.Keys) {
    if (-not (Test-Path $files[$k])) { throw "找不到 $($files[$k])" }
    $to = Join-Path $dir $k
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item $files[$k] $to -Force
  }
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

# 停掉 PIME：後端行程鎖著 zhuyin-native.exe 和映射中的 lm.bo.bin；只殺後端的話啟動器 1 秒後會重開它
function Stop-Pime {
  $launcher = Join-Path $Pime 'PIMELauncher.exe'
  if (Get-Process PIMELauncher -ErrorAction SilentlyContinue) { & $launcher /quit | Out-Null }
  for ($i = 0; $i -lt 50 -and (Get-Process PIMELauncher, zhuyin-native -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
  # /quit 沒收到（例如不同工作階段）時才硬停
  Get-Process PIMELauncher, zhuyin-native -ErrorAction SilentlyContinue | Stop-Process -Force
}

if ($Stage) {
  Build-Folder (Join-Path $Stage $name)
  Write-Host "已組出 $(Join-Path $Stage $name)"
  exit 0
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw '要用系統管理員權限的 PowerShell 執行' }
# 不能寫成 @(… | ConvertFrom-Json)：PS 5.1 會把整個陣列當成一個元素包起來
$list = Get-Content -Raw -Encoding UTF8 $backends | ConvertFrom-Json
$list = @($list)

if ($OnlyZhuyin) {
  if (-not ($list | Where-Object { $_.name -eq $name })) { throw '還沒安裝 zhuyin 後端，先執行安裝' }
  # 先在全部後端都還在時取消註冊，再縮短清單、重新註冊：只剩注音 (zhuyin-native)
  if (-not (Test-Path $full)) { Copy-Item $backends $full }
  Stop-Pime
  Register-Dlls '/u'
  Write-Backends ($list | Where-Object { $_.name -eq $name })
  Register-Dlls ''
  Write-Host "PIME 只剩注音 (zhuyin-native)。完整清單在 $full，用 -RestoreAll 還原。重新登入後生效"
  exit 0
}

if ($RestoreAll) {
  if (-not (Test-Path $full)) { throw "找不到 $full，沒有可還原的清單" }
  Stop-Pime
  Register-Dlls '/u'
  Copy-Item $full $backends -Force
  Remove-Item $full
  Register-Dlls ''
  Write-Host '已還原 PIME 全部輸入法。重新登入後生效'
  exit 0
}

if ($Uninstall) {
  if (Test-Path $full) { throw "目前是 -OnlyZhuyin 狀態，先執行 -RestoreAll 再移除" }
  Stop-Pime
  # 先在後端還在時取消註冊（把 PIME 的輸入法全部移掉），再刪檔、重新註冊其餘輸入法
  Register-Dlls '/u'
  Write-Backends ($list | Where-Object { $_.name -ne $name })
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Register-Dlls ''
  Write-Host '已移除。重新登入（或重開 PIMELauncher.exe）後生效'
  exit 0
}

Copy-Item $backends "$backends.bak" -Force
Stop-Pime
Build-Folder $dest
if (-not ($list | Where-Object { $_.name -eq $name })) {
  $list += [pscustomobject]@{ name = $name; command = "$name\zhuyin-native.exe"; workingDir = $name; params = 'pime' }
  Write-Backends $list
}
Register-Dlls ''
Write-Host "已安裝到 $dest（backends.json 備份在 backends.json.bak）"
Write-Host '接著：重新登入（或結束再以一般權限啟動 PIMELauncher.exe），再到「設定 > 時間與語言 > 語言 > 中文(台灣) > 鍵盤」加入「注音 (zhuyin-native)」'
