# install.cmd／uninstall.cmd／rollback.cmd 的實作（docs/PIME-INSTALL.md）。以一般權限執行：
#   install   有 cargo 就先建置（一般權限），檢查資料檔，再只把 install.ps1 那一步用系統管理員權限跑（UAC）
#   uninstall  兩段：先以一般權限從鍵盤清單拿掉 zhuyin（install.ps1 -Keyboard remove）；拿掉了或後端還在跑就請使用者
#              登出、再跑一次，不提權。沒人在用了才提權跑 -Uninstall（改 backends.json、regsvr32、刪檔）
#   rollback   直接提權跑 install.ps1 -Rollback
#   stage     不提權：把要安裝的檔案組到 native\pime\dist\zhuyin\（做 Setup.exe 用，也可拿來試跑）
# 提權的那個視窗看不到輸出，所以 install.ps1 寫記錄檔（-Log），這裡再印出來，最後停住讓使用者看結果。
# 安全規則同 install.ps1：不停 PIMELauncher、被鎖的檔案改名不覆寫、保留 zhuyin.prev\。
param([ValidateSet('install', 'uninstall', 'rollback', 'stage')][string]$Action = 'install')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$native = Split-Path $here
$repo = Split-Path $native
# 資料目錄：repo 的 data\；ZHUYIN_DATA 可改（例如在 git 工作樹裡測試）
# 結尾的 \ 要拿掉：放進 "…\" 會把後面的引號跳脫掉
$data = if ($env:ZHUYIN_DATA) { $env:ZHUYIN_DATA.TrimEnd([char]92) } else { Join-Path $repo 'data' }
$script = Join-Path $here 'install.ps1'
$log = Join-Path $env:TEMP "zhuyin-$Action-$((Get-Date).ToString('yyyyMMddHHmmss')).log"
$title = @{ install = '安裝／更新'; uninstall = '移除'; rollback = '換回上一版'; stage = '組出安裝檔' }[$Action]

function Done([bool]$ok, [string]$msg) {
  Write-Host ''
  if ($ok) { Write-Host "✔ $msg" -ForegroundColor Green } else { Write-Host "✘ $msg" -ForegroundColor Red }
  Write-Host ''
  Read-Host '按 Enter 關閉這個視窗' | Out-Null
  exit ([int](-not $ok))
}

# 還沒做完、要使用者先登出再登入再跑一次（不是失敗）
function Later([string]$msg) {
  Write-Host ''
  Write-Host "… $msg" -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按 Enter 關閉這個視窗' | Out-Null
  exit 2
}

# 記錄檔只印 install.ps1 自己的輸出（去掉 Start-Transcript 的頭尾）
function Show-Log {
  if (-not (Test-Path $log)) { return }
  $stars = 0
  foreach ($line in Get-Content $log -Encoding UTF8) {
    if ($line -match '^\*{10,}$') { $stars++; continue }
    if ($stars -eq 2) { Write-Host "  $line" }
  }
}

Write-Host "注音 (zhuyin-native) for PIME：$title" -ForegroundColor Cyan
Write-Host ''
try {
  if ($Action -in 'install', 'stage') {
    $exe = Join-Path $native 'target\release\zhuyin-native.exe'
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
      Write-Host '1. 建置執行檔（cargo build --release）…'
      Push-Location $native
      & cargo build --release
      $code = $LASTEXITCODE
      Pop-Location
      if ($code -ne 0) { Done $false '建置失敗，見上面的訊息。什麼都沒有安裝。' }
    } elseif (Test-Path $exe) {
      Write-Host '1. 找不到 cargo，使用現有的執行檔' -ForegroundColor Yellow
    } else {
      Done $false '找不到 Rust（cargo），也沒有建好的執行檔。請先安裝 Rust：https://rustup.rs'
    }
    foreach ($f in 'models\lm.bo.bin', 'processed\lexicon.bin', 'processed\syllables.json') {
      if (-not (Test-Path (Join-Path $data $f))) { Done $false "找不到資料檔 $(Join-Path $data $f)。什麼都沒有安裝。" }
    }
  }

  if ($Action -eq 'stage') {
    $dist = Join-Path $here 'dist'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Stage $dist -Data $data -Log $log
    $code = $LASTEXITCODE
    # 不提權時子行程的輸出已經直接印在這個視窗，不用再印記錄檔
    if ($code -ne 0) { Done $false '組出安裝檔失敗。' }
    Done $true "已組到 $dist\zhuyin\（沒有動系統）"
  }

  if ($Action -eq 'uninstall') {
    Write-Host '1. 從鍵盤清單拿掉「注音 (zhuyin-native)」…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Keyboard remove
    $code = $LASTEXITCODE
    if ($code -eq 2) { Later '還沒移除完：請登出再登入，再雙擊一次 uninstall.cmd。這次只改了你的鍵盤清單。' }
    if ($code -ne 0) { Done $false '改鍵盤清單失敗，什麼都沒有移除。' }
  }

  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"", '-Log', "`"$log`"")
  switch ($Action) {
    'install' { $argList += @('-Data', "`"$data`"") }
    'uninstall' { $argList += '-Uninstall' }
    'rollback' { $argList += '-Rollback' }
  }
  Write-Host ''
  Write-Host '2. 需要系統管理員權限：Windows 會跳出「使用者帳戶控制」視窗，請按「是」。' -ForegroundColor Yellow
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Minimized -ArgumentList $argList
  } catch {
    Done $false '已取消（沒有允許系統管理員權限）。什麼都沒有改。'
  }
  Write-Host ''
  Show-Log
  if ($p.ExitCode -eq 2) { Later "還沒移除完：請登出再登入，再雙擊一次 uninstall.cmd。記錄檔：$log" }
  if ($p.ExitCode -ne 0) { Done $false "$($title)失敗。記錄檔：$log" }
  if ($Action -eq 'install') {
    # 鍵盤清單加入本專案，其他輸入法不動（一般權限、只改使用者設定；第一次安裝時 PIME 還不認得 zhuyin，會請使用者登出後再跑一次）
    Write-Host ''
    Write-Host '3. 鍵盤清單…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Keyboard add
    if ($LASTEXITCODE -ne 0) { Write-Host '  鍵盤清單沒改成，可到「設定」自己加入「注音 (zhuyin-native)」' -ForegroundColor Yellow }
  }
  $next = @{
    install   = '完成。第一次安裝：登出再登入後再雙擊一次 install.cmd（加入鍵盤）；更新時看上面的說明。'
    uninstall = '已移除。'
    rollback  = '已換回上一版。請登出再登入。'
  }[$Action]
  Done $true $next
} catch {
  Done $false "發生錯誤：$($_.Exception.Message)"
}
